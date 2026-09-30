/**
 * 测试夹具：共享的样本数据 + 独立的 bech32 解码（用于 round-trip 验证，
 * 按 bech32 规范独立实现，不复制 App.tsx 的编码逻辑）+ localStorage mock。
 */

export const SAMPLE_HEX_PUBKEY = "3bf0c63fcb934634d10e5e72dbcea93860b08c0219d2a3c121b3629683c751ef";
// NIP-19 官方示例向量：上面 pubkey 的标准 npub 编码（ground truth）
export const SAMPLE_NPUB = "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6";

// 经独立实现（workspace/wg/nostr.py，libsecp256k1 交叉验证）确认的真值向量，
// 用作编码正确性的最终仲裁：
export const TRUTH_HEX = "deb3a89b171ed698b708a3f849e4500c44c16fbb982621278ff26ca1c5174c44";
export const TRUTH_NPUB = "npub1m6e63xchrmtf3dcg50uynezsp3zvzmamnqnzzfu07fk2r3ghf3zqtn0yuh";

export const SAMPLE_HEX_ID = "0123456789abcdef".repeat(4);
export const SAMPLE_HEX_PUBKEY_2 = "aa".repeat(32);
export const SAMPLE_HEX_PUBKEY_3 = "bb".repeat(32);

export type SampleEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

export function makeEvent(overrides: Partial<SampleEvent> = {}): SampleEvent {
  return {
    id: SAMPLE_HEX_ID,
    pubkey: SAMPLE_HEX_PUBKEY,
    created_at: 1_700_000_000,
    kind: 1,
    tags: [],
    content: "hello nostr",
    sig: "cc".repeat(64).slice(0, 128),
    ...overrides,
  };
}

export const SAMPLE_PROFILE_JSON = JSON.stringify({
  name: "alice",
  display_name: "Alice 绿林",
  about: "测试简介\n第二行",
  picture: "https://example.com/avatar.png",
  nip05: "alice@example.com",
  website: "https://example.com",
  lud16: "alice@example.com",
  extra_unknown_field: "ignored",
});

export function makeKind0Event(pubkey = SAMPLE_HEX_PUBKEY, content = SAMPLE_PROFILE_JSON): SampleEvent {
  return makeEvent({ kind: 0, pubkey, content, tags: [] });
}

export function makeKind3Event(pubkey: string, follows: string[]): SampleEvent {
  return makeEvent({
    kind: 3,
    pubkey,
    content: "",
    tags: [...follows.map((f) => ["p", f]), ["e", "keep-me"]],
  });
}

export const SAMPLE_RELAYS = [
  { url: "ws://lulin.org", enabled: true },
  { url: "wss://relay.gulugulu.moe", enabled: true },
  { url: "wss://relay-jp.nostr.wirednet.jp", enabled: false },
];

export const LONG_CONTENT = Array.from({ length: 30 }, (_, i) => `这是第 ${i + 1} 行内容，用来测试长文本折叠。`).join("\n");

/** 内存 localStorage mock；每个测试文件顶部调用一次即可。 */
export function installLocalStorageMock() {
  const store = new Map<string, string>();
  const mock = {
    getItem: (key: string): string | null => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string): void => {
      store.set(key, String(value));
    },
    removeItem: (key: string): void => {
      store.delete(key);
    },
    clear: (): void => {
      store.clear();
    },
    key: (index: number): string | null => [...store.keys()][index] ?? null,
    get length(): number {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: mock, configurable: true, writable: true });
  return mock;
}

// ---- 独立的 bech32 解码（测试专用，不依赖 App.tsx） ----

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values: number[]): number {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= generators[i];
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

export function bech32Decode(bech: string): { prefix: string; bytesHex: string } {
  const lower = bech.toLowerCase();
  const pos = lower.lastIndexOf("1");
  if (pos < 1) throw new Error("missing separator");
  const prefix = lower.slice(0, pos);
  const data = [...lower.slice(pos + 1)].map((c) => {
    const v = BECH32_CHARSET.indexOf(c);
    if (v === -1) throw new Error(`bad char ${c}`);
    return v;
  });
  if (polymod([...hrpExpand(prefix), ...data]) !== 1) throw new Error("bad checksum");
  const payload = data.slice(0, -6);
  // 5-bit -> 8-bit
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const w of payload) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((acc >>> bits) & 0xff);
    }
  }
  return { prefix, bytesHex: bytes.map((b) => b.toString(16).padStart(2, "0")).join("") };
}
