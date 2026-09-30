import { beforeEach, describe, expect, test } from "bun:test";
import { isNostrEvent, loadRelays, normalizeRelay, relativeTime, shortKey } from "../src/App";
import { installLocalStorageMock, makeEvent } from "./fixtures";

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
  test("无存储时返回默认 4 个资讯源，lulin.org 首位", () => {
    const relays = loadRelays();
    expect(relays).toHaveLength(4);
    expect(relays[0]?.url).toBe("ws://lulin.org");
    expect(relays.every((r) => typeof r.enabled === "boolean")).toBe(true);
  });
  test("旧存档缺 lulin.org 时自动补入队首，不重置用户选择", () => {
    const stored = [
      { url: "wss://relay.gulugulu.moe", enabled: true },
      { url: "wss://relay-jp.nostr.wirednet.jp", enabled: false },
    ];
    localStorage.setItem("nostr-min-relays-v1", JSON.stringify(stored));
    const relays = loadRelays();
    expect(relays[0]?.url).toBe("ws://lulin.org");
    expect(relays).toHaveLength(3);
    expect(relays.find((r) => r.url === "wss://relay-jp.nostr.wirednet.jp")?.enabled).toBe(false);
  });
  test("已有 lulin.org 的存档原样返回", () => {
    const stored = [{ url: "ws://lulin.org", enabled: false }];
    localStorage.setItem("nostr-min-relays-v1", JSON.stringify(stored));
    expect(loadRelays()).toEqual(stored);
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
