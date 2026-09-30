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

type Profile = {
  name?: string;
  display_name?: string;
  about?: string;
  picture?: string;
  nip05?: string;
  website?: string;
  lud16?: string;
};

type ProfileEntry = {
  profile: Profile;
  created_at: number;
  fetched_at: number;
};

type ContactList = {
  tags: string[][];
  content: string;
  created_at: number;
};

const DEFAULT_RELAYS: RelayConfig[] = [
  { url: "ws://lulin.org", enabled: true },
  { url: "wss://relay.gulugulu.moe", enabled: true },
  { url: "wss://relay.nostr.wirednet.jp", enabled: true },
  { url: "wss://relay-jp.nostr.wirednet.jp", enabled: true },
];

const RELAY_STORAGE_KEY = "nostr-min-relays-v1";
const PROFILE_STORAGE_KEY = "nostr-min-profiles-v1";
const FOLLOWS_STORAGE_KEY = "nostr-min-follows-v1";
const LOCAL_FOLLOWS_STORAGE_KEY = "nostr-min-follows-local-v1";
const EVENTS_STORAGE_KEY = "nostr-min-events-v1";
const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_EVENTS = 120;

// Persisted feed: after the first successful load the latest notes survive
// browser restarts and render instantly (even offline) before relays
// reconnect. Live events merge over the cached ones by id.
export function loadCachedEvents(): NostrEvent[] {
  try {
    const raw = localStorage.getItem(EVENTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is NostrEvent =>
          !!entry &&
          typeof entry === "object" &&
          (entry as { kind?: unknown }).kind === 1 &&
          typeof (entry as { id?: unknown }).id === "string" &&
          typeof (entry as { pubkey?: unknown }).pubkey === "string" &&
          typeof (entry as { content?: unknown }).content === "string" &&
          typeof (entry as { created_at?: unknown }).created_at === "number",
      )
      .map((entry) => ({
        ...entry,
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        relays: Array.isArray(entry.relays) ? entry.relays : [],
      }))
      .slice(0, MAX_EVENTS);
  } catch {
    return [];
  }
}

export function saveCachedEvents(events: NostrEvent[]): void {
  try {
    localStorage.setItem(EVENTS_STORAGE_KEY, JSON.stringify(events.slice(0, MAX_EVENTS)));
  } catch {
    // quota exceeded or private mode — the live feed still works
  }
}

// ---- 浏览模式：自动跑马灯 / 手动 ----

export type ViewMode = "auto" | "manual";

const VIEW_MODE_STORAGE_KEY = "nostr-min-view-mode-v1";

/** 跑马灯行数。 */
export const MARQUEE_ROWS = 2;
/** 跑马灯卡片宽度（px），必须与 .marquee-card 的 CSS 宽度一致。 */
export const MARQUEE_CARD_W = 300;
/** 跑马灯卡片间距（px），必须与 .marquee-track 的 CSS gap 一致。 */
export const MARQUEE_GAP = 16;
/** 单步位移 = 卡片宽 + 间距；循环与前置新帖时按此步长补偿，视觉无跳动。 */
export const MARQUEE_STEP = MARQUEE_CARD_W + MARQUEE_GAP;
/** 每行速度（px/秒），方向：从左进入、向右溢出。 */
export const MARQUEE_SPEEDS = [80, 56];
/** 跑马灯每行最多保留的帖子数（循环队列上限）。 */
export const MARQUEE_MAX_NOTES = 60;
/** 单次新帖超过此数时直接按新帖池重建，避免 offset 左移过远长时间空白。 */
export const MARQUEE_RESET_THRESHOLD = 12;

export function loadViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_STORAGE_KEY) === "manual" ? "manual" : "auto";
  } catch {
    return "auto";
  }
}

export function saveViewMode(mode: ViewMode): void {
  try {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // private mode — keep the choice in memory only
  }
}

/** 跑马灯向右流动一帧后的偏移：offset 增大，卡片整体向右移动。 */
export function marqueeStepOffset(offset: number, dtMs: number, speedPxPerSec: number): number {
  return offset + (speedPxPerSec * dtMs) / 1000;
}

/**
 * 右端整张卡片完全溢出后，把它搬到最左端继续循环；
 * offset 同步回退一个步长，画面无跳动。不足两张或尚未溢出时原样返回。
 */
export function marqueeRecycle<T>(items: T[], offset: number, step: number): { items: T[]; offset: number } {
  if (items.length < 2 || offset < step) return { items, offset };
  const tail = items[items.length - 1] as T;
  return { items: [tail, ...items.slice(0, -1)], offset: offset - step };
}

/**
 * 新帖从左侧进入：在队首前置新帖，同时把 offset 向左移相同步数，
 * 存量卡片的视觉位置保持不动。fresh 为空时原样返回。
 */
export function marqueePrepend<T>(items: T[], offset: number, fresh: T[], step: number): { items: T[]; offset: number } {
  if (fresh.length === 0) return { items, offset };
  return { items: [...fresh, ...items], offset: offset - step * fresh.length };
}

/** NIP-10 回复标签：e 标签带中继提示与 reply 标记，p 标签指向原作者。 */
export function buildReplyTags(parent: { id: string; pubkey: string; relays: string[] }): string[][] {
  const hint = parent.relays.find((relay) => relay.startsWith("ws")) ?? "";
  return [
    ["e", parent.id, hint, "reply"],
    ["p", parent.pubkey],
  ];
}

function createUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function loadRelays(): RelayConfig[] {
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

export function normalizeRelay(value: string): string | null {
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

export function shortKey(value: string): string {
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

export function encodeNip19(prefix: "npub" | "note", hex: string): string {
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

export function parseProfileContent(content: string): Profile | null {
  try {
    const data: unknown = JSON.parse(content);
    if (typeof data !== "object" || data === null) return null;
    const record = data as Record<string, unknown>;
    const pick = (key: string): string | undefined => {
      const value = record[key];
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
    };
    const profile: Profile = {
      name: pick("name"),
      display_name: pick("display_name"),
      about: pick("about"),
      picture: pick("picture"),
      nip05: pick("nip05"),
      website: pick("website"),
      lud16: pick("lud16"),
    };
    return Object.values(profile).some(Boolean) ? profile : null;
  } catch {
    return null;
  }
}

export function loadProfileCache(): Record<string, ProfileEntry> {
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, ProfileEntry>) : {};
  } catch {
    return {};
  }
}

export function loadStoredFollows(pubkey: string | null): string[] {
  try {
    const raw = localStorage.getItem(pubkey ? FOLLOWS_STORAGE_KEY : LOCAL_FOLLOWS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (pubkey) {
      if (typeof parsed !== "object" || parsed === null) return [];
      const list = (parsed as Record<string, unknown>)[pubkey];
      return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
    }
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function profileName(pubkey: string, cache: Record<string, ProfileEntry>): string {
  const entry = cache[pubkey];
  const name = entry?.profile.display_name || entry?.profile.name;
  if (name) return name;
  return shortKey(encodeNip19("npub", pubkey));
}

export function profilePicture(pubkey: string, cache: Record<string, ProfileEntry>): string | undefined {
  return cache[pubkey]?.profile.picture;
}

/** Merge a new follow set into an existing kind-3 tag list: keep non-p tags, replace p tags. */
export function mergeContactTags(existing: string[][] | undefined, follows: string[]): string[][] {
  const kept = (existing ?? []).filter((tag) => tag[0] !== "p" && typeof tag[0] === "string");
  return [...kept, ...follows.map((pubkey) => ["p", pubkey])];
}

export function relativeTime(timestamp: number): string {
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

export function renderInline(text: string, keyPrefix: string): ReactNode[] {
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

export function FormattedNote({ content }: { content: string }) {
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

export function isNostrEvent(value: unknown, kind: number): value is SignedEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Partial<SignedEvent>;
  return (
    typeof event.id === "string" &&
    typeof event.pubkey === "string" &&
    typeof event.created_at === "number" &&
    event.kind === kind &&
    typeof event.content === "string" &&
    typeof event.sig === "string" &&
    Array.isArray(event.tags)
  );
}

function Icon({ name }: { name: "relay" | "refresh" | "edit" | "key" | "close" | "plus" | "trash" | "reply" | "play" | "pause" }) {
  const common = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (name === "relay") return <svg {...common}><circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="12" r="7.5"/><path d="M4.7 4.7 7 7M17 17l2.3 2.3M19.3 4.7 17 7M7 17l-2.3 2.3"/></svg>;
  if (name === "refresh") return <svg {...common}><path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M18.2 9A7 7 0 0 0 6.4 6.4L4 11M20 13l-2.4 4.6A7 7 0 0 1 5.8 15"/></svg>;
  if (name === "edit") return <svg {...common}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>;
  if (name === "key") return <svg {...common}><circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M15 8l2 2M17 6l2 2"/></svg>;
  if (name === "close") return <svg {...common}><path d="m6 6 12 12M18 6 6 18"/></svg>;
  if (name === "plus") return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>;
  if (name === "reply") return <svg {...common}><path d="M8 7 3 12l5 5"/><path d="M3 12h11a7 7 0 0 1 7 7v1"/></svg>;
  if (name === "play") return <svg {...common}><path d="m8 5 11 7-11 7Z"/></svg>;
  if (name === "pause") return <svg {...common}><path d="M9 5v14M15 5v14"/></svg>;
  return <svg {...common}><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>;
}

function AvatarImg({ picture, label, large }: { picture: string; label: string; large?: boolean }) {
  return <img className={`avatar-img${large ? " large-avatar-img" : ""}`} src={picture} alt={label} loading="lazy" />;
}

/** Renders note content clamped to the card; shows an expand hint only when text actually overflows. */
function ClampedNote({ content }: { content: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [clamped, setClamped] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el) setClamped(el.scrollHeight > el.clientHeight + 6);
  }, [content]);
  return (
    <>
      <div className="note-content" ref={ref}>
        <FormattedNote content={content} />
      </div>
      {clamped && <span className="expand-hint">内容较长，点击展开全文 →</span>}
    </>
  );
}

/** 帖子卡片的共享主体：手动网格与自动轮播共用，页脚带回复按钮。 */
function NoteCard({ item, profileCache, onOpenProfile, onOpenNote, onReply }: {
  item: NostrEvent;
  profileCache: Record<string, ProfileEntry>;
  onOpenProfile: (pubkey: string) => void;
  onOpenNote: (eventId: string) => void;
  onReply: (item: NostrEvent) => void;
}) {
  const picture = profilePicture(item.pubkey, profileCache);
  return (
    <>
      <div className="note-meta">
        <button className="avatar-mark" onClick={() => onOpenProfile(item.pubkey)} aria-label={`查看作者 ${profileName(item.pubkey, profileCache)}`}>
          {picture ? <AvatarImg picture={picture} label="" /> : item.pubkey.slice(0, 2).toUpperCase()}
        </button>
        <button className="author" onClick={() => onOpenProfile(item.pubkey)} title={item.pubkey}>{profileName(item.pubkey, profileCache)}</button>
        <time dateTime={new Date(item.created_at * 1000).toISOString()}>{relativeTime(item.created_at)}</time>
      </div>
      <button className="note-open" onClick={() => onOpenNote(item.id)} aria-label={`查看帖子 ${shortKey(encodeNip19("note", item.id))}`}>
        <ClampedNote content={item.content} />
      </button>
      <div className="note-footer">
        <span className="note-relays" title={item.relays.join("\n")}><span className="tiny-signal" />{item.relays.length === 1 ? relayLabel(item.relays[0] ?? "") : `${item.relays.length} 个中继`}</span>
        <span className="note-actions">
          <button className="reply-button" onClick={() => onReply(item)} aria-label={`回复 ${profileName(item.pubkey, profileCache)}`}><Icon name="reply" />回复</button>
          <button className="view-detail" onClick={() => onOpenNote(item.id)}>查看详情 →</button>
        </span>
      </div>
    </>
  );
}

/** 自动模式的一行跑马灯：卡片从左进入、向右溢出，requestAnimationFrame 驱动。 */
function MarqueeRow({ notes, speed, initialRotate, paused, profileCache, onOpenProfile, onOpenNote, onReply }: {
  notes: NostrEvent[];
  speed: number;
  initialRotate: number;
  paused: boolean;
  profileCache: Record<string, ProfileEntry>;
  onOpenProfile: (pubkey: string) => void;
  onOpenNote: (eventId: string) => void;
  onReply: (item: NostrEvent) => void;
}) {
  const rotateIds = (ids: string[], n: number) => {
    if (ids.length === 0) return ids;
    const k = ((n % ids.length) + ids.length) % ids.length;
    return [...ids.slice(k), ...ids.slice(0, k)];
  };
  const [initial] = useState(() => {
    const ids = rotateIds(
      notes.map((note) => note.id),
      initialRotate,
    );
    return { ids, map: new Map(notes.map((note) => [note.id, note] as [string, NostrEvent])) };
  });
  const [order, setOrder] = useState<string[]>(initial.ids);
  const orderRef = useRef(order);
  const offsetRef = useRef(0);
  const seenRef = useRef<Set<string>>(new Set(orderRef.current));
  const noteMapRef = useRef(initial.map);
  const trackRef = useRef<HTMLDivElement>(null);

  const applyOffset = (value: number) => {
    if (trackRef.current) trackRef.current.style.transform = `translate3d(${value}px, 0, 0)`;
  };

  // 新帖到达：把没见过的 id 前置到队首（从左侧进入），offset 左移补偿；
  // 单次大量到达则按新帖池重建，避免 offset 漂出太远长时间空白。
  useEffect(() => {
    for (const note of notes) {
      if (!noteMapRef.current.has(note.id)) noteMapRef.current.set(note.id, note);
    }
    const fresh = notes.map((note) => note.id).filter((id) => !seenRef.current.has(id));
    let items = orderRef.current;
    let offset = offsetRef.current;
    if (fresh.length > MARQUEE_RESET_THRESHOLD) {
      items = rotateIds(
        notes.map((note) => note.id),
        initialRotate,
      );
      offset = 0;
      seenRef.current = new Set(items);
      noteMapRef.current = new Map(notes.map((note) => [note.id, note] as [string, NostrEvent]));
    } else if (fresh.length > 0) {
      fresh.forEach((id) => seenRef.current.add(id));
      const prepended = marqueePrepend(items, offset, fresh, MARQUEE_STEP);
      items = prepended.items;
      offset = prepended.offset;
    }
    if (items.length > MARQUEE_MAX_NOTES) {
      const dropped = items.slice(MARQUEE_MAX_NOTES);
      items = items.slice(0, MARQUEE_MAX_NOTES);
      dropped.forEach((id) => noteMapRef.current.delete(id));
    }
    orderRef.current = items;
    offsetRef.current = offset;
    applyOffset(offset);
    setOrder(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  // rAF 主循环：offset 直接写 DOM，不经过 React state，避免每帧重渲染。
  useEffect(() => {
    if (paused) return;
    let raf = 0;
    let last = -1;
    const tick = (now: number) => {
      if (last < 0) last = now;
      const dt = Math.min(now - last, 100);
      last = now;
      let offset = marqueeStepOffset(offsetRef.current, dt, speed);
      let items = orderRef.current;
      let guard = 0;
      while (offset >= MARQUEE_STEP && items.length > 1 && guard++ < 8) {
        const recycled = marqueeRecycle(items, offset, MARQUEE_STEP);
        items = recycled.items;
        offset = recycled.offset;
      }
      if (items !== orderRef.current) {
        orderRef.current = items;
        setOrder(items);
      }
      offsetRef.current = offset;
      applyOffset(offset);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [paused, speed]);

  return (
    <div className="marquee-row">
      <div className="marquee-track" ref={trackRef}>
        {order.map((id) => {
          const note = noteMapRef.current.get(id);
          if (!note) return null;
          return (
            <article key={id} className="note marquee-card">
              <NoteCard item={note} profileCache={profileCache} onOpenProfile={onOpenProfile} onOpenNote={onOpenNote} onReply={onReply} />
            </article>
          );
        })}
      </div>
    </div>
  );
}

export function App() {
  const [relays, setRelays] = useState<RelayConfig[]>(loadRelays);
  const [relayStates, setRelayStates] = useState<Record<string, RelayState>>({});
  const [events, setEvents] = useState<NostrEvent[]>(loadCachedEvents);
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
  const [profileCache, setProfileCache] = useState<Record<string, ProfileEntry>>(loadProfileCache);
  const [follows, setFollows] = useState<string[]>(() => loadStoredFollows(null));
  const [feedTab, setFeedTab] = useState<"all" | "following">("all");
  const [followsOpen, setFollowsOpen] = useState(false);
  const [followMessage, setFollowMessage] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(loadViewMode);
  const [manualEvents, setManualEvents] = useState<NostrEvent[]>(() => loadCachedEvents());
  const [autoPaused, setAutoPaused] = useState(false);
  const [reducedMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [replyTarget, setReplyTarget] = useState<NostrEvent | null>(null);
  const socketsRef = useRef<Map<string, WebSocket>>(new Map());
  const publishAcksRef = useRef<Map<string, Set<string>>>(new Map());
  const profileSubsRef = useRef<Set<string>>(new Set());
  const profileRequestedRef = useRef<Set<string>>(new Set());
  const contactSubRef = useRef<string | null>(null);
  const contactBaseRef = useRef<ContactList | null>(null);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const lastPersistRef = useRef(0);

  // Persist the feed (throttled): bursts of incoming notes would otherwise
  // stringify on every event; pagehide flushes the latest state so nothing
  // is lost when the browser closes.
  useEffect(() => {
    const now = Date.now();
    if (now - lastPersistRef.current < 3000) return;
    lastPersistRef.current = now;
    saveCachedEvents(events);
  }, [events]);

  useEffect(() => {
    const flush = () => saveCachedEvents(eventsRef.current);
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  const enabledRelays = useMemo(() => relays.filter((relay) => relay.enabled), [relays]);
  const onlineCount = enabledRelays.filter((relay) => relayStates[relay.url] === "online").length;
  const detailEvent = detailEventId ? events.find((event) => event.id === detailEventId) ?? null : null;
  const profileEvents = profilePubkey ? events.filter((event) => event.pubkey === profilePubkey) : [];
  const feedEvents = viewMode === "manual" ? manualEvents : events;
  const visibleEvents = feedTab === "following" ? feedEvents.filter((event) => follows.includes(event.pubkey)) : feedEvents;
  // 跑马灯帖池：最新在前；行内按"最新在左"排列，新帖从左侧进入。
  const marqueePool = useMemo(() => visibleEvents.slice(0, MARQUEE_MAX_NOTES), [visibleEvents]);
  const manualIds = useMemo(() => new Set(manualEvents.map((event) => event.id)), [manualEvents]);
  const manualPendingCount = events.reduce((count, event) => count + (manualIds.has(event.id) ? 0 : 1), 0);
  const modalOpen = composerOpen || detailEventId !== null || profilePubkey !== null || panelOpen || followsOpen;
  const marqueePaused = autoPaused || modalOpen || reducedMotion;

  // 浏览模式持久化；切到手动模式时冻结当前快照。
  useEffect(() => {
    saveViewMode(viewMode);
  }, [viewMode]);

  useEffect(() => {
    if (viewMode === "manual") setManualEvents(eventsRef.current);
  }, [viewMode]);

  function refreshManualFeed() {
    setManualEvents(eventsRef.current);
    setConnectionEpoch((value) => value + 1);
  }
  const profileEntry = profilePubkey ? profileCache[profilePubkey] : undefined;
  const profileDetail = profileEntry?.profile;
  const isFollowing = profilePubkey ? follows.includes(profilePubkey) : false;

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

  const addProfile = useCallback((incoming: SignedEvent) => {
    const parsed = parseProfileContent(incoming.content);
    if (!parsed) return;
    setProfileCache((current) => {
      const existing = current[incoming.pubkey];
      if (existing && existing.created_at >= incoming.created_at) return current;
      return { ...current, [incoming.pubkey]: { profile: parsed, created_at: incoming.created_at, fetched_at: Date.now() } };
    });
  }, []);

  const addContactList = useCallback((incoming: SignedEvent) => {
    const base: ContactList = { tags: incoming.tags, content: incoming.content, created_at: incoming.created_at };
    if (contactBaseRef.current && contactBaseRef.current.created_at >= incoming.created_at) return;
    contactBaseRef.current = base;
    const list = incoming.tags
      .filter((tag) => tag[0] === "p" && typeof tag[1] === "string")
      .map((tag) => tag[1] as string);
    setFollows((current) => {
      const merged = [...current];
      for (const pubkey of list) if (!merged.includes(pubkey)) merged.push(pubkey);
      return merged;
    });
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profileCache));
    } catch {
      // Storage quota or privacy mode: keep profiles in memory only.
    }
  }, [profileCache]);

  // Fetch kind-0 profiles for authors we have not seen recently. Runs on new
  // authors and on reconnect (requested set is cleared when epoch changes).
  const wantedAuthors = useMemo(() => [...new Set(events.map((event) => event.pubkey))], [events]);
  const profileEpochRef = useRef(connectionEpoch);
  useEffect(() => {
    if (profileEpochRef.current !== connectionEpoch) {
      profileEpochRef.current = connectionEpoch;
      profileRequestedRef.current.clear();
    }
    const now = Date.now();
    const missing = wantedAuthors.filter((author) => {
      const hit = profileCache[author];
      if (hit && now - hit.fetched_at < PROFILE_TTL_MS) return false;
      return !profileRequestedRef.current.has(author);
    });
    if (missing.length === 0) return;
    const liveSockets = [...socketsRef.current.values()].filter((socket) => socket.readyState === WebSocket.OPEN);
    if (liveSockets.length === 0) return;
    for (let index = 0; index < missing.length; index += 60) {
      const chunk = missing.slice(index, index + 60);
      const subId = `profile-${createUuid().slice(0, 8)}`;
      profileSubsRef.current.add(subId);
      chunk.forEach((author) => profileRequestedRef.current.add(author));
      for (const socket of liveSockets) {
        socket.send(JSON.stringify(["REQ", subId, { kinds: [0], authors: chunk }]));
      }
    }
  }, [wantedAuthors, profileCache, connectionEpoch]);

  // When the signer is connected, load our own kind-3 contact list.
  useEffect(() => {
    if (!pubkey) return;
    setFollows(loadStoredFollows(pubkey));
    const liveSockets = [...socketsRef.current.values()].filter((socket) => socket.readyState === WebSocket.OPEN);
    if (liveSockets.length === 0) return;
    const subId = `contacts-${createUuid().slice(0, 8)}`;
    contactSubRef.current = subId;
    for (const socket of liveSockets) {
      socket.send(JSON.stringify(["REQ", subId, { kinds: [3], authors: [pubkey], limit: 1 }]));
    }
  }, [pubkey, connectionEpoch]);

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
              if (frame[0] === "EVENT" && typeof frame[1] === "string") {
                const incoming = frame[2];
                if (frame[1] === subId && isNostrEvent(incoming, 1)) {
                  addIncomingEvent(incoming, relay.url);
                } else if (profileSubsRef.current.has(frame[1]) && isNostrEvent(incoming, 0)) {
                  addProfile(incoming);
                } else if (frame[1] === contactSubRef.current && isNostrEvent(incoming, 3)) {
                  addContactList(incoming);
                }
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

  /** 签名并发布一条 kind-1 帖子；tags 为空是普通帖子，带 e/p 标签即为回复。 */
  async function publishNote(content: string, tags: string[][]): Promise<boolean> {
    setSignerError("");
    const currentPubkey = pubkey ?? await connectSigner();
    if (!currentPubkey || !window.nostr) return false;
    const liveSockets = [...socketsRef.current.entries()].filter(([, socket]) => socket.readyState === WebSocket.OPEN);
    if (liveSockets.length === 0) {
      setNetworkMessage("当前没有在线中继，无法发布。请检查中继面板后重试。");
      return false;
    }
    try {
      const signed = await window.nostr.signEvent({
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content,
      });
      if (!isNostrEvent(signed, 1)) throw new Error("invalid signed event");
      publishAcksRef.current.set(signed.id, new Set());
      setPublishStatus({ eventId: signed.id, total: liveSockets.length, accepted: 0, rejected: 0, pending: liveSockets.length });
      setEvents((current) => [{ ...signed, relays: ["本地发布"] }, ...current.filter((item) => item.id !== signed.id)].slice(0, MAX_EVENTS));
      for (const [, socket] of liveSockets) socket.send(JSON.stringify(["EVENT", signed]));
      return true;
    } catch {
      setSignerError("签名未完成，帖子没有发送。");
      return false;
    }
  }

  async function publish(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content) return;
    const target = replyTarget;
    const ok = await publishNote(content, target ? buildReplyTags(target) : []);
    if (!ok) return;
    setDraft("");
    setComposerOpen(false);
    setReplyTarget(null);
  }

  function openReply(item: NostrEvent) {
    setDetailEventId(null);
    setProfilePubkey(null);
    setReplyTarget(item);
    setDraft("");
    setComposerOpen(true);
  }

  async function toggleFollow(target: string) {
    setFollowMessage("");
    const following = follows.includes(target);
    const next = following ? follows.filter((item) => item !== target) : [...follows, target];
    setFollows(next);
    if (pubkey && window.nostr) {
      try {
        const base = contactBaseRef.current;
        const signed = await window.nostr.signEvent({
          kind: 3,
          created_at: Math.floor(Date.now() / 1000),
          tags: mergeContactTags(base?.tags, next),
          content: base?.content ?? "",
        });
        if (signed.kind !== 3 || !Array.isArray(signed.tags)) throw new Error("invalid contact list");
        contactBaseRef.current = { tags: signed.tags, content: signed.content, created_at: signed.created_at };
        const liveSockets = [...socketsRef.current.values()].filter((socket) => socket.readyState === WebSocket.OPEN);
        for (const socket of liveSockets) socket.send(JSON.stringify(["EVENT", signed]));
        try {
          const raw = localStorage.getItem(FOLLOWS_STORAGE_KEY);
          const parsed: unknown = raw ? JSON.parse(raw) : {};
          const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, string[]>) : {};
          localStorage.setItem(FOLLOWS_STORAGE_KEY, JSON.stringify({ ...record, [pubkey]: next }));
        } catch {
          // Keep the in-memory follow set when storage is unavailable.
        }
        setFollowMessage(following ? "已取消关注，关注列表已发布到中继。" : "已关注，关注列表已发布到中继。");
      } catch {
        setFollowMessage("签名未完成，关注列表没有发布；本地状态已更新。");
      }
      return;
    }
    try {
      localStorage.setItem(LOCAL_FOLLOWS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Keep the in-memory follow set when storage is unavailable.
    }
    setFollowMessage(following ? "已取消本地关注。" : "已加入本地关注（连接签名器后可发布到链上）。");
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
    <div className={`app-shell ${viewMode === "auto" ? "auto-mode" : "manual-mode"}`}>
      <SafeAreaTopScrim backgroundColor="var(--bg)" />

      <header className="utility-bar">
        <button className="relay-summary" onClick={() => setPanelOpen(true)} aria-label="打开中继管理">
          <span className={`signal ${onlineCount > 0 ? "signal-live" : ""}`} />
          <span>{onlineCount}/{enabledRelays.length} 中继在线</span>
        </button>
        <div className="utility-actions">
          <button className="icon-button" onClick={viewMode === "manual" ? refreshManualFeed : () => setConnectionEpoch((value) => value + 1)} aria-label={viewMode === "manual" ? "手动刷新帖子" : "重新连接中继"}><Icon name="refresh" /></button>
          <button className="identity-button" onClick={() => void connectSigner()} aria-label={pubkey ? "查看已连接身份" : "连接 NIP-07 签名器"}>
            <Icon name="key" />
            <span>{pubkey ? shortKey(pubkey) : "连接签名器"}</span>
          </button>
        </div>
      </header>

      <main className={`feed-column${viewMode === "auto" ? " auto-feed" : ""}`}>
        <section className="feed-intro" aria-labelledby="feed-heading">
          <div>
            <p className="section-index">PUBLIC NOTES / KIND 1</p>
            <h1 id="feed-heading">最新帖子</h1>
          </div>
          <button className="compose-button desktop-compose" onClick={() => { setReplyTarget(null); setDraft(""); setComposerOpen(true); }}><Icon name="edit" />发帖子</button>
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

        <div className="feed-tabs" role="tablist" aria-label="帖子筛选">
          <button role="tab" aria-selected={feedTab === "all"} className={`feed-tab${feedTab === "all" ? " active" : ""}`} onClick={() => setFeedTab("all")}>全部</button>
          <button role="tab" aria-selected={feedTab === "following"} className={`feed-tab${feedTab === "following" ? " active" : ""}`} onClick={() => setFeedTab("following")}>关注{follows.length > 0 ? ` · ${follows.length}` : ""}</button>
          {feedTab === "following" && follows.length > 0 && (
            <button className="manage-follows" onClick={() => setFollowsOpen(true)}>管理关注</button>
          )}
          {viewMode === "manual" && (
            <button className="manual-refresh" onClick={refreshManualFeed} aria-label="手动刷新帖子">
              <Icon name="refresh" />
              <span>{manualPendingCount > 0 ? `刷新 · ${manualPendingCount} 条新帖` : "刷新"}</span>
            </button>
          )}
          <div className="view-switch" role="group" aria-label="浏览模式">
            <button className={`view-option${viewMode === "auto" ? " active" : ""}`} aria-pressed={viewMode === "auto"} onClick={() => setViewMode("auto")}>自动</button>
            <button className={`view-option${viewMode === "manual" ? " active" : ""}`} aria-pressed={viewMode === "manual"} onClick={() => setViewMode("manual")}>手动</button>
          </div>
        </div>

        {visibleEvents.length === 0 ? (
          <section className="empty-state">
            <div className="empty-signal"><span /><span /><span /></div>
            <h2>{feedTab === "following" ? "还没有关注的人" : onlineCount > 0 ? "正在等待帖子" : "还没有连上中继"}</h2>
            <p>{feedTab === "following" ? "在帖子或作者页点「关注」，这里只显示你关注的人的帖子。" : onlineCount > 0 ? "连接已建立，新帖子会直接出现在这里。" : "打开中继面板查看每个地址的状态，或添加一个可用中继。"}</p>
            <button onClick={() => feedTab === "following" ? setFeedTab("all") : onlineCount > 0 ? (viewMode === "manual" ? refreshManualFeed() : setConnectionEpoch((value) => value + 1)) : setPanelOpen(true)}>
              {feedTab === "following" ? "浏览全部帖子" : onlineCount > 0 ? (viewMode === "manual" ? "手动刷新" : "重新订阅") : "管理中继"}
            </button>
          </section>
        ) : viewMode === "manual" ? (
          <ol className="feed-list" aria-live="polite">
            {visibleEvents.map((item) => (
              <li className="note" key={item.id}>
                <NoteCard item={item} profileCache={profileCache} onOpenProfile={openProfile} onOpenNote={openNote} onReply={openReply} />
              </li>
            ))}
          </ol>
        ) : (
          <section
            className={`auto-stage${marqueePaused ? " paused" : ""}`}
            aria-label="帖子跑马灯"
            onMouseEnter={() => setAutoPaused(true)}
            onMouseLeave={() => setAutoPaused(false)}
          >
            <div className="marquee-rows">
              {Array.from({ length: MARQUEE_ROWS }, (_, row) => (
                <MarqueeRow
                  key={`${feedTab}-${row}`}
                  notes={marqueePool}
                  speed={MARQUEE_SPEEDS[row] ?? MARQUEE_SPEEDS[0] ?? 60}
                  initialRotate={row === 0 ? 0 : Math.floor(marqueePool.length / 2)}
                  paused={marqueePaused}
                  profileCache={profileCache}
                  onOpenProfile={openProfile}
                  onOpenNote={openNote}
                  onReply={openReply}
                />
              ))}
            </div>
            <div className="auto-bar">
              <button className="auto-pause" onClick={() => setAutoPaused((paused) => !paused)} aria-label={autoPaused ? "继续跑马灯" : "暂停跑马灯"}>
                <Icon name={autoPaused ? "play" : "pause"} />
              </button>
              <span className="auto-count">{marqueePool.length} 条帖子</span>
              <span className="auto-hint">悬停暂停 · 新帖从左侧进入</span>
            </div>
          </section>
        )}
      </main>

      <button className="compose-fab" onClick={() => { setReplyTarget(null); setDraft(""); setComposerOpen(true); }} aria-label="发帖子"><Icon name="edit" /></button>

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
        <div className="sheet-backdrop composer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setComposerOpen(false); setReplyTarget(null); } }}>
          <section className="composer-sheet" role="dialog" aria-modal="true" aria-labelledby="composer-title">
            <div className="sheet-heading">
              <div><p className="section-index">{replyTarget ? "REPLY" : "SIGNED NOTE"}</p><h2 id="composer-title">{replyTarget ? "回复帖子" : "发一条帖子"}</h2></div>
              <button className="icon-button" onClick={() => { setComposerOpen(false); setReplyTarget(null); }} aria-label="关闭发布器"><Icon name="close" /></button>
            </div>
            {replyTarget && (
              <div className="reply-context">
                <span className="reply-context-label">回复 {profileName(replyTarget.pubkey, profileCache)}</span>
                <p>{replyTarget.content.trim().slice(0, 140) || "（空文本）"}</p>
                <button className="reply-context-cancel" onClick={() => setReplyTarget(null)}>改为发普通帖子</button>
              </div>
            )}
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
            <div className="detail-actions">
              <button className="reply-button" onClick={() => openReply(detailEvent)}><Icon name="reply" />回复这条帖子</button>
            </div>
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
              {profileDetail?.picture ? (
                <AvatarImg picture={profileDetail.picture} label={profileName(profilePubkey, profileCache)} large />
              ) : (
                <span className="avatar-mark large-avatar">{profilePubkey.slice(0, 2).toUpperCase()}</span>
              )}
              <div className="profile-names">
                <strong>{profileName(profilePubkey, profileCache)}</strong>
                {profileDetail?.nip05 && <small className="profile-nip05">{profileDetail.nip05}</small>}
              </div>
              {profileDetail?.about && <p className="profile-about">{profileDetail.about}</p>}
              <code>{encodeNip19("npub", profilePubkey)}</code>
              <div className="profile-actions">
                <button className={`follow-button${isFollowing ? " following" : ""}`} onClick={() => void toggleFollow(profilePubkey)}>
                  {isFollowing ? "✓ 已关注" : "＋ 关注"}
                </button>
                <button onClick={() => void copyValue(encodeNip19("npub", profilePubkey), "公钥")}>复制完整 npub</button>
              </div>
              {followMessage && <p className="copy-status" role="status">{followMessage}</p>}
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

      {followsOpen && (
        <div className="sheet-backdrop detail-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setFollowsOpen(false); }}>
          <section className="detail-sheet" role="dialog" aria-modal="true" aria-labelledby="follows-title">
            <div className="sheet-heading">
              <div><p className="section-index">FOLLOWING</p><h2 id="follows-title">关注列表</h2></div>
              <button className="icon-button" onClick={() => setFollowsOpen(false)} aria-label="关闭关注列表"><Icon name="close" /></button>
            </div>
            <p className="sheet-copy">{pubkey ? "修改会经签名器签名，发布 kind-3 关注列表到中继。" : "未连接签名器，关注仅保存在本浏览器。"}</p>
            {followMessage && <p className="copy-status" role="status">{followMessage}</p>}
            {follows.length === 0 ? (
              <p className="muted">还没有关注任何人。在帖子或作者页点「关注」即可添加。</p>
            ) : (
              <ul className="follow-list">
                {follows.map((followed) => {
                  const picture = profilePicture(followed, profileCache);
                  return (
                    <li key={followed} className="follow-row">
                      <button
                        className="follow-identity"
                        onClick={() => { setFollowsOpen(false); openProfile(followed); }}
                        aria-label={`查看 ${profileName(followed, profileCache)}`}
                      >
                        {picture ? (
                          <AvatarImg picture={picture} label="" />
                        ) : (
                          <span className="avatar-mark">{followed.slice(0, 2).toUpperCase()}</span>
                        )}
                        <span className="follow-names">
                          <strong>{profileName(followed, profileCache)}</strong>
                          <small>{shortKey(encodeNip19("npub", followed))}</small>
                        </span>
                      </button>
                      <button className="unfollow-button" onClick={() => void toggleFollow(followed)}>取消关注</button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
