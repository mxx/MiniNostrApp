import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isNostrEvent, loadRelays, normalizeRelay, relativeTime, shortKey, describeRelayClose, isMixedContentBlocked } from "../src/App";
import { installLocalStorageMock, makeEvent } from "./fixtures";

const ROOT = join(import.meta.dir, "..");

installLocalStorageMock();

beforeEach(() => {
  localStorage.clear();
});

describe("shortKey", () => {
  test("长字符串截断为 前8…后6（>16 字符才截断）", () => {
    expect(shortKey("0123456789abcdef0123")).toBe("01234567…ef0123");
  });
  test("16 字符及以内原样返回", () => {
    expect(shortKey("abc")).toBe("abc");
    expect(shortKey("0123456789abcdef")).toBe("0123456789abcdef");
  });
});

describe("relativeTime", () => {
  test("秒/分钟/小时/天前", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(relativeTime(now - 30)).toBe("30 秒前");
    expect(relativeTime(now - 5 * 60)).toBe("5 分钟前");
    expect(relativeTime(now - 3 * 3600)).toBe("3 小时前");
    expect(relativeTime(now - 2 * 86400)).toBe("2 天前");
  });
  test("未来时间显示 …后", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(relativeTime(now + 90)).toBe("1 分钟后");
  });
  test("超过 7 天显示日期而非相对时间", () => {
    const now = Math.floor(Date.now() / 1000);
    const text = relativeTime(now - 30 * 86400);
    expect(text).not.toContain("前");
    expect(text.length).toBeGreaterThan(0);
  });
});

describe("normalizeRelay", () => {
  test("合法 wss/ws 通过", () => {
    expect(normalizeRelay("wss://relay.example.com")).toBe("wss://relay.example.com");
    expect(normalizeRelay("ws://lulin.org")).toBe("ws://lulin.org");
  });
  test("去除尾部斜杠、hash、query", () => {
    expect(normalizeRelay("wss://relay.example.com/")).toBe("wss://relay.example.com");
    expect(normalizeRelay("wss://relay.example.com/path?x=1#frag")).toBe("wss://relay.example.com/path");
  });
  test("非法输入返回 null", () => {
    expect(normalizeRelay("https://example.com")).toBeNull();
    expect(normalizeRelay("not a url")).toBeNull();
    expect(normalizeRelay("")).toBeNull();
    expect(normalizeRelay("wss://")).toBeNull();
  });
});

describe("loadRelays", () => {
  test("无存储时返回默认 4 个资讯源，lulin.org 首位（wss）", () => {
    const relays = loadRelays();
    expect(relays).toHaveLength(4);
    expect(relays[0]?.url).toBe("wss://lulin.org");
    expect(relays.every((r) => typeof r.enabled === "boolean")).toBe(true);
  });
  test("旧存档缺 lulin.org 时自动补入队首，不重置用户选择", () => {
    const stored = [
      { url: "wss://relay.gulugulu.moe", enabled: true },
      { url: "wss://relay-jp.nostr.wirednet.jp", enabled: false },
    ];
    localStorage.setItem("nostr-min-relays-v1", JSON.stringify(stored));
    const relays = loadRelays();
    expect(relays[0]?.url).toBe("wss://lulin.org");
    expect(relays).toHaveLength(3);
    expect(relays.find((r) => r.url === "wss://relay-jp.nostr.wirednet.jp")?.enabled).toBe(false);
  });
  test("已有 lulin.org 的存档原样返回，不重复注入", () => {
    const stored = [{ url: "wss://lulin.org", enabled: false }];
    localStorage.setItem("nostr-min-relays-v1", JSON.stringify(stored));
    expect(loadRelays()).toEqual(stored);
  });
  test("旧 ws://lulin.org 存档保留，不强制迁移、不重复", () => {
    const stored = [{ url: "ws://lulin.org", enabled: false }];
    localStorage.setItem("nostr-min-relays-v1", JSON.stringify(stored));
    const relays = loadRelays();
    expect(relays).toEqual(stored);
    expect(relays.filter((r) => r.url.includes("lulin.org"))).toHaveLength(1);
  });
  test("损坏的 JSON 回退默认", () => {
    localStorage.setItem("nostr-min-relays-v1", "{broken");
    expect(loadRelays()).toHaveLength(4);
  });
});

describe("isNostrEvent", () => {
  test("合法 kind-1 事件通过 kind=1", () => {
    expect(isNostrEvent(makeEvent(), 1)).toBe(true);
  });
  test("kind 不匹配时拒绝", () => {
    expect(isNostrEvent(makeEvent(), 0)).toBe(false);
    expect(isNostrEvent(makeEvent({ kind: 0 }), 1)).toBe(false);
  });
  test("缺字段时拒绝", () => {
    const bad = makeEvent() as unknown as Record<string, unknown>;
    delete bad.sig;
    expect(isNostrEvent(bad, 1)).toBe(false);
    expect(isNostrEvent(null, 1)).toBe(false);
    expect(isNostrEvent("str", 1)).toBe(false);
  });
});

describe("isMixedContentBlocked", () => {
  test("HTTPS 页面 + ws:// 会被拦截", () => {
    expect(isMixedContentBlocked("ws://lulin.org", "https:")).toBe(true);
  });
  test("HTTPS 页面 + wss:// 不拦截", () => {
    expect(isMixedContentBlocked("wss://relay.damus.io", "https:")).toBe(false);
  });
  test("HTTP 页面 + ws:// 不拦截", () => {
    expect(isMixedContentBlocked("ws://lulin.org", "http:")).toBe(false);
  });
});

describe("describeRelayClose", () => {
  test("HTTPS 下 ws:// 从未连通 → 提示混合内容被拦截", () => {
    const reason = describeRelayClose("ws://lulin.org", 1006, false, "https:");
    expect(reason).toContain("混合内容");
    expect(reason).toContain("wss://");
  });
  test("1006 从未连通 → 无法建立连接（被拒绝/不可达/超时）", () => {
    const reason = describeRelayClose("wss://relay.damus.io", 1006, false, "https:");
    expect(reason).toContain("无法建立连接");
    expect(reason).toContain("1006");
  });
  test("1006 曾经连通过 → 连接异常中断", () => {
    const reason = describeRelayClose("wss://relay.damus.io", 1006, true, "https:");
    expect(reason).toContain("异常中断");
  });
  test("1015 → TLS 握手失败", () => {
    expect(describeRelayClose("wss://x", 1015, false, "https:")).toContain("TLS");
  });
  test("1001 → 资讯源主动断开", () => {
    expect(describeRelayClose("wss://x", 1001, true, "https:")).toContain("主动断开");
  });
  test("未知代码带上代码号", () => {
    expect(describeRelayClose("wss://x", 1008, false, "https:")).toContain("1008");
    expect(describeRelayClose("wss://x", 1008, true, "https:")).toContain("1008");
  });
  test("混合内容判断优先于 code 分类", () => {
    // 即使 code 不是 1006，HTTPS+ws:// 未连通也是浏览器拦截
    expect(describeRelayClose("ws://lulin.org", 1015, false, "https:")).toContain("混合内容");
  });
});

describe("资讯源错误原因接线", () => {
  const app = () => readFileSync(join(ROOT, "src/App.tsx"), "utf-8");
  const css = () => readFileSync(join(ROOT, "src/theme.css"), "utf-8");

  test("onclose 把 code/是否连通过交给 describeRelayClose", () => {
    expect(app()).toContain("describeRelayClose(relay.url, event.code, opened.has(relay.url))");
  });
  test("15 秒握手超时判 offline 并写原因", () => {
    expect(app()).toContain("连接超时（15 秒无响应）");
  });
  test("重连周期开始时清空旧原因", () => {
    expect(app()).toContain("setRelayProblems({})");
  });
  test("面板渲染 relay-problem 原因行", () => {
    expect(app()).toContain('className="relay-problem"');
  });
  test("样式定义了 .relay-problem 且跨整行", () => {
    expect(css()).toContain(".relay-problem");
    expect(css()).toContain("grid-column: 1 / -1");
  });
});

describe("长文详情宽度", () => {
  test("详情至少不小于列表卡片宽度（1120px feed 列宽 − 48px padding）", () => {
    const css = readFileSync(join(ROOT, "src/theme.css"), "utf-8");
    expect(css).toContain(".detail-sheet.longform-sheet { width: min(100%, max(33.333vw, calc(1120px - 48px))); }");
  });
});
