import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import {
useCallback,
useEffect,
useMemo,
useRef,
useState,
type FormEvent,
type ReactNode,
type CSSProperties,
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

/** 作者页单独拉取的历史帖子：与主时间线的 MAX_EVENTS 上限隔离。 */
type AuthorHistory = {
  pubkey: string;
  events: NostrEvent[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
};

/** 进行中的作者历史请求：跟踪每个订阅 id 收到的条数与 EOSE。 */
type AuthorHistoryRequest = {
  pubkey: string;
  subIds: Set<string>;
  counts: Map<string, number>;
  mode: "initial" | "more";
};

/** 帖子详情里的对话 thread：该帖子的直接回复（kind-1 带 e 标签），按时间正序。 */
type ThreadReplies = {
  eventId: string;
  events: NostrEvent[];
  loading: boolean;
};

/** 进行中的 thread 拉取请求：跟踪每个订阅 id 的 EOSE。 */
type ThreadRequest = {
  eventId: string;
  subIds: Set<string>;
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
  { url: "wss://lulin.org", enabled: true },
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

// ---- 浏览模式：自动网格 / 手动 ----

export type ViewMode = "auto" | "manual";

const VIEW_MODE_STORAGE_KEY = "nostr-min-view-mode-v1";

/** 自动网格：卡片最小宽度（px），必须与 .feed-list 的 minmax 下限一致。 */
export const AUTO_GRID_CARD_MIN_W = 300;
/** 自动网格：卡片固定高度（px），必须与 .note 的 height 一致。 */
export const AUTO_GRID_CARD_H = 340;
/** 自动网格：卡片间距（px），必须与 .feed-list 的 gap 一致。 */
export const AUTO_GRID_GAP = 12;
/** 窄屏阈值：舞台宽度小于此值时，自动网格竖分三列、显示块等比缩小。 */
export const AUTO_GRID_NARROW_W = 700;
/** 窄屏列数：屏幕竖分三块。 */
export const AUTO_GRID_NARROW_COLS = 3;
/** 窄屏下限：舞台宽度小于此值视为尚未布局完成，不启用窄屏模式。 */
export const AUTO_GRID_NARROW_MIN_W = 240;

export interface AutoGridTile { cardH: number; scale: number; narrow: boolean }

/**
 * 按舞台宽度算出自动网格的显示块尺寸。
 * 窄屏（手机）时竖分三列，卡片高度按列宽相对 300px 的比例等比缩小；
 * 缩放系数经 --auto-scale 注入 CSS，块内的头像/字号/边距同步缩小。
 */
export function autoGridTile(stageW: number): AutoGridTile {
  if (stageW >= AUTO_GRID_NARROW_MIN_W && stageW < AUTO_GRID_NARROW_W) {
    const cardW = (stageW - (AUTO_GRID_NARROW_COLS - 1) * AUTO_GRID_GAP) / AUTO_GRID_NARROW_COLS;
    const scale = cardW / AUTO_GRID_CARD_MIN_W;
    return { cardH: Math.round(AUTO_GRID_CARD_H * scale), scale, narrow: true };
  }
  return { cardH: AUTO_GRID_CARD_H, scale: 1, narrow: false };
}
/**
 * 按舞台实际尺寸算出能完整放下的列数/行数。
 * 列数公式与 .feed-list 的 auto-fill 口径一致，避免渲染出放不下的半行；
 * 窄屏时固定竖分三列，行数按缩小后的卡片高度重算。
 */
export function autoGridCapacity(stageW: number, stageH: number): { cols: number; rows: number; count: number } {
  const tile = autoGridTile(stageW);
  if (tile.narrow) {
    const cols = AUTO_GRID_NARROW_COLS;
    const rows = Math.max(1, Math.floor((stageH + AUTO_GRID_GAP) / (tile.cardH + AUTO_GRID_GAP)));
    return { cols, rows, count: cols * rows };
  }
  const cols = Math.max(1, Math.floor((stageW + AUTO_GRID_GAP) / (AUTO_GRID_CARD_MIN_W + AUTO_GRID_GAP)));
  const rows = Math.max(1, Math.floor((stageH + AUTO_GRID_GAP) / (AUTO_GRID_CARD_H + AUTO_GRID_GAP)));
  return { cols, rows, count: cols * rows };
}

/**
 * 自动网格始终取时间倒序列表的前 count 条：最新帖在左上角，其余帖子按
 * 从左到右、从上到下顺排，最早的一条位于最后一个已占用格。新帖到达时
 * React 直接重排整个窗口，不播放动画，也不会循环回绕破坏时间顺序。
 */
export function autoGridWindow<T>(items: T[], count: number): T[] {
  if (items.length === 0 || count <= 0) return [];
  return items.slice(0, count);
}

declare const __APP_VERSION__: string | undefined;
/**
 * 应用版本号：构建时由 build.mjs 经 `git describe` 注入；
 * 未经构建流程（如 artifact 预览）时回退为 "dev"。
 */
export const APP_VERSION =
  typeof __APP_VERSION__ !== "undefined" && __APP_VERSION__ ? __APP_VERSION__ : "dev";

declare const __SITE_NAME__: string | undefined;
/**
 * 网站名：构建时由 build.mjs 从 site.config.json 注入；
 * 未经构建流程（如 artifact 预览）时回退为 "绿野仙踪"。
 */
export const SITE_NAME =
  typeof __SITE_NAME__ !== "undefined" && __SITE_NAME__ ? __SITE_NAME__ : "绿野仙踪";

export interface AppUpdateEnv {
  caches?: { keys(): Promise<string[]>; delete(name: string): Promise<boolean> };
  getServiceWorkerRegistrations?: () => Promise<readonly { unregister(): Promise<boolean> }[]>;
  /**
   * 刷新浏览器 HTTP 缓存中的当前文档。index.html 带有 Cache-Control: max-age，
   * 直接 location.reload() 会命中 HTTP 缓存里的旧 HTML，导致“更新无效”。
   */
  refreshDocument?: () => Promise<void>;
  reload: () => void;
}

/**
 * “版本更新”按钮：清掉全部 Cache Storage 与已注册的 Service Worker，
 * 再强制走网络刷新 HTTP 缓存中的 index.html，最后重载页面，
 * 把应用完整重新下载一遍。
 * 无论清理成败最后都会重载，避免按钮点下没反应。
 */
export async function forceAppUpdate(env: AppUpdateEnv): Promise<void> {
  try {
    if (env.caches) {
      const keys = await env.caches.keys();
      await Promise.all(keys.map((key) => env.caches!.delete(key)));
    }
    if (env.getServiceWorkerRegistrations) {
      const regs = await env.getServiceWorkerRegistrations();
      await Promise.all(regs.map((reg) => reg.unregister()));
    }
    // max-age 下 reload() 会直接命中旧 HTML：先用 cache:"reload" 强制走网络，
    // 把 HTTP 缓存条目更新为最新 index.html，再 reload 才能真正拿到新版本。
    // （SW 已在上一步注销，且 Cache Storage 已清空，即使旧 SW 仍拦截这次
    // fetch 也会因缓存未命中而走网络，request 的 cache 模式会一并透传。）
    if (env.refreshDocument) await env.refreshDocument();
  } catch {
    // 清理失败不阻塞：照样重载，避免按钮点下没反应。
  }
  env.reload();
}

/** forceAppUpdate 在浏览器里的默认环境：Cache Storage + SW 注册表 + HTTP 缓存刷新 + location.reload。 */
export function defaultUpdateEnv(): AppUpdateEnv {
  const inBrowser = typeof window !== "undefined";
  return {
    caches: inBrowser && "caches" in window ? window.caches : undefined,
    getServiceWorkerRegistrations:
      typeof navigator !== "undefined" && "serviceWorker" in navigator
        ? () => navigator.serviceWorker.getRegistrations()
        : undefined,
    refreshDocument:
      inBrowser && typeof window.fetch === "function"
        ? () => window.fetch(window.location.href, { cache: "reload" }).then(() => undefined)
        : undefined,
    reload: () => window.location.reload(),
  };
}

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

const INCOGNITO_MODE_STORAGE_KEY = "nostr-min-incognito-v1";

/** 隐身模式：true = 不自动加载远程头像；缺省 false（普通模式，自动加载）。 */
export function loadIncognitoMode(): boolean {
  try {
    return localStorage.getItem(INCOGNITO_MODE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveIncognitoMode(enabled: boolean): void {
  try {
    localStorage.setItem(INCOGNITO_MODE_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // private mode — keep the choice in memory only
  }
}

// ---- 本地筛选：隐藏回复 / 关键词屏蔽（只看关注已有 全部/关注 标签页）----

export type FeedFilters = {
  hideReplies: boolean;
  mutedKeywords: string[];
};

const FILTERS_STORAGE_KEY = "nostr-min-filters-v1";

const DEFAULT_FILTERS: FeedFilters = { hideReplies: false, mutedKeywords: [] };

export function loadFilters(): FeedFilters {
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_FILTERS, mutedKeywords: [] };
    const parsed = JSON.parse(raw) as Partial<FeedFilters>;
    return {
      hideReplies: parsed.hideReplies === true,
      mutedKeywords: Array.isArray(parsed.mutedKeywords)
        ? parsed.mutedKeywords
            .filter((keyword): keyword is string => typeof keyword === "string" && keyword.trim().length > 0)
            .map((keyword) => keyword.trim())
            .slice(0, 50)
        : [],
    };
  } catch {
    return { ...DEFAULT_FILTERS, mutedKeywords: [] };
  }
}

export function saveFilters(filters: FeedFilters): void {
  try {
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // private mode — keep the choice in memory only
  }
}

/** NIP-10：带有效 e 标签的 kind-1 视为回复（参与了某个帖子串）。 */
export function isReplyEvent(event: NostrEvent): boolean {
  return (event.tags ?? []).some((tag) => tag[0] === "e" && typeof tag[1] === "string" && tag[1].length > 0);
}

export function filtersActive(filters: FeedFilters): boolean {
  return filters.hideReplies || filters.mutedKeywords.length > 0;
}

/**
 * 本地筛选帖子：隐藏回复 / 屏蔽关键词（大小写不敏感的子串匹配）。
 * 纯本地过滤，不改变订阅与网络行为。
 */
export function applyFilters(events: NostrEvent[], filters: FeedFilters): NostrEvent[] {
  if (!filtersActive(filters)) return events;
  const keywords = filters.mutedKeywords.map((keyword) => keyword.toLowerCase());
  return events.filter((event) => {
    if (event.kind === LONGFORM_KIND) {
      // 长文没有回复概念；关键词对标题、摘要、正文都生效。
      if (keywords.length === 0) return true;
      const meta = parseLongformMeta(event);
      const haystack = `${meta.title}\n${meta.summary}\n${event.content}`.toLowerCase();
      return !keywords.some((keyword) => haystack.includes(keyword));
    }
    if (filters.hideReplies && isReplyEvent(event)) return false;
    if (keywords.length > 0) {
      const content = event.content.toLowerCase();
      if (keywords.some((keyword) => content.includes(keyword))) return false;
    }
    return true;
  });
}

/** 作者页历史拉取：每次最多取这么多条，relay 有更多时用 until 分页。 */
export const AUTHOR_HISTORY_LIMIT = 200;

/** 作者历史订阅的过滤器：按作者拉 kind-1；until 用于分页加载更早的帖子。 */
export function buildAuthorHistoryFilter(
  pubkey: string,
  until?: number,
): { kinds: number[]; authors: string[]; limit: number; until?: number } {
  const filter: { kinds: number[]; authors: string[]; limit: number; until?: number } = {
    kinds: [1],
    authors: [pubkey],
    limit: AUTHOR_HISTORY_LIMIT,
  };
  if (typeof until === "number") filter.until = until;
  return filter;
}

/** 合并作者历史帖子：按 id 去重，按时间倒序；不改动传入的数组。 */
export function mergeHistoryEvents(current: NostrEvent[], incoming: NostrEvent[]): NostrEvent[] {
  const seen = new Set<string>();
  const merged: NostrEvent[] = [];
  for (const event of [...current, ...incoming]) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(event);
  }
  merged.sort((a, b) => b.created_at - a.created_at);
  return merged;
}

/** 对话 thread 拉取：每个帖子最多取这么多条直接回复。 */
export const THREAD_REPLIES_LIMIT = 200;

/** Thread 订阅的过滤器：按 e 标签拉指向该帖子的 kind-1 回复。 */
export function buildThreadFilter(eventId: string): { kinds: number[]; "#e": string[]; limit: number } {
  return { kinds: [1], "#e": [eventId], limit: THREAD_REPLIES_LIMIT };
}

/** 合并 thread 回复：按 id 去重，按时间正序（对话从早到晚）；不改动传入的数组。 */
export function mergeThreadEvents(current: NostrEvent[], incoming: NostrEvent[]): NostrEvent[] {
  const seen = new Set<string>();
  const merged: NostrEvent[] = [];
  for (const event of [...current, ...incoming]) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(event);
  }
  merged.sort((a, b) => a.created_at - b.created_at);
  return merged;
}

/** NIP-23 长文事件 kind。 */
export const LONGFORM_KIND = 30023;
/** 长文订阅每源最多取这么多条。 */
export const LONGFORM_LIMIT = 20;
/** 本地缓存的长文上限。 */
export const MAX_LONGFORMS = 40;
const LONGFORM_STORAGE_KEY = "nostr-min-longforms-v1";

export type LongformMeta = {
  title: string;
  summary: string;
  image: string;
  publishedAt: number | null;
  identifier: string;
};

function longformTagValue(event: NostrEvent, name: string): string {
  const tag = event.tags.find((tag) => tag[0] === name && typeof tag[1] === "string");
  return tag?.[1] ?? "";
}

/** NIP-23 长文元数据：从标签取 title / summary / image / published_at / d。 */
export function parseLongformMeta(event: NostrEvent): LongformMeta {
  const publishedRaw = longformTagValue(event, "published_at");
  const publishedNum = publishedRaw ? Number(publishedRaw) : NaN;
  return {
    title: longformTagValue(event, "title"),
    summary: longformTagValue(event, "summary"),
    image: longformTagValue(event, "image"),
    publishedAt: Number.isFinite(publishedNum) ? publishedNum : null,
    identifier: longformTagValue(event, "d"),
  };
}

/** NIP-33 可替换事件键：同 kind + pubkey + d 标签只保留最新一条。 */
export function longformKey(event: NostrEvent): string {
  return `${event.kind}:${event.pubkey}:${longformTagValue(event, "d")}`;
}

/** 合并长文：按 longformKey 去重，同键只保留 created_at 最大的；按时间倒序。 */
export function mergeLongformEvents(current: NostrEvent[], incoming: NostrEvent[]): NostrEvent[] {
  const byKey = new Map<string, NostrEvent>();
  for (const event of [...current, ...incoming]) {
    const key = longformKey(event);
    const existing = byKey.get(key);
    if (!existing || event.created_at > existing.created_at) {
      const relays = existing && event.created_at === existing.created_at
        ? [...new Set([...existing.relays, ...event.relays])]
        : event.relays;
      byKey.set(key, { ...event, relays });
    } else if (!existing.relays.includes(event.relays[0] ?? "")) {
      byKey.set(key, { ...existing, relays: [...existing.relays, ...event.relays] });
    }
  }
  return [...byKey.values()].sort((a, b) => b.created_at - a.created_at);
}

/** 长文摘要：优先用 summary 标签，否则取正文前 140 字。 */
export function longformExcerpt(event: NostrEvent): string {
  const meta = parseLongformMeta(event);
  if (meta.summary) return meta.summary;
  const text = event.content.replace(/\s+/g, " ").trim();
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

export function loadCachedLongforms(): NostrEvent[] {
  try {
    const raw = localStorage.getItem(LONGFORM_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is NostrEvent =>
          !!entry &&
          typeof entry === "object" &&
          (entry as { kind?: unknown }).kind === LONGFORM_KIND &&
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
      .slice(0, MAX_LONGFORMS);
  } catch {
    return [];
  }
}

export function saveCachedLongforms(events: NostrEvent[]): void {
  try {
    localStorage.setItem(LONGFORM_STORAGE_KEY, JSON.stringify(events.slice(0, MAX_LONGFORMS)));
  } catch {
    // quota exceeded or private mode — the live feed still works
  }
}

/** 转义 HTML：渲染器只输出白名单标签，先把原文全部转义再组装。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 只允许 http(s) 链接与图片，其他协议一律按纯文本处理。 */
export function isSafeHttpUrl(url: string): boolean {
  return /^https?:\/\/[^\s"'<>]+$/i.test(url.trim());
}

/** 行内 markdown：行内代码、图片、链接、裸 URL、粗体、斜体。输入须已转义。 */
function renderLongformInline(source: string, allowImages: boolean): string {
  const slots: string[] = [];
  const stash = (html: string): string => {
    slots.push(html);
    return `\ue000${slots.length - 1}\ue000`;
  };
  let out = source;
  // 行内代码优先，避免其中的 markdown 语法被解释。
  out = out.replace(/`([^`\n]+)`/g, (_match, code: string) => stash(`<code>${code}</code>`));
  // 图片：隐身模式下不自动加载，只给链接。
  out = out.replace(/!\[([^\]\n]*)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, (_match, alt: string, url: string) => {
    if (!isSafeHttpUrl(url)) return `![${alt}](${url})`;
    return allowImages
      ? stash(`<img src="${url}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">`)
      : stash(`<a href="${url}" target="_blank" rel="noreferrer">🖼 图片（隐身模式未加载）</a>`);
  });
  // 链接
  out = out.replace(/\[([^\]\n]+)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, (_match, text: string, url: string) => {
    if (!isSafeHttpUrl(url)) return text;
    return stash(`<a href="${url}" target="_blank" rel="noreferrer">${text}</a>`);
  });
  // 裸 URL 自动成链：中英文标点不算 URL 的一部分
  out = out.replace(/(^|[\s（(>])((?:https?:\/\/)[^\s<>"）)。，；：？！、」』\]]+)/gi, (_match, pre: string, url: string) => {
    const clean = url.replace(/[。，；：？！、」』）,.!?;:)\]}]+$/, "");
    const trail = url.slice(clean.length);
    return `${pre}${stash(`<a href="${clean}" target="_blank" rel="noreferrer">${clean}</a>`)}${trail}`;
  });
  // 粗体、斜体
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  return out.replace(/\ue000(\d+)\ue000/g, (_match, index: string) => slots[Number(index)] ?? "");
}

function isLongformBlockStart(line: string): boolean {
  return (
    /^\s*```/.test(line) ||
    /^(#{1,6})\s+/.test(line) ||
    /^\s*([-*_]\s*){3,}$/.test(line) ||
    /^\s*&gt;/.test(line) ||
    /^(\s*)([-*+]|\d+[.)])\s+/.test(line)
  );
}

/**
 * 长文 markdown 子集渲染（标题、分隔线、引用、列表、代码围栏、段落）。
 * 先转义全部 HTML，只输出白名单标签；链接与图片只放行 http(s)。
 * 表格等复杂语法暂不支持，会按段落原文显示。
 */
export function renderMarkdownHtml(source: string, allowImages: boolean): string {
  // 统一换行：CRLF 的 \r 会残留在行尾，而 JS 的 . 不匹配 \r，
  // 会导致带 $ 锚点的块正则失效、行循环无法推进。先全部转成 \n。
  const lines = escapeHtml(source).replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    // 代码围栏
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? "")) {
        code.push(lines[i] ?? "");
        i++;
      }
      i++;
      blocks.push(`<pre><code>${code.join("\n")}</code></pre>`);
      continue;
    }
    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading && heading[1] && heading[2] !== undefined) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderLongformInline(heading[2], allowImages)}</h${level}>`);
      i++;
      continue;
    }
    // 分隔线
    if (/^\s*([-*_]\s*){3,}$/.test(line)) {
      blocks.push("<hr>");
      i++;
      continue;
    }
    // 引用
    if (/^\s*&gt;/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*&gt;/.test(lines[i] ?? "")) {
        quoted.push((lines[i] ?? "").replace(/^\s*&gt;\s?/, ""));
        i++;
      }
      blocks.push(`<blockquote>${renderLongformInline(quoted.join("<br>"), allowImages)}</blockquote>`);
      continue;
    }
    // 列表
    const listMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (listMatch && listMatch[2] && listMatch[3] !== undefined) {
      const ordered = /^\d/.test(listMatch[2]);
      const items: string[] = [];
      let itemMatch: RegExpMatchArray | null;
      while (i < lines.length && (itemMatch = (lines[i] ?? "").match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
        items.push(`<li>${renderLongformInline(itemMatch[3] ?? "", allowImages)}</li>`);
        i++;
      }
      blocks.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    // 空行：段落分隔
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    // 段落：连续非空行合并，行内换行保留为 <br>
    const paragraph: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i] ?? "") && !isLongformBlockStart(lines[i] ?? "")) {
      paragraph.push(lines[i] ?? "");
      i++;
    }
    if (paragraph.length > 0) {
      blocks.push(`<p>${renderLongformInline(paragraph.join("<br>"), allowImages)}</p>`);
    } else {
      // 兜底：任何行都必须推进，避免未知输入造成死循环。
      i++;
    }
  }
  return blocks.join("\n");
}

/** NIP-10 回复标签：e 标签带资讯源提示与 reply 标记，p 标签指向原作者。 */
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

    // Carry the community relay into existing installations without
    // resetting any relay choices the viewer has already saved. The old
    // ws://lulin.org entry is respected as-is — no forced migration.
    if (!valid.some((relay) => relay.url === "wss://lulin.org" || relay.url === "ws://lulin.org")) {
      return [{ url: "wss://lulin.org", enabled: true }, ...valid];
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

export type AvatarDisplay = { kind: "image"; src: string } | { kind: "initials" };

/**
 * 头像展示决策：隐身模式下永远不自动加载远程头像；普通模式仅当资料里有
 * 合法 http(s) 头像地址时才加载，否则显示首字母。
 */
export function avatarDisplay(pubkey: string, cache: Record<string, ProfileEntry>, incognito: boolean): AvatarDisplay {
  if (!incognito) {
    const picture = cache[pubkey]?.profile.picture;
    if (picture && /^https?:\/\//i.test(picture)) return { kind: "image", src: picture };
  }
  return { kind: "initials" };
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

/**
 * 浏览器是否会拦截这个 ws:// 连接（HTTPS 页面中的混合内容）。
 * pageProtocol 仅供测试注入；默认取当前页面的协议。
 */
export function isMixedContentBlocked(url: string, pageProtocol?: string): boolean {
  const protocol = pageProtocol ?? (typeof window === "undefined" ? "" : window.location.protocol);
  return protocol === "https:" && url.startsWith("ws://");
}

/**
 * 把 WebSocket 关闭翻译成中文原因。
 * 浏览器出于安全不暴露网络细节（拒绝 / DNS 失败 / 超时都表现为 code 1006），
 * 只能按“是否曾经连通过”分类给出最可能的原因。
 */
export function describeRelayClose(url: string, code: number, hadOpened: boolean, pageProtocol?: string): string {
  if (!hadOpened && isMixedContentBlocked(url, pageProtocol)) {
    return "浏览器拦截了未加密的 ws:// 连接（混合内容）；HTTPS 页面只能连接 wss://";
  }
  if (code === 1006) {
    return hadOpened ? "连接异常中断（1006）" : "无法建立连接：被拒绝、不可达或超时（1006）";
  }
  if (code === 1015) return "TLS 握手失败（1015）";
  if (code === 1001) return "资讯源主动断开（1001）";
  return `${hadOpened ? "连接关闭" : "连接失败"}（代码 ${code}）`;
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

function Icon({ name }: { name: "relay" | "refresh" | "edit" | "key" | "close" | "plus" | "trash" | "reply" | "download" | "help" | "incognito" | "filter" }) {
  const common = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (name === "relay") return <svg {...common}><circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="12" r="7.5"/><path d="M4.7 4.7 7 7M17 17l2.3 2.3M19.3 4.7 17 7M7 17l-2.3 2.3"/></svg>;
  if (name === "refresh") return <svg {...common}><path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M18.2 9A7 7 0 0 0 6.4 6.4L4 11M20 13l-2.4 4.6A7 7 0 0 1 5.8 15"/></svg>;
  if (name === "edit") return <svg {...common}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>;
  if (name === "key") return <svg {...common}><circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M15 8l2 2M17 6l2 2"/></svg>;
  if (name === "close") return <svg {...common}><path d="m6 6 12 12M18 6 6 18"/></svg>;
  if (name === "plus") return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>;
  if (name === "reply") return <svg {...common}><path d="M8 7 3 12l5 5"/><path d="M3 12h11a7 7 0 0 1 7 7v1"/></svg>;
  if (name === "download") return <svg {...common}><path d="M12 4v10"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>;
  if (name === "help") return <svg {...common}><circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.6a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1.1.9-1.1 1.9"/><path d="M12 17h.01"/></svg>;
  if (name === "incognito") return <svg {...common}><path d="M3 3l18 18"/><path d="M10.6 5.2A10.6 10.6 0 0 1 12 5c7 0 10 7 10 7a17 17 0 0 1-2.9 3.9"/><path d="M6.6 6.6A16.5 16.5 0 0 0 2 12s3 7 10 7c1.5 0 2.9-.3 4.1-.8"/></svg>;
  if (name === "filter") return <svg {...common}><path d="M4 5h16l-6.2 7.2V19l-3.6 2v-8.8L4 5z"/></svg>;
  return <svg {...common}><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>;
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

/** 远程头像展示：隐身模式只显示首字母，普通模式自动加载资料头像。 */
function AvatarMark({ pubkey, profileCache, incognito, large, onClick, ariaLabel }: {
  pubkey: string;
  profileCache: Record<string, ProfileEntry>;
  incognito: boolean;
  large?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const display = avatarDisplay(pubkey, profileCache, incognito);
  const inner = display.kind === "image"
    ? <img src={display.src} alt="" loading="lazy" referrerPolicy="no-referrer" />
    : <>{pubkey.slice(0, 2).toUpperCase()}</>;
  const className = `avatar-mark${large ? " large-avatar" : ""}`;
  if (onClick) return <button className={className} onClick={onClick} aria-label={ariaLabel}>{inner}</button>;
  return <span className={className}>{inner}</span>;
}

/** 帖子卡片的共享主体：手动网格与自动网格共用，页脚带回复按钮。 */
function LongformCard({ item, profileCache, incognito, onOpenProfile, onOpen }: {
  item: NostrEvent;
  profileCache: Record<string, ProfileEntry>;
  incognito: boolean;
  onOpenProfile: (pubkey: string) => void;
  onOpen: (event: NostrEvent) => void;
}) {
  const meta = parseLongformMeta(item);
  const publishedAt = meta.publishedAt ?? item.created_at;
  return (
    <>
      <div className="note-meta">
        <AvatarMark
          pubkey={item.pubkey}
          profileCache={profileCache}
          incognito={incognito}
          onClick={() => onOpenProfile(item.pubkey)}
          ariaLabel={`查看作者 ${profileName(item.pubkey, profileCache)}`}
        />
        <button className="author" onClick={() => onOpenProfile(item.pubkey)} title={item.pubkey}>{profileName(item.pubkey, profileCache)}</button>
        <time dateTime={new Date(publishedAt * 1000).toISOString()}>{relativeTime(publishedAt)}</time>
        <span className="longform-badge">长文</span>
      </div>
      <button className="longform-open" onClick={() => onOpen(item)} aria-label={`阅读长文 ${meta.title || "无标题"}`}>
        <strong>{meta.title || "（无标题）"}</strong>
        <span>{longformExcerpt(item) || "（空）"}</span>
      </button>
      <div className="note-footer">
        <span className="note-relays" title={item.relays.join("\n")}><span className="tiny-signal" />{item.relays.length === 1 ? relayLabel(item.relays[0] ?? "") : `${item.relays.length} 个资讯源`}</span>
      </div>
    </>
  );
}

function NoteCard({ item, profileCache, incognito, onOpenProfile, onOpenNote, onReply }: {
  item: NostrEvent;
  profileCache: Record<string, ProfileEntry>;
  incognito: boolean;
  onOpenProfile: (pubkey: string) => void;
  onOpenNote: (eventId: string) => void;
  onReply: (item: NostrEvent) => void;
}) {
  return (
    <>
      <div className="note-meta">
        <AvatarMark
          pubkey={item.pubkey}
          profileCache={profileCache}
          incognito={incognito}
          onClick={() => onOpenProfile(item.pubkey)}
          ariaLabel={`查看作者 ${profileName(item.pubkey, profileCache)}`}
        />
        <button className="author" onClick={() => onOpenProfile(item.pubkey)} title={item.pubkey}>{profileName(item.pubkey, profileCache)}</button>
        <time dateTime={new Date(item.created_at * 1000).toISOString()}>{relativeTime(item.created_at)}</time>
      </div>
      <button className="note-open" onClick={() => onOpenNote(item.id)} aria-label={`查看帖子 ${shortKey(encodeNip19("note", item.id))}`}>
        <ClampedNote content={item.content} />
      </button>
      <div className="note-footer">
        <span className="note-relays" title={item.relays.join("\n")}><span className="tiny-signal" />{item.relays.length === 1 ? relayLabel(item.relays[0] ?? "") : `${item.relays.length} 个资讯源`}</span>
        <span className="note-actions">
          <button className="reply-button" onClick={() => onReply(item)} aria-label={`回复 ${profileName(item.pubkey, profileCache)}`}><Icon name="reply" />回复</button>
          <button className="view-detail" onClick={() => onOpenNote(item.id)}>查看详情 →</button>
        </span>
      </div>
    </>
  );
}


export function App() {
  const [relays, setRelays] = useState<RelayConfig[]>(loadRelays);
  const [relayStates, setRelayStates] = useState<Record<string, RelayState>>({});
  const [relayProblems, setRelayProblems] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<NostrEvent[]>(loadCachedEvents);
  const [longforms, setLongforms] = useState<NostrEvent[]>(loadCachedLongforms);
  const [longformDetailId, setLongformDetailId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
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
  const [authorHistory, setAuthorHistory] = useState<AuthorHistory | null>(null);
  const authorHistoryRef = useRef<AuthorHistoryRequest | null>(null);
  const [threadReplies, setThreadReplies] = useState<ThreadReplies | null>(null);
  const threadRequestRef = useRef<ThreadRequest | null>(null);
  // 钻取回复时详情可能指向主 events 之外的事件，这里缓存所有见过的 thread 回复供详情查找。
  const seenThreadEventsRef = useRef(new Map<string, NostrEvent>());
  const [copyMessage, setCopyMessage] = useState("");
  const [profileCache, setProfileCache] = useState<Record<string, ProfileEntry>>(loadProfileCache);
  const [follows, setFollows] = useState<string[]>(() => loadStoredFollows(null));
  const [feedTab, setFeedTab] = useState<"all" | "longform" | "following">("all");
  const [followsOpen, setFollowsOpen] = useState(false);
  const [followMessage, setFollowMessage] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(loadViewMode);
  const [incognitoMode, setIncognitoMode] = useState<boolean>(loadIncognitoMode);
  const [filters, setFilters] = useState<FeedFilters>(loadFilters);
  const [filterOpen, setFilterOpen] = useState(false);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [manualEvents, setManualEvents] = useState<NostrEvent[]>(() => loadCachedEvents());
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
  const longformsRef = useRef(longforms);
  longformsRef.current = longforms;
  const lastLongformPersistRef = useRef(0);

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

  // 长文缓存与主时间线分开存，离线也能看已收到的长文。
  useEffect(() => {
    const now = Date.now();
    if (now - lastLongformPersistRef.current < 3000) return;
    lastLongformPersistRef.current = now;
    saveCachedLongforms(longforms);
  }, [longforms]);

  useEffect(() => {
    const flush = () => saveCachedLongforms(longformsRef.current);
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  const enabledRelays = useMemo(() => relays.filter((relay) => relay.enabled), [relays]);
  const onlineCount = enabledRelays.filter((relay) => relayStates[relay.url] === "online").length;
  // 详情既可能来自主时间线，也可能来自手动模式的冻结快照（manualEvents），
  // 还可能来自某条回复的钻取（thread 回复不在主 events 里）。
  const detailEvent = detailEventId
    ? events.find((event) => event.id === detailEventId)
      ?? manualEvents.find((event) => event.id === detailEventId)
      ?? seenThreadEventsRef.current.get(detailEventId)
      ?? null
    : null;
  const profileEvents = useMemo(() => {
    if (!profilePubkey) return [];
    const history = authorHistory && authorHistory.pubkey === profilePubkey ? authorHistory.events : [];
    const fromFeed = events.filter((event) => event.pubkey === profilePubkey);
    return mergeHistoryEvents(history, fromFeed);
  }, [profilePubkey, events, authorHistory]);
  const feedEvents = viewMode === "manual" ? manualEvents : events;
  const visibleEvents = feedTab === "following" ? feedEvents.filter((event) => follows.includes(event.pubkey)) : feedEvents;
  // 本地筛选（隐藏回复 / 关键词屏蔽）：只影响展示，不改变订阅。
  const displayEvents = useMemo(() => applyFilters(visibleEvents, filters), [visibleEvents, filters]);
  const hiddenByFilters = visibleEvents.length - displayEvents.length;
  // 长文列表：独立订阅、独立展示，关键词筛选对标题/摘要/正文生效。
  const longformDisplay = useMemo(() => applyFilters(longforms, filters), [longforms, filters]);
  const longformDetail = longformDetailId ? longforms.find((event) => event.id === longformDetailId) ?? null : null;
  const longformDetailMeta = longformDetail ? parseLongformMeta(longformDetail) : null;
  const longformDetailHtml = useMemo(
    () => (longformDetail ? renderMarkdownHtml(longformDetail.content, !incognitoMode) : ""),
    [longformDetail, incognitoMode],
  );
  const manualIds = useMemo(() => new Set(manualEvents.map((event) => event.id)), [manualEvents]);
  const manualPendingCount = events.reduce((count, event) => count + (manualIds.has(event.id) ? 0 : 1), 0);

  // 自动网格保持严格时间倒序：最新在左上角，之后从左到右、从上到下。
  // 视口只显示能完整容纳的格数；新帖到达时列表原地重排，不做动画或循环轮换。
  const [gridCapacity, setGridCapacity] = useState(() => autoGridCapacity(960, 700));
  const [gridTile, setGridTile] = useState<AutoGridTile>(() => autoGridTile(960));
  const autoGridWrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (viewMode !== "auto") return;
    const el = autoGridWrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      setGridCapacity(autoGridCapacity(w, el.clientHeight));
      setGridTile(autoGridTile(w));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [viewMode]);
  const autoGridItems = autoGridWindow(displayEvents, gridCapacity.count);


  // 浏览模式持久化；切到手动模式时冻结当前快照。
  useEffect(() => {
    saveViewMode(viewMode);
  }, [viewMode]);

  // 网站名是可配置项（site.config.json）：运行时写入 document.title。
  useEffect(() => {
    document.title = SITE_NAME;
  }, []);

  // 隐身模式持久化：缺省普通模式（自动加载头像）。
  useEffect(() => {
    saveIncognitoMode(incognitoMode);
  }, [incognitoMode]);

  // 筛选条件持久化。
  useEffect(() => {
    saveFilters(filters);
  }, [filters]);

  useEffect(() => {
    if (viewMode === "manual") setManualEvents(eventsRef.current);
  }, [viewMode]);

  function refreshManualFeed() {
    setManualEvents(eventsRef.current);
    setConnectionEpoch((value) => value + 1);
  }
  const profileEntry = profilePubkey ? profileCache[profilePubkey] : undefined;
  const profileDetail = profileEntry?.profile;
  const externalProfilePicture = profileDetail?.picture && /^https?:\/\//i.test(profileDetail.picture) ? profileDetail.picture : null;
  const isFollowing = profilePubkey ? follows.includes(profilePubkey) : false;

  function openNote(eventId: string) {
    setProfilePubkey(null);
    setDetailEventId(eventId);
    setCopyMessage("");
    requestThreadReplies(eventId);
  }

  function addMutedKeyword() {
    const keyword = keywordDraft.trim();
    if (!keyword) return;
    setFilters((prev) =>
      prev.mutedKeywords.some((existing) => existing.toLowerCase() === keyword.toLowerCase())
        ? prev
        : { ...prev, mutedKeywords: [...prev.mutedKeywords, keyword].slice(0, 50) },
    );
    setKeywordDraft("");
  }

  function removeMutedKeyword(keyword: string) {
    setFilters((prev) => ({ ...prev, mutedKeywords: prev.mutedKeywords.filter((existing) => existing !== keyword) }));
  }

  function clearFilters() {
    setFilters({ hideReplies: false, mutedKeywords: [] });
  }

  function openProfile(key: string) {
    setDetailEventId(null);
    setProfilePubkey(key);
    setCopyMessage("");
    requestAuthorHistory(key);
  }

  function closeAuthorHistorySubs(): void {
    const request = authorHistoryRef.current;
    if (!request) return;
    for (const subId of request.subIds) {
      for (const socket of socketsRef.current.values()) {
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(JSON.stringify(["CLOSE", subId]));
          } catch {
            // Ignore close failures; the relay will time the sub out.
          }
        }
      }
    }
    authorHistoryRef.current = null;
  }

  /** 作者页打开后单独订阅该作者的 kind-1；until 用于分页加载更早。 */
  function requestAuthorHistory(pubkey: string, until?: number): void {
    closeAuthorHistorySubs();
    const mode = typeof until === "number" ? "more" : "initial";
    if (mode === "initial") {
      setAuthorHistory({ pubkey, events: [], loading: true, loadingMore: false, hasMore: false });
    } else {
      setAuthorHistory((prev) => (prev && prev.pubkey === pubkey ? { ...prev, loadingMore: true } : prev));
    }
    const filter = buildAuthorHistoryFilter(pubkey, until);
    const subIds = new Set<string>();
    const counts = new Map<string, number>();
    for (const socket of socketsRef.current.values()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const subId = `author-${createUuid().slice(0, 8)}`;
      try {
        socket.send(JSON.stringify(["REQ", subId, filter]));
        subIds.add(subId);
        counts.set(subId, 0);
      } catch {
        // Skip a socket that refuses the request.
      }
    }
    const request: AuthorHistoryRequest = { pubkey, subIds, counts, mode };
    authorHistoryRef.current = request;
    if (subIds.size === 0) {
      finishAuthorHistory(pubkey);
      return;
    }
    // 兜底：个别资讯源不回 EOSE 时，15 秒后也结束 loading，避免一直转圈。
    window.setTimeout(() => {
      if (authorHistoryRef.current === request) finishAuthorHistory(pubkey);
    }, 15000);
  }

  /** 收齐（或超时）后结束一次作者历史请求；有源返回满 limit 即认为还有更早。 */
  function finishAuthorHistory(pubkey: string): void {
    const request = authorHistoryRef.current;
    if (!request || request.pubkey !== pubkey) return;
    const hitLimit = [...request.counts.values()].some((count) => count >= AUTHOR_HISTORY_LIMIT);
    authorHistoryRef.current = null;
    setAuthorHistory((prev) =>
      prev && prev.pubkey === pubkey
        ? { ...prev, loading: false, loadingMore: false, hasMore: prev.hasMore || hitLimit }
        : prev,
    );
  }

  // 作者页关闭时收回历史订阅并清空历史，避免后台继续收该作者的事件。
  useEffect(() => {
    if (profilePubkey) return;
    closeAuthorHistorySubs();
    setAuthorHistory(null);
  }, [profilePubkey]);

  /** 「加载更早」：以当前最老一条的 created_at 为 until 继续往前翻。 */
  function loadMoreAuthorHistory(): void {
    if (!profilePubkey) return;
    const oldest = profileEvents.length > 0 ? profileEvents[profileEvents.length - 1] : undefined;
    if (oldest) requestAuthorHistory(profilePubkey, oldest.created_at - 1);
  }

  function closeThreadSubs(): void {
    const request = threadRequestRef.current;
    if (!request) return;
    for (const subId of request.subIds) {
      for (const socket of socketsRef.current.values()) {
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(JSON.stringify(["CLOSE", subId]));
          } catch {
            // Ignore close failures; the relay will time the sub out.
          }
        }
      }
    }
    threadRequestRef.current = null;
  }

  /** 帖子详情打开后单独订阅指向它的 kind-1 回复（e 标签）。 */
  function requestThreadReplies(eventId: string): void {
    closeThreadSubs();
    setThreadReplies({ eventId, events: [], loading: true });
    const filter = buildThreadFilter(eventId);
    const subIds = new Set<string>();
    for (const socket of socketsRef.current.values()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const subId = `thread-${createUuid().slice(0, 8)}`;
      try {
        socket.send(JSON.stringify(["REQ", subId, filter]));
        subIds.add(subId);
      } catch {
        // Skip a socket that refuses the request.
      }
    }
    const request: ThreadRequest = { eventId, subIds };
    threadRequestRef.current = request;
    if (subIds.size === 0) {
      finishThreadReplies(eventId);
      return;
    }
    // 兜底：个别资讯源不回 EOSE 时，15 秒后也结束 loading，避免一直转圈。
    window.setTimeout(() => {
      if (threadRequestRef.current === request) finishThreadReplies(eventId);
    }, 15000);
  }

  /** 收齐（或超时）后结束一次 thread 拉取。 */
  function finishThreadReplies(eventId: string): void {
    const request = threadRequestRef.current;
    if (!request || request.eventId !== eventId) return;
    threadRequestRef.current = null;
    setThreadReplies((prev) => (prev && prev.eventId === eventId ? { ...prev, loading: false } : prev));
  }

  // 帖子详情关闭时收回 thread 订阅并清空回复，避免后台继续收该帖的事件。
  useEffect(() => {
    if (detailEventId) return;
    closeThreadSubs();
    setThreadReplies(null);
    seenThreadEventsRef.current.clear();
  }, [detailEventId]);

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

  /** 长文入库：NIP-33 可替换语义，同 kind+pubkey+d 只保留最新版。 */
  const addLongformEvent = useCallback((incoming: SignedEvent, relayUrl: string) => {
    setLongforms((current) =>
      mergeLongformEvents(current, [{ ...incoming, relays: [relayUrl] }]).slice(0, MAX_LONGFORMS),
    );
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
  const wantedAuthors = useMemo(() => [...new Set([
    ...events.map((event) => event.pubkey),
    ...(threadReplies?.events.map((event) => event.pubkey) ?? []),
  ])], [events, threadReplies]);
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
      setRelayProblems({});
      setNetworkMessage(active.length === 0 ? "请至少启用一个资讯源。" : "");

      // 本轮连接中曾经成功打开过的资讯源（用于把关闭翻译成准确的原因）。
      const opened = new Set<string>();

      for (const relay of active) {
        const subId = `feed-${createUuid().slice(0, 8)}`;
        const longformSubId = `longform-${createUuid().slice(0, 8)}`;
        try {
          const socket = new WebSocket(relay.url);
          socketsRef.current.set(relay.url, socket);
          // 15 秒还没握手成功就判超时：浏览器不会自己报连接超时。
          const connectTimer = window.setTimeout(() => {
            if (socket.readyState === WebSocket.CONNECTING) {
              setRelayStates((current) => ({ ...current, [relay.url]: "offline" }));
              setRelayProblems((current) => ({ ...current, [relay.url]: "连接超时（15 秒无响应）" }));
              socket.close();
            }
          }, 15000);
          socket.onopen = () => {
            window.clearTimeout(connectTimer);
            opened.add(relay.url);
            setRelayProblems((current) => {
              if (!(relay.url in current)) return current;
              const next = { ...current };
              delete next[relay.url];
              return next;
            });
            setRelayStates((current) => ({ ...current, [relay.url]: "online" }));
            socket.send(JSON.stringify(["REQ", subId, { kinds: [1], limit: 60 }]));
            socket.send(JSON.stringify(["REQ", longformSubId, { kinds: [LONGFORM_KIND], limit: LONGFORM_LIMIT }]));
          };
          socket.onmessage = (message) => {
            try {
              const frame: unknown = JSON.parse(String(message.data));
              if (!Array.isArray(frame)) return;
              if (frame[0] === "EVENT" && typeof frame[1] === "string") {
                const incoming = frame[2];
                const historyRequest = authorHistoryRef.current;
                if (historyRequest && historyRequest.subIds.has(frame[1]) && isNostrEvent(incoming, 1)) {
                  historyRequest.counts.set(frame[1], (historyRequest.counts.get(frame[1]) ?? 0) + 1);
                  const historyEvent: NostrEvent = { ...incoming, relays: [relay.url] };
                  const wanted = historyRequest.pubkey;
                  setAuthorHistory((prev) => (prev && prev.pubkey === wanted
                    ? { ...prev, events: mergeHistoryEvents(prev.events, [historyEvent]) }
                    : prev));
                } else if (frame[1] === subId && isNostrEvent(incoming, 1)) {
                  addIncomingEvent(incoming, relay.url);
                } else if (frame[1] === longformSubId && isNostrEvent(incoming, LONGFORM_KIND)) {
                  addLongformEvent(incoming, relay.url);
                } else if (profileSubsRef.current.has(frame[1]) && isNostrEvent(incoming, 0)) {
                  addProfile(incoming);
                } else if (frame[1] === contactSubRef.current && isNostrEvent(incoming, 3)) {
                  addContactList(incoming);
                } else {
                  const threadRequest = threadRequestRef.current;
                  if (threadRequest && threadRequest.subIds.has(frame[1]) && isNostrEvent(incoming, 1)) {
                    const threadEvent: NostrEvent = { ...incoming, relays: [relay.url] };
                    const wanted = threadRequest.eventId;
                    seenThreadEventsRef.current.set(threadEvent.id, threadEvent);
                    setThreadReplies((prev) => (prev && prev.eventId === wanted
                      ? { ...prev, events: mergeThreadEvents(prev.events, [threadEvent]) }
                      : prev));
                  }
                }
              }
              if (frame[0] === "EOSE" && typeof frame[1] === "string") {
                const historyRequest = authorHistoryRef.current;
                if (historyRequest && historyRequest.subIds.has(frame[1])) {
                  historyRequest.subIds.delete(frame[1]);
                  if (historyRequest.subIds.size === 0) finishAuthorHistory(historyRequest.pubkey);
                }
                const threadRequest = threadRequestRef.current;
                if (threadRequest && threadRequest.subIds.has(frame[1])) {
                  threadRequest.subIds.delete(frame[1]);
                  if (threadRequest.subIds.size === 0) finishThreadReplies(threadRequest.eventId);
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
          // 注意：onerror 不携带错误细节（浏览器安全限制），关闭原因统一在 onclose 里按 code 分类。
          socket.onclose = (event) => {
            window.clearTimeout(connectTimer);
            setRelayStates((current) => ({ ...current, [relay.url]: "offline" }));
            setRelayProblems((current) => ({ ...current, [relay.url]: describeRelayClose(relay.url, event.code, opened.has(relay.url)) }));
          };
        } catch (error) {
          setRelayStates((current) => ({ ...current, [relay.url]: "offline" }));
          setRelayProblems((current) => ({ ...current, [relay.url]: error instanceof Error ? `地址无效：${error.message}` : "地址无效" }));
        }
      }
    }, 500);

    return () => {
      window.clearTimeout(timeout);
      for (const socket of socketsRef.current.values()) socket.close();
      socketsRef.current.clear();
    };
  }, [relays, connectionEpoch, addIncomingEvent, addLongformEvent]);

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
      setNetworkMessage("当前没有在线资讯源，无法发布。请检查资讯源面板后重试。");
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
        setFollowMessage(following ? "已取消关注，关注列表已发布到资讯源。" : "已关注，关注列表已发布到资讯源。");
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
      setRelayError("请输入有效的 wss:// 或 ws:// 资讯源地址。");
      return;
    }
    if (relays.some((relay) => relay.url === normalized)) {
      setRelayError("这个资讯源已经在列表中。");
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
        <button className="relay-summary" onClick={() => setPanelOpen(true)} aria-label="打开资讯中继管理" title="打开资讯中继管理">
          <span className={`signal ${onlineCount > 0 ? "signal-live" : ""}`} />
          <span>{onlineCount}/{enabledRelays.length} 中继在线</span>
        </button>
        <div className="utility-actions">
          <button
            className={`icon-button${incognitoMode ? " active" : ""}`}
            onClick={() => setIncognitoMode((enabled) => !enabled)}
            aria-pressed={incognitoMode}
            aria-label={incognitoMode ? "关闭隐身模式（恢复自动加载头像）" : "打开隐身模式（不自动加载头像）"}
            title={incognitoMode ? "隐身模式：不自动加载远程头像" : "普通模式：自动加载远程头像"}
          >
            <Icon name="incognito" />
          </button>
          <button
            className={`icon-button${filtersActive(filters) ? " active" : ""}`}
            onClick={() => setFilterOpen(true)}
            aria-label="筛选帖子"
            title={filtersActive(filters) ? "筛选已开启：隐藏回复 / 屏蔽关键词" : "筛选帖子：隐藏回复、屏蔽关键词"}
          >
            <Icon name="filter" />
          </button>
          <button className="icon-button" onClick={() => setHelpOpen(true)} aria-label="使用说明" title="使用说明"><Icon name="help" /></button>
          <button className="icon-button" onClick={() => void forceAppUpdate(defaultUpdateEnv())} aria-label="版本更新，重新下载" title="版本更新，重新下载"><Icon name="download" /></button>
          <button className="icon-button" onClick={viewMode === "manual" ? refreshManualFeed : () => setConnectionEpoch((value) => value + 1)} aria-label={viewMode === "manual" ? "手动刷新帖子" : "重新连接资讯源"} title={viewMode === "manual" ? "手动刷新帖子" : "重新连接资讯源"}><Icon name="refresh" /></button>
          <button className="identity-button" onClick={() => void connectSigner()} aria-label={pubkey ? "查看已连接身份" : "连接 NIP-07 签名器"} title={pubkey ? "查看已连接身份" : "连接 NIP-07 签名器"}>
            <Icon name="key" />
            <span>{pubkey ? shortKey(pubkey) : "连接签名器"}</span>
          </button>
        </div>
      </header>

      <main className={`feed-column${viewMode === "auto" ? " auto-feed" : ""}`}>
        <section className="feed-intro" aria-labelledby="feed-heading">
          <div>
            <p className="section-index">PUBLIC NOTES / KIND 1</p>
            <h1 id="feed-heading">{SITE_NAME} <small className="app-version">{APP_VERSION}</small></h1>
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
          <button role="tab" aria-selected={feedTab === "longform"} className={`feed-tab${feedTab === "longform" ? " active" : ""}`} onClick={() => setFeedTab("longform")}>长文{longforms.length > 0 ? ` · ${longforms.length}` : ""}</button>
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

        {feedTab === "longform" ? (
          longformDisplay.length === 0 ? (
            <section className="empty-state">
              <div className="empty-signal"><span /><span /><span /></div>
              <h2>还没有收到长文</h2>
              <p>{onlineCount > 0 ? "连接已建立，资讯源里的长文会显示在这里。" : "还没有连上资讯源，打开资讯源面板检查连接。"}</p>
              {onlineCount === 0 && <button onClick={() => setPanelOpen(true)}>管理资讯源</button>}
            </section>
          ) : (
            <ol className="feed-list longform-list" aria-live="polite">
              {longformDisplay.map((item) => (
                <li className="note longform-note" key={item.id}>
                  <LongformCard item={item} profileCache={profileCache} incognito={incognitoMode} onOpenProfile={openProfile} onOpen={(event) => setLongformDetailId(event.id)} />
                </li>
              ))}
            </ol>
          )
        ) : displayEvents.length === 0 ? (
          <section className="empty-state">
            <div className="empty-signal"><span /><span /><span /></div>
            <h2>{hiddenByFilters > 0 ? "筛选隐藏了全部帖子" : feedTab === "following" ? "还没有关注的人" : onlineCount > 0 ? "正在等待帖子" : "还没有连上资讯源"}</h2>
            <p>{hiddenByFilters > 0 ? `${hiddenByFilters} 条帖子被当前筛选条件隐藏。` : feedTab === "following" ? "在帖子或作者页点「关注」，这里只显示你关注的人的帖子。" : onlineCount > 0 ? "连接已建立，新帖子会直接出现在这里。" : "打开资讯源面板查看每个地址的状态，或添加一个可用资讯源。"}</p>
            <button onClick={() => hiddenByFilters > 0 ? setFilters({ hideReplies: false, mutedKeywords: [] }) : feedTab === "following" ? setFeedTab("all") : onlineCount > 0 ? (viewMode === "manual" ? refreshManualFeed() : setConnectionEpoch((value) => value + 1)) : setPanelOpen(true)}>
              {hiddenByFilters > 0 ? "清除筛选" : feedTab === "following" ? "浏览全部帖子" : onlineCount > 0 ? (viewMode === "manual" ? "手动刷新" : "重新订阅") : "管理资讯源"}
            </button>
          </section>
        ) : viewMode === "manual" ? (
          <ol className="feed-list" aria-live="polite">
            {displayEvents.map((item) => (
              <li className="note" key={item.id}>
                <NoteCard item={item} profileCache={profileCache} incognito={incognitoMode} onOpenProfile={openProfile} onOpenNote={openNote} onReply={openReply} />
              </li>
            ))}
          </ol>
        ) : (
          <section className="auto-stage" aria-label="帖子自动网格">
            <div className="auto-grid-wrap" ref={autoGridWrapRef}>
              <ol
                className={`feed-list auto-grid${gridTile.narrow ? " narrow" : ""}`}
                style={gridTile.narrow ? {
                  gridTemplateColumns: `repeat(${AUTO_GRID_NARROW_COLS}, minmax(0, 1fr))`,
                  "--auto-card-h": `${gridTile.cardH}px`,
                  "--auto-scale": String(gridTile.scale),
                } as CSSProperties : undefined}
              >
                {autoGridItems.map((item) => (
                  <li className="note" key={item.id}>
                    <NoteCard item={item} profileCache={profileCache} incognito={incognitoMode} onOpenProfile={openProfile} onOpenNote={openNote} onReply={openReply} />
                  </li>
                ))}
              </ol>
            </div>
            <div className="auto-bar">
              <span className="auto-count">{displayEvents.length} 条帖子{hiddenByFilters > 0 ? `（${hiddenByFilters} 条被筛选隐藏）` : ""}</span>
              <span className="auto-hint">新帖自动进入左上角</span>
            </div>
          </section>
        )}
      </main>

      <button className="compose-fab" onClick={() => { setReplyTarget(null); setDraft(""); setComposerOpen(true); }} aria-label="发帖子"><Icon name="edit" /></button>

      {panelOpen && (
        <div className="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPanelOpen(false); }}>
          <aside className="relay-sheet" aria-label="资讯中继管理" role="dialog" aria-modal="true">
            <div className="sheet-heading">
              <div><p className="section-index">SOURCE POOL</p><h2>资讯中继管理</h2></div>
              <button className="icon-button" onClick={() => setPanelOpen(false)} aria-label="关闭资讯中继管理"><Icon name="close" /></button>
            </div>
            <p className="sheet-copy">支持加密的 wss:// 与不加密的 ws:// 资讯源；修改后会自动重连。</p>
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
                  <span className={`status-dot ${relay.enabled ? relayStates[relay.url] ?? "connecting" : "offline"}`} aria-label={relay.enabled ? relayStates[relay.url] ?? "连接中" : "已停用"} title={relayProblems[relay.url] ?? ""} />
                  <button className="trash-button" onClick={() => setRelays((current) => current.filter((item) => item.url !== relay.url))} aria-label={`删除 ${relay.url}`}><Icon name="trash" /></button>
                  {relayProblems[relay.url] && (
                    <p className="relay-problem" role="status">{relayProblems[relay.url]}</p>
                  )}
                </li>
              ))}
            </ul>
            <form className="add-relay" onSubmit={addRelay}>
              <label htmlFor="new-relay">添加资讯源</label>
              <div><input id="new-relay" value={newRelay} onChange={(event) => setNewRelay(event.target.value)} placeholder="wss:// 或 ws://" inputMode="url" autoCapitalize="none" autoCorrect="off" /><button type="submit" aria-label="添加资讯源"><Icon name="plus" /></button></div>
              <p className="field-hint">在 HTTPS 页面中，浏览器可能会拦截不加密的 ws:// 连接；客户端仍会保留该资讯源并显示实际连接状态。</p>
              {relayError && <p className="field-error">{relayError}</p>}
            </form>
          </aside>
        </div>
      )}

      {helpOpen && (
        <div className="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setHelpOpen(false); }}>
          <aside className="relay-sheet" aria-label="使用说明" role="dialog" aria-modal="true">
            <div className="sheet-heading">
              <div><p className="section-index">GUIDE</p><h2>使用说明</h2></div>
              <button className="icon-button" onClick={() => setHelpOpen(false)} aria-label="关闭使用说明"><Icon name="close" /></button>
            </div>
            <div className="help-body">
              <p>{SITE_NAME}是一个极简的 Nostr 帖子浏览器，从多个资讯源拉取公开帖子，去重后展示。你的私钥永远不会经过页面。</p>
              <h3>自动模式</h3>
              <p>帖子按时间倒序铺成固定网格：新帖子进入第一排第一列，其余内容依次向右、向下顺移，最早的一条在最后一格。页面不滚动，也没有切换动画。手机等窄屏上会自动竖分三列、整块等比缩小，点小块进入详情。</p>
              <h3>手动模式</h3>
              <p>自由滚动浏览全部帖子，点「刷新」获取新帖子。浏览模式的选择会自动记住。</p>
              <h3>资讯源</h3>
              <p>点左上角的在线状态打开资讯中继管理：可以开关、添加、删除地址，支持加密的 wss:// 与不加密的 ws://，修改后自动重连。连接失败时会在该资讯源下方显示原因（如被浏览器拦截、超时等）。</p>
              <h3>发帖与回复</h3>
              <p>需要浏览器安装 NIP-07 签名器（如 nos2x、Alby），点右上角钥匙图标连接。发帖和回复都经签名器签名后发布。点帖子进入详情可以看到它的对话：下面的回复按时间正序排列，点某条回复可以继续钻进去看它的回复。</p>
              <h3>关注</h3>
              <p>在帖子或作者页点「关注」，「关注」标签页只显示你关注的人的帖子。打开作者页会自动向资讯源拉取他的历史帖子（每次最多 200 条），点「加载更早」可继续往前翻，能拉多少取决于资讯源保留了多少。</p>
              <h3>长文</h3>
              <p>「长文」标签页显示资讯源里的 NIP-23 长文（kind 30023），每源最多取 20 篇；同作者同标识的长文只保留最新版。点卡片进入全文阅读，支持标题、粗斜体、链接、列表、引用、代码块等排版，表格暂不支持。隐身模式下文章内的图片不会自动加载。</p>
              <h3>筛选</h3>
              <p>点标题栏的漏斗图标打开筛选：可以隐藏回复、按关键词屏蔽帖子，只影响本机展示，不改变订阅。只看关注的人请用「全部 / 关注」标签页。筛选条件会自动记住。</p>
              <h3>版本更新</h3>
              <p>点标题栏的下载图标会清空本地缓存并重新下载最新版，页面会自动重载。</p>
              <h3>离线使用</h3>
              <p>页面加载一次后会被完整缓存，断网或关闭浏览器后重新打开也能继续使用。</p>
              <h3>隐身模式</h3>
              <p>点标题栏的面具图标打开隐身模式：远程头像不再自动加载，只显示首字母，避免向头像服务器暴露你的浏览行为。缺省是普通模式，头像自动加载。选择会自动记住。</p>
            </div>
          </aside>
        </div>
      )}

      {filterOpen && (
        <div className="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setFilterOpen(false); }}>
          <aside className="relay-sheet" aria-label="筛选帖子" role="dialog" aria-modal="true">
            <div className="sheet-heading">
              <div><p className="section-index">FILTERS</p><h2>筛选</h2></div>
              <button className="icon-button" onClick={() => setFilterOpen(false)} aria-label="关闭筛选"><Icon name="close" /></button>
            </div>
            <p className="sheet-copy">只影响本机展示，不改变订阅。只看关注请用「全部 / 关注」标签页。</p>
            <label className="filter-row">
              <input
                type="checkbox"
                checked={filters.hideReplies}
                onChange={(event) => setFilters((prev) => ({ ...prev, hideReplies: event.target.checked }))}
              />
              <span><strong>隐藏回复</strong><small>不显示参与帖子串的回复（带 e 标签的帖子）</small></span>
            </label>
            <div className="filter-section">
              <strong>屏蔽关键词</strong>
              <small>帖子内容包含以下任意词（不区分大小写）即隐藏</small>
              <form
                className="keyword-add"
                onSubmit={(event) => { event.preventDefault(); addMutedKeyword(); }}
              >
                <input
                  type="text"
                  value={keywordDraft}
                  onChange={(event) => setKeywordDraft(event.target.value)}
                  placeholder="输入关键词，回车添加"
                  aria-label="屏蔽关键词"
                  maxLength={40}
                />
                <button type="submit">添加</button>
              </form>
              {filters.mutedKeywords.length > 0 ? (
                <ul className="keyword-list">
                  {filters.mutedKeywords.map((keyword) => (
                    <li key={keyword} className="keyword-chip">
                      <span>{keyword}</span>
                      <button onClick={() => removeMutedKeyword(keyword)} aria-label={`移除屏蔽词 ${keyword}`}>×</button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">还没有屏蔽词。</p>
              )}
            </div>
            {filtersActive(filters) && (
              <button className="filter-clear" onClick={clearFilters}>清除全部筛选</button>
            )}
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
              <AvatarMark pubkey={detailEvent.pubkey} profileCache={profileCache} incognito={incognitoMode} />
              <span><strong>{shortKey(encodeNip19("npub", detailEvent.pubkey))}</strong><small>查看这个作者的帖子</small></span>
            </button>
            <div className="detail-content"><FormattedNote content={detailEvent.content} /></div>
            <dl className="event-facts">
              <div><dt>发布时间</dt><dd>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(detailEvent.created_at * 1000))}</dd></div>
              <div><dt>来源资讯源</dt><dd>{detailEvent.relays.join("、")}</dd></div>
              <div><dt>事件 ID</dt><dd><code>{encodeNip19("note", detailEvent.id)}</code><button onClick={() => void copyValue(encodeNip19("note", detailEvent.id), "事件 ID")}>复制</button></dd></div>
              <div><dt>作者公钥</dt><dd><code>{encodeNip19("npub", detailEvent.pubkey)}</code><button onClick={() => void copyValue(encodeNip19("npub", detailEvent.pubkey), "作者公钥")}>复制</button></dd></div>
            </dl>
            <div className="detail-actions">
              <button className="reply-button" onClick={() => openReply(detailEvent)}><Icon name="reply" />回复这条帖子</button>
            </div>
            <section className="thread-section" aria-label="对话回复">
              <h3>对话{threadReplies && threadReplies.eventId === detailEvent.id && !threadReplies.loading ? `（${threadReplies.events.length} 条回复）` : ""}</h3>
              {!threadReplies || threadReplies.eventId !== detailEvent.id || threadReplies.loading ? (
                <p className="muted">{threadReplies && threadReplies.events.length > 0 ? `正在拉取回复…（已收到 ${threadReplies.events.length} 条）` : "正在从中继拉取回复…"}</p>
              ) : threadReplies.events.length === 0 ? (
                <p className="muted">暂无回复，来抢沙发。</p>
              ) : (
                <ol className="thread-list">
                  {threadReplies.events.map((reply) => (
                    <li key={reply.id} className="thread-reply">
                      <div className="thread-reply-meta">
                        <AvatarMark
                          pubkey={reply.pubkey}
                          profileCache={profileCache}
                          incognito={incognitoMode}
                          onClick={() => openProfile(reply.pubkey)}
                          ariaLabel={`查看作者 ${profileName(reply.pubkey, profileCache)}`}
                        />
                        <button className="author" onClick={() => openProfile(reply.pubkey)} title={reply.pubkey}>{profileName(reply.pubkey, profileCache)}</button>
                        <time dateTime={new Date(reply.created_at * 1000).toISOString()}>{relativeTime(reply.created_at)}</time>
                      </div>
                      <button className="thread-reply-body" onClick={() => openNote(reply.id)} aria-label={`查看回复 ${shortKey(encodeNip19("note", reply.id))}`}>
                        <FormattedNote content={reply.content} />
                      </button>
                      <div className="thread-reply-actions">
                        <button className="reply-button" onClick={() => openReply(reply)} aria-label={`回复 ${profileName(reply.pubkey, profileCache)}`}><Icon name="reply" />回复</button>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
            {copyMessage && <p className="copy-status" role="status">{copyMessage}</p>}
          </article>
        </div>
      )}

      {longformDetail && longformDetailMeta && (
        <div className="sheet-backdrop detail-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setLongformDetailId(null); }}>
          <article className="detail-sheet longform-sheet" role="dialog" aria-modal="true" aria-labelledby="longform-detail-title">
            <div className="sheet-heading">
              <div><p className="section-index">KIND 30023 LONGFORM</p><h2 id="longform-detail-title">{longformDetailMeta.title || "长文"}</h2></div>
              <button className="icon-button" onClick={() => setLongformDetailId(null)} aria-label="关闭长文"><Icon name="close" /></button>
            </div>
            <button className="detail-author" onClick={() => { setLongformDetailId(null); openProfile(longformDetail.pubkey); }}>
              <AvatarMark pubkey={longformDetail.pubkey} profileCache={profileCache} incognito={incognitoMode} />
              <span><strong>{profileName(longformDetail.pubkey, profileCache)}</strong><small>查看这个作者的帖子</small></span>
            </button>
            {longformDetailMeta.image && isSafeHttpUrl(longformDetailMeta.image) && (
              incognitoMode ? (
                <p className="longform-cover-hint"><a href={longformDetailMeta.image} target="_blank" rel="noreferrer">🖼 查看封面图（隐身模式未加载）</a></p>
              ) : (
                <img className="longform-cover" src={longformDetailMeta.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
              )
            )}
            <div className="longform-body" dangerouslySetInnerHTML={{ __html: longformDetailHtml }} />
            <dl className="event-facts">
              <div><dt>发布时间</dt><dd>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date((longformDetailMeta.publishedAt ?? longformDetail.created_at) * 1000))}</dd></div>
              <div><dt>来源资讯源</dt><dd>{longformDetail.relays.join("、")}</dd></div>
              <div><dt>事件 ID</dt><dd><code>{encodeNip19("note", longformDetail.id)}</code><button onClick={() => void copyValue(encodeNip19("note", longformDetail.id), "事件 ID")}>复制</button></dd></div>
              <div><dt>作者公钥</dt><dd><code>{encodeNip19("npub", longformDetail.pubkey)}</code><button onClick={() => void copyValue(encodeNip19("npub", longformDetail.pubkey), "作者公钥")}>复制</button></dd></div>
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
              <AvatarMark pubkey={profilePubkey} profileCache={profileCache} incognito={incognitoMode} large />
              <div className="profile-names">
                <strong>{profileName(profilePubkey, profileCache)}</strong>
                {profileDetail?.nip05 && <small className="profile-nip05">{profileDetail.nip05}</small>}
                {externalProfilePicture && <a className="profile-picture-link" href={externalProfilePicture} target="_blank" rel="noreferrer">查看外部头像</a>}
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
              <h3>帖子 <span>{profileEvents.length}</span></h3>
              {profilePubkey && authorHistory?.pubkey === profilePubkey && authorHistory.loading && profileEvents.length === 0 ? (
                <p className="profile-history-hint">正在从资讯源拉取他的历史帖子…</p>
              ) : (
                profileEvents.map((item) => (
                  <button key={item.id} onClick={() => openNote(item.id)}>
                    <span>{item.content.trim() || "（空文本）"}</span>
                    <small>{relativeTime(item.created_at)} · {shortKey(encodeNip19("note", item.id))}</small>
                  </button>
                ))
              )}
              {profilePubkey && authorHistory?.pubkey === profilePubkey && !authorHistory.loading && authorHistory.hasMore && (
                <button
                  className="load-more-button"
                  disabled={authorHistory.loadingMore}
                  onClick={loadMoreAuthorHistory}
                >
                  {authorHistory.loadingMore ? "加载中…" : "加载更早的帖子"}
                </button>
              )}
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
            <p className="sheet-copy">{pubkey ? "修改会经签名器签名，发布 kind-3 关注列表到资讯源。" : "未连接签名器，关注仅保存在本浏览器。"}</p>
            {followMessage && <p className="copy-status" role="status">{followMessage}</p>}
            {follows.length === 0 ? (
              <p className="muted">还没有关注任何人。在帖子或作者页点「关注」即可添加。</p>
            ) : (
              <ul className="follow-list">
                {follows.map((followed) => (
                  <li key={followed} className="follow-row">
                    <button
                      className="follow-identity"
                      onClick={() => { setFollowsOpen(false); openProfile(followed); }}
                      aria-label={`查看 ${profileName(followed, profileCache)}`}
                    >
                      <AvatarMark pubkey={followed} profileCache={profileCache} incognito={incognitoMode} />
                      <span className="follow-names">
                        <strong>{profileName(followed, profileCache)}</strong>
                        <small>{shortKey(encodeNip19("npub", followed))}</small>
                      </span>
                    </button>
                    <button className="unfollow-button" onClick={() => void toggleFollow(followed)}>取消关注</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
