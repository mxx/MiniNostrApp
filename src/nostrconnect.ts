/**
 * NIP-46 远程签名（Nostr Connect / bunker://）客户端。
 *
 * 解决移动端浏览器无法安装 NIP-07 扩展插件的问题：用户在签名器 App
 *（如 nsec.app）里生成 `bunker://<签名器公钥>?relay=...&secret=...` 连接串，
 * 粘贴到本客户端后，发帖/回复/关注等签名请求经 NIP-44 加密通道发给远端签名器，
 * 私钥始终不出签名器。
 *
 * 只实现"签名器发起"（bunker://）流程：
 *   1. 解析连接串得到签名器公钥 / relay / secret；
 *   2. 本地生成一次性 client keypair（只用于本通道加密，不代表用户身份）；
 *   3. 连上 relay，订阅发给自己的 kind:24133；
 *   4. 发送 `connect` → `get_public_key` 握手；
 *   5. 后续 `sign_event` 走同一通道。
 */

import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from "nostr-tools";

export const NIP46_KIND = 24133;

/** 远端签名器连接串解析结果。 */
export type BunkerUri = {
  /** 签名器的公钥（hex，64 字符）。 */
  remotePubkey: string;
  /** 连接串里列出的 relay，至少一个。 */
  relays: string[];
  /** 可选的单次 secret，connect 时原样交回。 */
  secret: string | null;
};

/** 可持久化到 localStorage 的 NIP-46 会话。 */
export type Nip46Session = {
  /** client keypair 私钥 hex（只用于通道加密）。 */
  clientSecretHex: string;
  remotePubkey: string;
  relayUrl: string;
  /** 握手成功后记下的用户公钥，重进时直接恢复身份。 */
  userPubkey: string | null;
};

export type UnsignedEventDraft = {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
};

export type SignedNostrEvent = UnsignedEventDraft & {
  id: string;
  pubkey: string;
  sig: string;
};

const HEX64 = /^[0-9a-f]{64}$/;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex 长度不正确");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("hex 内容不正确");
    out[i] = byte;
  }
  return out;
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

/**
 * 解析 `bunker://<签名器公钥>?relay=<wss://...>&secret=<可选>`。
 * 部分签名器用 `nostrconnect://` 承载同样的签名器发起流程，一并接受。
 */
export function parseBunkerUri(uri: string): BunkerUri {
  const trimmed = uri.trim();
  const match = /^(bunker|nostrconnect):\/\/([^?#/]+)(?:\?(.*))?$/.exec(trimmed);
  if (!match || !match[2]) throw new Error("不是有效的连接串，应为 bunker:// 开头");
  const remotePubkey = match[2].toLowerCase();
  if (!HEX64.test(remotePubkey)) throw new Error("连接串中的签名器公钥格式不正确");
  const params = new URLSearchParams(match[3] ?? "");
  const relays = params
    .getAll("relay")
    .map((value) => value.trim())
    .filter((value) => /^wss?:\/\//i.test(value));
  if (relays.length === 0) throw new Error("连接串中没有可用的 relay 地址");
  return { remotePubkey, relays, secret: params.get("secret") };
}

/** 签名器要求用户去另一个页面完成验证时抛出，App 层据此展示 authUrl。 */
export class Nip46AuthRequiredError extends Error {
  readonly authUrl: string;
  constructor(authUrl: string) {
    super("签名器要求额外验证");
    this.name = "Nip46AuthRequiredError";
    this.authUrl = authUrl;
  }
}

type PendingRpc = {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: number;
};

/**
 * NIP-46 客户端：维护一条到签名器 relay 的 WebSocket，
 * 用 kind:24133 + NIP-44 做 JSON-RPC。
 */
export class NostrConnectClient {
  readonly clientPubkey: string;
  readonly remotePubkey: string;
  readonly relayUrl: string;
  private readonly clientSecret: Uint8Array;
  private readonly conversationKey: Uint8Array;
  private socket: WebSocket | null = null;
  private readonly subId = `nip46-${randomHex(8)}`;
  private readonly pending = new Map<string, PendingRpc>();
  private authed = false;

  constructor(session: Omit<Nip46Session, "userPubkey">) {
    this.clientSecret = hexToBytes(session.clientSecretHex);
    if (this.clientSecret.length !== 32) throw new Error("会话中的 client 密钥不正确");
    this.clientPubkey = getPublicKey(this.clientSecret);
    this.remotePubkey = session.remotePubkey.toLowerCase();
    if (!HEX64.test(this.remotePubkey)) throw new Error("签名器公钥格式不正确");
    this.relayUrl = session.relayUrl;
    this.conversationKey = nip44.v2.utils.getConversationKey(this.clientSecret, this.remotePubkey);
  }

  /** 为一次新的配对生成会话（含全新的 client keypair）。 */
  static newSession(remotePubkey: string, relayUrl: string): Nip46Session {
    const secret = generateSecretKey();
    return { clientSecretHex: bytesToHex(secret), remotePubkey, relayUrl, userPubkey: null };
  }

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /** 打开 WebSocket 并订阅发给自己的 kind:24133；不做应用层握手。 */
  connect(timeoutMs = 15000): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        fn();
      };
      const ws = new WebSocket(this.relayUrl);
      const timer = window.setTimeout(() => {
        done(() => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(new Error("连接签名器 relay 超时"));
        });
      }, timeoutMs);
      ws.onopen = () => {
        done(() => {
          this.socket = ws;
          ws.send(JSON.stringify(["REQ", this.subId, { kinds: [NIP46_KIND], "#p": [this.clientPubkey] }]));
          resolve();
        });
      };
      ws.onerror = () => {
        done(() => reject(new Error("无法连接到签名器 relay")));
      };
      ws.onmessage = (event) => this.handleMessage(event);
      ws.onclose = () => {
        if (this.socket === ws) this.socket = null;
        this.authed = false;
        this.failAllPending(new Error("与签名器的连接已断开"));
      };
    });
  }

  private failAllPending(error: Error): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      window.clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  private handleMessage(event: MessageEvent): void {
    let msg: unknown;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!Array.isArray(msg) || msg[0] !== "EVENT" || msg[1] !== this.subId) return;
    const envelope = msg[2] as { kind?: unknown; pubkey?: unknown; content?: unknown } | null;
    if (
      !envelope ||
      envelope.kind !== NIP46_KIND ||
      envelope.pubkey !== this.remotePubkey ||
      typeof envelope.content !== "string"
    ) {
      return;
    }
    let plain: string;
    try {
      plain = nip44.v2.decrypt(envelope.content, this.conversationKey);
    } catch {
      return;
    }
    let response: { id?: unknown; result?: unknown; error?: unknown };
    try {
      response = JSON.parse(plain) as { id?: unknown; result?: unknown; error?: unknown };
    } catch {
      return;
    }
    if (typeof response.id !== "string") return;
    const entry = this.pending.get(response.id);
    if (!entry) return;
    this.pending.delete(response.id);
    window.clearTimeout(entry.timer);
    if (response.result === "auth_url" && typeof response.error === "string") {
      entry.reject(new Nip46AuthRequiredError(response.error));
      return;
    }
    if (typeof response.error === "string" && response.error.length > 0) {
      entry.reject(new Error(response.error));
      return;
    }
    entry.resolve(typeof response.result === "string" ? response.result : JSON.stringify(response.result ?? ""));
  }

  /** 发送一次 JSON-RPC 并等待同 id 的响应。 */
  rpc(method: string, params: string[], timeoutMs = 60000): Promise<string> {
    if (!this.connected || !this.socket) return Promise.reject(new Error("签名器未连接"));
    const id = randomHex(8);
    let content: string;
    try {
      content = nip44.v2.encrypt(JSON.stringify({ id, method, params }), this.conversationKey);
    } catch {
      return Promise.reject(new Error("请求加密失败"));
    }
    const signed = finalizeEvent(
      {
        kind: NIP46_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", this.remotePubkey]],
        content,
      },
      this.clientSecret,
    );
    return new Promise<string>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`签名器请求超时（${method}）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket?.send(JSON.stringify(["EVENT", signed]));
      } catch (error) {
        this.pending.delete(id);
        window.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** 完成应用层握手（幂等）：connect → 标记 authed。 */
  async ensureAuthed(secret: string | null): Promise<void> {
    if (this.authed) return;
    const params = secret ? [this.remotePubkey, secret] : [this.remotePubkey];
    const result = await this.rpc("connect", params);
    if (result !== "ack") throw new Error("签名器拒绝了连接请求");
    this.authed = true;
  }

  /** 握手后向签名器索取用户公钥。 */
  async getPublicKey(secret: string | null): Promise<string> {
    await this.ensureAuthed(secret);
    const result = await this.rpc("get_public_key", []);
    if (!HEX64.test(result.toLowerCase())) throw new Error("签名器返回的公钥格式不正确");
    return result.toLowerCase();
  }

  /** 请签名器签署一个事件（kind-1 发帖 / kind-3 关注等）。 */
  async signEvent(draft: UnsignedEventDraft, secret: string | null): Promise<SignedNostrEvent> {
    await this.ensureAuthed(secret);
    const result = await this.rpc("sign_event", [JSON.stringify(draft)], 120000);
    let signed: unknown;
    try {
      signed = JSON.parse(result);
    } catch {
      throw new Error("签名器返回的结果无法解析");
    }
    if (!isSignedNostrEvent(signed)) throw new Error("签名器返回的事件格式不正确");
    return signed;
  }

  close(): void {
    this.failAllPending(new Error("已断开与签名器的连接"));
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.authed = false;
  }
}

function isSignedNostrEvent(value: unknown): value is SignedNostrEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === "string" &&
    typeof event.pubkey === "string" &&
    typeof event.created_at === "number" &&
    typeof event.kind === "number" &&
    Array.isArray(event.tags) &&
    typeof event.content === "string" &&
    typeof event.sig === "string"
  );
}
