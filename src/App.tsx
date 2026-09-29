import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import {
useCallback,
useEffect,
useMemo,
useRef,
useState,
type FormEvent,
type ReactNode,
} from "react";

type RelayState = "connecting" | "online" | "offline";

type RelayConfig = {
  url: string;
  enabled: boolean;
};

type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
  relays: string[];
};

type SignedEvent = Omit<NostrEvent, "relays">;

type PublishStatus = {
  eventId: string;
  total: number;
  accepted: number;
  rejected: number;
  pending: number;
};

const DEFAULT_RELAYS: RelayConfig[] = [
  { url: "ws://lulin.org", enabled: true },
  { url: "wss://relay.gulugulu.moe", enabled: true },
  { url: "wss://relay.nostr.wirednet.jp", enabled: true },
  { url: "wss://relay-jp.nostr.wirednet.jp", enabled: true },
];

const RELAY_STORAGE_KEY = "nostr-min-relays-v1";
const MAX_EVENTS = 120;

function createUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function loadRelays(): RelayConfig[] {
  try {
    const raw = localStorage.getItem(RELAY_STORAGE_KEY);
    if (!raw) return DEFAULT_RELAYS;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_RELAYS;
    const valid = parsed.filter(
      (entry): entry is RelayConfig =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as RelayConfig).url === "string" &&
        typeof (entry as RelayConfig).enabled === "boolean",
    );
    if (valid.length === 0) return DEFAULT_RELAYS;

    // Carry the new community relay into existing installations without
    // resetting any relay choices the viewer has already saved.
    if (!valid.some((relay) => relay.url === "ws://lulin.org")) {
      return [{ url: "ws://lulin.org", enabled: true }, ...valid];
    }
    return valid;
  } catch {
    return DEFAULT_RELAYS;
  }
}

function normalizeRelay(value: string): string | null {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") return null;
    if (!parsed.hostname) return null;
    parsed.hash = "";
    parsed.search = "";
    const normalized = parsed.toString();
    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  } catch {
    return null;
  }
}

function shortKey(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values: number[]): number {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    generators.forEach((generator, index) => {
      if (((top >>> index) & 1) === 1) checksum ^= generator;
    });
  }
  return checksum;
}

function encodeNip19(prefix: "npub" | "note", hex: string): string {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return hex;
  const bytes = Array.from({ length: 32 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
  const words: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((accumulator >>> bits) & 31);
    }
  }
  if (bits > 0) words.push((accumulator << (5 - bits)) & 31);
  const expanded = [...prefix].flatMap((character) => [character.charCodeAt(0) >>> 5]);
  expanded.push(0);
  expanded.push(...[...prefix].map((character) => character.charCodeAt(0) & 31));
  const polymod = bech32Polymod([...expanded, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, index) => (polymod >>> (5 * (5 - index))) & 31);
  return `${prefix}1${[...words, ...checksum].map((value) => BECH32_CHARSET[value] ?? "q").join("")}`;
}

function relativeTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const delta = Date.now() - date.getTime();
  if (!Number.isFinite(delta) || Math.abs(delta) > 7 * 24 * 60 * 60 * 1000) {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }
  const future = delta < 0;
  const seconds = Math.floor(Math.abs(delta) / 1000);
  const value = seconds < 60 ? seconds : seconds < 3600 ? Math.floor(seconds / 60) : seconds < 86400 ? Math.floor(seconds / 3600) : Math.floor(seconds / 86400);
  const unit = seconds < 60 ? "秒" : seconds < 3600 ? "分钟" : seconds < 86400 ? "小时" : "天";
  return future ? `${value} ${unit}后` : `${value} ${unit}前`;
}

function relayLabel(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function relayProtocol(url: string): "WS" | "WSS" {
  return url.startsWith("ws://") ? "WS" : "WSS";
}

const INLINE_TOKEN = /(https?:\/\/[^\s<]+|(?:nostr:)?(?:npub|note|nevent|nprofile|naddr)1[0-9a-z]+|#[\p{L}\p{N}_]+)/giu;
const TRAILING_PUNCTUATION = /[.,!?，。！？;；:：)）\]}]+$/;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(INLINE_TOKEN).filter(Boolean).flatMap((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (/^https?:\/\//i.test(part)) {
      const trailing = part.match(TRAILING_PUNCTUATION)?.[0] ?? "";
      const href = trailing ? part.slice(0, -trailing.length) : part;
      let label = href;
      try {
        const parsed = new URL(href);
        label = `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
      } catch {
        // Keep the original text if a relay supplied a malformed URL.
      }
      const link = <a className="note-link" href={href} target="_blank" rel="noreferrer" key={`${key}-link`}>{label}</a>;
      return trailing ? [link, <span key={`${key}-tail`}>{trailing}</span>] : [link];
    }
    if (/^(?:nostr:)?(?:npub|note|nevent|nprofile|naddr)1/i.test(part)) {
      return <span className="nostr-token" title={part} key={key}>{shortKey(part.replace(/^nostr:/i, ""))}</span>;
    }
    if (part.startsWith("#")) return <span className="hashtag" key={key}>{part}</span>;
    return part;
  });
}

function FormattedNote({ content }: { content: string }) {
  if (!content) return <span className="muted">（空文本）</span>;
  const blocks = content.replace(/\r\n?/g, "\n").trim().split(/\n{2,}/);
  return (
    <div className="note-prose">
      {blocks.map((block, blockIndex) => {
        const lines = block.split("\n");
        const bulletLines = lines.every((line) => /^\s*[-*•]\s+/.test(line));
        const quoteLines = lines.every((line) => /^\s*>\s?/.test(line));
        if (bulletLines) {
          return <ul key={`block-${blockIndex}`}>{lines.map((line, lineIndex) => <li key={`line-${lineIndex}`}>{renderInline(line.replace(/^\s*[-*•]\s+/, ""), `b${blockIndex}l${lineIndex}`)}</li>)}</ul>;
        }
        if (quoteLines) {
          return <blockquote key={`block-${blockIndex}`}>{lines.map((line, lineIndex) => <span key={`line-${lineIndex}`}>{renderInline(line.replace(/^\s*>\s?/, ""), `q${blockIndex}l${lineIndex}`)}{lineIndex < lines.length - 1 && <br />}</span>)}</blockquote>;
        }
        return <p key={`block-${blockIndex}`}>{lines.map((line, lineIndex) => <span key={`line-${lineIndex}`}>{renderInline(line, `p${blockIndex}l${lineIndex}`)}{lineIndex < lines.length - 1 && <br />}</span>)}</p>;
      })}
    </div>
  );
}

function isNostrEvent(value: unknown): value is SignedEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Partial<SignedEvent>;
  return (
    typeof event.id === "string" &&
    typeof event.pubkey === "string" &&
    typeof event.created_at === "number" &&
    event.kind === 1 &&
    typeof event.content === "string" &&
    typeof event.sig === "string" &&
    Array.isArray(event.tags)
  );
}

function Icon({ name }: { name: "relay" | "refresh" | "edit" | "key" | "close" | "plus" | "trash" }) {
  const common = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (name === "relay") return <svg {...common}><circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="12" r="7.5"/><path d="M4.7 4.7 7 7M17 17l2.3 2.3M19.3 4.7 17 7M7 17l-2.3 2.3"/></svg>;
  if (name === "refresh") return <svg {...common}><path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M18.2 9A7 7 0 0 0 6.4 6.4L4 11M20 13l-2.4 4.6A7 7 0 0 1 5.8 15"/></svg>;
  if (name === "edit") return <svg {...common}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>;
  if (name === "key") return <svg {...common}><circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M15 8l2 2M17 6l2 2"/></svg>;
  if (name === "close") return <svg {...common}><path d="m6 6 12 12M18 6 6 18"/></svg>;
  if (name === "plus") return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>;
  return <svg {...common}><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>;
}

export function App() {
  const [relays, setRelays] = useState<RelayConfig[]>(loadRelays);
  const [relayStates, setRelayStates] = useState<Record<string, RelayState>>({});
  const [events, setEvents] = useState<NostrEvent[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [newRelay, setNewRelay] = useState("");
  const [relayError, setRelayError] = useState("");
  const [draft, setDraft] = useState("");
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [signerError, setSignerError] = useState("");
  const [publishStatus, setPublishStatus] = useState<PublishStatus | null>(null);
  const [networkMessage, setNetworkMessage] = useState("");
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [detailEventId, setDetailEventId] = useState<string | null>(null);
  const [profilePubkey, setProfilePubkey] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState("");
  const socketsRef = useRef<Map<string, WebSocket>>(new Map());
  const publishAcksRef = useRef<Map<string, Set<string>>>(new Map());

  const enabledRelays = useMemo(() => relays.filter((relay) => relay.enabled), [relays]);
  const onlineCount = enabledRelays.filter((relay) => relayStates[relay.url] === "online").length;
  const detailEvent = detailEventId ? events.find((event) => event.id === detailEventId) ?? null : null;
  const profileEvents = profilePubkey ? events.filter((event) => event.pubkey === profilePubkey) : [];

  function openNote(eventId: string) {
    setProfilePubkey(null);
    setDetailEventId(eventId);
    setCopyMessage("");
  }

  function openProfile(key: string) {
    setDetailEventId(null);
    setProfilePubkey(key);
    setCopyMessage("");
  }

  async function copyValue(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyMessage(`${label}已复制`);
    } catch {
      setCopyMessage("复制失败，请长按文字手动复制。");
    }
  }

  useEffect(() => {
    localStorage.setItem(RELAY_STORAGE_KEY, JSON.stringify(relays));
  }, [relays]);

  const addIncomingEvent = useCallback((incoming: SignedEvent, relayUrl: string) => {
    setEvents((current) => {
      const existing = current.find((event) => event.id === incoming.id);
      if (existing) {
        if (existing.relays.includes(relayUrl)) return current;
        return current.map((event) => event.id === incoming.id ? { ...event, relays: [...event.relays, relayUrl] } : event);
      }
      return [{ ...incoming, relays: [relayUrl] }, ...current]
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, MAX_EVENTS);
    });
  }, []);

  useEffect(() => {
    const active = relays.filter((relay) => relay.enabled);
    const timeout = window.setTimeout(() => {
      for (const socket of socketsRef.current.values()) socket.close();
      socketsRef.current.clear();

      const nextStates: Record<string, RelayState> = {};
      for (const relay of relays) nextStates[relay.url] = relay.enabled ? "connecting" : "offline";
      setRelayStates(nextStates);
      setNetworkMessage(active.length === 0 ? "请至少启用一个中继。" : "");

      for (const relay of active) {
        const subId = `feed-${createUuid().slice(0, 8)}`;
        try {
          const socket = new WebSocket(relay.url);
          socketsRef.current.set(relay.url, socket);
          socket.onopen = () => {
            setRelayStates((current) => ({ ...current, [relay.url]: "online" }));
            socket.send(JSON.stringify(["REQ", subId, { kinds: [1], limit: 60 }]));
          };
          socket.onmessage = (message) => {
            try {
              const frame: unknown = JSON.parse(String(message.data));
              if (!Array.isArray(frame)) return;
              if (frame[0] === "EVENT" && frame[1] === subId && isNostrEvent(frame[2])) {
                addIncomingEvent(frame[2], relay.url);
              }
              if (frame[0] === "OK" && typeof frame[1] === "string" && typeof frame[2] === "boolean") {
                const eventId = frame[1];
                const seen = publishAcksRef.current.get(eventId) ?? new Set<string>();
                if (seen.has(relay.url)) return;
                seen.add(relay.url);
                publishAcksRef.current.set(eventId, seen);
                setPublishStatus((current) => current?.eventId === eventId ? {
                  ...current,
                  accepted: current.accepted + (frame[2] ? 1 : 0),
                  rejected: current.rejected + (frame[2] ? 0 : 1),
                  pending: Math.max(0, current.pending - 1),
                } : current);
              }
            } catch {
              // Ignore malformed relay frames without interrupting the feed.
            }
          };
          socket.onerror = () => setRelayStates((current) => ({ ...current, [relay.url]: "offline" }));
          socket.onclose = () => setRelayStates((current) => ({ ...current, [relay.url]: "offline" }));
        } catch {
          setRelayStates((current) => ({ ...current, [relay.url]: "offline" }));
        }
      }
    }, 500);

    return () => {
      window.clearTimeout(timeout);
      for (const socket of socketsRef.current.values()) socket.close();
      socketsRef.current.clear();
    };
  }, [relays, connectionEpoch, addIncomingEvent]);

  async function connectSigner(): Promise<string | null> {
    setSignerError("");
    if (!window.nostr) {
      setSignerError("未检测到 NIP-07 签名器。请在支持浏览器扩展的环境中安装并启用签名器后重试。");
      return null;
    }
    try {
      const key = await window.nostr.getPublicKey();
      setPubkey(key);
      return key;
    } catch {
      setSignerError("签名器未授权连接。你仍可匿名浏览帖子。");
      return null;
    }
  }

  async function publish(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content) return;
    setSignerError("");
    const currentPubkey = pubkey ?? await connectSigner();
    if (!currentPubkey || !window.nostr) return;
    const liveSockets = [...socketsRef.current.entries()].filter(([, socket]) => socket.readyState === WebSocket.OPEN);
    if (liveSockets.length === 0) {
      setNetworkMessage("当前没有在线中继，无法发布。请检查中继面板后重试。");
      return;
    }
    try {
      const signed = await window.nostr.signEvent({
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content,
      });
      if (!isNostrEvent(signed)) throw new Error("invalid signed event");
      publishAcksRef.current.set(signed.id, new Set());
      setPublishStatus({ eventId: signed.id, total: liveSockets.length, accepted: 0, rejected: 0, pending: liveSockets.length });
      setEvents((current) => [{ ...signed, relays: ["本地发布"] }, ...current.filter((item) => item.id !== signed.id)].slice(0, MAX_EVENTS));
      for (const [, socket] of liveSockets) socket.send(JSON.stringify(["EVENT", signed]));
      setDraft("");
      setComposerOpen(false);
    } catch {
      setSignerError("签名未完成，帖子没有发送。");
    }
  }

  function addRelay(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeRelay(newRelay);
    if (!normalized) {
      setRelayError("请输入有效的 wss:// 或 ws:// 中继地址。");
      return;
    }
    if (relays.some((relay) => relay.url === normalized)) {
      setRelayError("这个中继已经在列表中。");
      return;
    }
    setRelays((current) => [...current, { url: normalized, enabled: true }]);
    setNewRelay("");
    setRelayError("");
  }

  return (
    <div className="app-shell">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />

      <header className="utility-bar">
        <button className="relay-summary" onClick={() => setPanelOpen(true)} aria-label="打开中继管理">
          <span className={`signal ${onlineCount > 0 ? "signal-live" : ""}`} />
          <span>{onlineCount}/{enabledRelays.length} 中继在线</span>
        </button>
        <div className="utility-actions">
          <button className="icon-button" onClick={() => setConnectionEpoch((value) => value + 1)} aria-label="重新连接中继"><Icon name="refresh" /></button>
          <button className="identity-button" onClick={() => void connectSigner()} aria-label={pubkey ? "查看已连接身份" : "连接 NIP-07 签名器"}>
            <Icon name="key" />
            <span>{pubkey ? shortKey(pubkey) : "连接签名器"}</span>
          </button>
        </div>
      </header>

      <main className="feed-column">
        <section className="feed-intro" aria-labelledby="feed-heading">
          <div>
            <p className="section-index">PUBLIC NOTES / KIND 1</p>
            <h1 id="feed-heading">最新帖子</h1>
          </div>
          <button className="compose-button desktop-compose" onClick={() => setComposerOpen(true)}><Icon name="edit" />发帖子</button>
        </section>

        {networkMessage && <div className="inline-notice" role="status">{networkMessage}</div>}
        {signerError && <div className="inline-notice warning" role="status">{signerError}</div>}
        {publishStatus && (
          <div className="publish-strip" role="status">
            <span>发布结果</span>
            <strong>{publishStatus.accepted} 接收</strong>
            {publishStatus.rejected > 0 && <span>{publishStatus.rejected} 拒绝</span>}
            {publishStatus.pending > 0 && <span>{publishStatus.pending} 等待确认</span>}
          </div>
        )}

        {events.length === 0 ? (
          <section className="empty-state">
            <div className="empty-signal"><span /><span /><span /></div>
            <h2>{onlineCount > 0 ? "正在等待帖子" : "还没有连上中继"}</h2>
            <p>{onlineCount > 0 ? "连接已建立，新帖子会直接出现在这里。" : "打开中继面板查看每个地址的状态，或添加一个可用中继。"}</p>
            <button onClick={() => onlineCount > 0 ? setConnectionEpoch((value) => value + 1) : setPanelOpen(true)}>
              {onlineCount > 0 ? "重新订阅" : "管理中继"}
            </button>
          </section>
        ) : (
          <ol className="feed-list" aria-live="polite">
            {events.map((item) => (
              <li className="note" key={item.id}>
                <div className="note-meta">
                  <button className="avatar-mark" onClick={() => openProfile(item.pubkey)} aria-label={`查看作者 ${shortKey(item.pubkey)}`}>{item.pubkey.slice(0, 2).toUpperCase()}</button>
                  <button className="author" onClick={() => openProfile(item.pubkey)} title={item.pubkey}>{shortKey(encodeNip19("npub", item.pubkey))}</button>
                  <time dateTime={new Date(item.created_at * 1000).toISOString()}>{relativeTime(item.created_at)}</time>
                </div>
                <button className="note-open" onClick={() => openNote(item.id)} aria-label={`查看帖子 ${shortKey(encodeNip19("note", item.id))}`}>
                  <div className="note-content"><FormattedNote content={item.content} /></div>
                  <div className="note-footer">
                    <span className="note-relays" title={item.relays.join("\n")}><span className="tiny-signal" />{item.relays.length === 1 ? relayLabel(item.relays[0] ?? "") : `${item.relays.length} 个中继`}</span>
                    <span className="view-detail">查看详情 →</span>
                  </div>
                </button>
              </li>
            ))}
          </ol>
        )}
      </main>

      <button className="compose-fab" onClick={() => setComposerOpen(true)} aria-label="发帖子"><Icon name="edit" /></button>

      {panelOpen && (
        <div className="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPanelOpen(false); }}>
          <aside className="relay-sheet" aria-label="中继管理" role="dialog" aria-modal="true">
            <div className="sheet-heading">
              <div><p className="section-index">RELAY POOL</p><h2>中继管理</h2></div>
              <button className="icon-button" onClick={() => setPanelOpen(false)} aria-label="关闭中继管理"><Icon name="close" /></button>
            </div>
            <p className="sheet-copy">支持加密的 wss:// 与不加密的 ws:// 中继；修改后会自动重连。</p>
            <ul className="relay-list">
              {relays.map((relay) => (
                <li key={relay.url} className="relay-row">
                  <button
                    className={`relay-toggle ${relay.enabled ? "enabled" : ""}`}
                    onClick={() => setRelays((current) => current.map((item) => item.url === relay.url ? { ...item, enabled: !item.enabled } : item))}
                    role="switch"
                    aria-checked={relay.enabled}
                    aria-label={`${relay.enabled ? "停用" : "启用"} ${relay.url}`}
                  ><span /></button>
                  <div className="relay-address"><strong>{relayLabel(relay.url)} <span className={`protocol-badge ${relayProtocol(relay.url) === "WS" ? "insecure" : ""}`}>{relayProtocol(relay.url)}</span></strong><code>{relay.url}</code></div>
                  <span className={`status-dot ${relay.enabled ? relayStates[relay.url] ?? "connecting" : "offline"}`} aria-label={relay.enabled ? relayStates[relay.url] ?? "连接中" : "已停用"} />
                  <button className="trash-button" onClick={() => setRelays((current) => current.filter((item) => item.url !== relay.url))} aria-label={`删除 ${relay.url}`}><Icon name="trash" /></button>
                </li>
              ))}
            </ul>
            <form className="add-relay" onSubmit={addRelay}>
              <label htmlFor="new-relay">添加中继</label>
              <div><input id="new-relay" value={newRelay} onChange={(event) => setNewRelay(event.target.value)} placeholder="wss:// 或 ws://" inputMode="url" autoCapitalize="none" autoCorrect="off" /><button type="submit" aria-label="添加中继"><Icon name="plus" /></button></div>
              <p className="field-hint">在 HTTPS 页面中，浏览器可能会拦截不加密的 ws:// 连接；客户端仍会保留该中继并显示实际连接状态。</p>
              {relayError && <p className="field-error">{relayError}</p>}
            </form>
          </aside>
        </div>
      )}

      {composerOpen && (
        <div className="sheet-backdrop composer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setComposerOpen(false); }}>
          <section className="composer-sheet" role="dialog" aria-modal="true" aria-labelledby="composer-title">
            <div className="sheet-heading">
              <div><p className="section-index">SIGNED NOTE</p><h2 id="composer-title">发一条帖子</h2></div>
              <button className="icon-button" onClick={() => setComposerOpen(false)} aria-label="关闭发布器"><Icon name="close" /></button>
            </div>
            <form onSubmit={(event) => void publish(event)}>
              <label htmlFor="post-content">帖子内容</label>
              <textarea id="post-content" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={4000} autoFocus placeholder="写点什么…" />
              <div className="composer-footer">
                <span>{draft.length}/4000</span>
                <button className="publish-button" type="submit" disabled={!draft.trim()}>{pubkey ? "签名并发布" : "连接签名器并发布"}</button>
              </div>
              <p className="signing-note">使用浏览器中的 NIP-07 签名器；私钥不会交给此页面。</p>
              {signerError && <p className="field-error">{signerError}</p>}
            </form>
          </section>
        </div>
      )}

      {detailEvent && (
        <div className="sheet-backdrop detail-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetailEventId(null); }}>
          <article className="detail-sheet" role="dialog" aria-modal="true" aria-labelledby="note-detail-title">
            <div className="sheet-heading">
              <div><p className="section-index">KIND 1 EVENT</p><h2 id="note-detail-title">帖子详情</h2></div>
              <button className="icon-button" onClick={() => setDetailEventId(null)} aria-label="关闭帖子详情"><Icon name="close" /></button>
            </div>
            <button className="detail-author" onClick={() => openProfile(detailEvent.pubkey)}>
              <span className="avatar-mark">{detailEvent.pubkey.slice(0, 2).toUpperCase()}</span>
              <span><strong>{shortKey(encodeNip19("npub", detailEvent.pubkey))}</strong><small>查看这个作者的帖子</small></span>
            </button>
            <div className="detail-content"><FormattedNote content={detailEvent.content} /></div>
            <dl className="event-facts">
              <div><dt>发布时间</dt><dd>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(detailEvent.created_at * 1000))}</dd></div>
              <div><dt>来源中继</dt><dd>{detailEvent.relays.join("、")}</dd></div>
              <div><dt>事件 ID</dt><dd><code>{encodeNip19("note", detailEvent.id)}</code><button onClick={() => void copyValue(encodeNip19("note", detailEvent.id), "事件 ID")}>复制</button></dd></div>
              <div><dt>作者公钥</dt><dd><code>{encodeNip19("npub", detailEvent.pubkey)}</code><button onClick={() => void copyValue(encodeNip19("npub", detailEvent.pubkey), "作者公钥")}>复制</button></dd></div>
            </dl>
            {copyMessage && <p className="copy-status" role="status">{copyMessage}</p>}
          </article>
        </div>
      )}

      {profilePubkey && (
        <div className="sheet-backdrop detail-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setProfilePubkey(null); }}>
          <section className="detail-sheet" role="dialog" aria-modal="true" aria-labelledby="profile-title">
            <div className="sheet-heading">
              <div><p className="section-index">PUBLIC KEY</p><h2 id="profile-title">作者</h2></div>
              <button className="icon-button" onClick={() => setProfilePubkey(null)} aria-label="关闭作者详情"><Icon name="close" /></button>
            </div>
            <div className="profile-identity">
              <span className="avatar-mark large-avatar">{profilePubkey.slice(0, 2).toUpperCase()}</span>
              <code>{encodeNip19("npub", profilePubkey)}</code>
              <button onClick={() => void copyValue(encodeNip19("npub", profilePubkey), "公钥")}>复制完整 npub</button>
            </div>
            {copyMessage && <p className="copy-status" role="status">{copyMessage}</p>}
            <div className="profile-posts">
              <h3>当前已加载的帖子 <span>{profileEvents.length}</span></h3>
              {profileEvents.map((item) => (
                <button key={item.id} onClick={() => openNote(item.id)}>
                  <span>{item.content.trim() || "（空文本）"}</span>
                  <small>{relativeTime(item.created_at)} · {shortKey(encodeNip19("note", item.id))}</small>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
