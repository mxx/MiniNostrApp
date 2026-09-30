import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTHOR_HISTORY_LIMIT,
  buildAuthorHistoryFilter,
  mergeHistoryEvents,
} from "../src/App";

const appSrc = readFileSync(join(__dirname, "../src/App.tsx"), "utf8");
const css = readFileSync(join(__dirname, "../src/theme.css"), "utf8");

type TestEvent = Parameters<typeof mergeHistoryEvents>[0][number];

function makeEvent(overrides: Partial<TestEvent> = {}): TestEvent {
  return {
    id: overrides.id ?? `id-${Math.random()}`,
    pubkey: overrides.pubkey ?? "pubkey-1",
    created_at: overrides.created_at ?? 1,
    kind: 1,
    tags: [],
    content: "",
    sig: "sig",
    relays: [],
  };
}

describe("buildAuthorHistoryFilter", () => {
  test("按作者拉 kind-1，limit 为 AUTHOR_HISTORY_LIMIT", () => {
    const filter = buildAuthorHistoryFilter("author-pubkey");
    expect(filter).toEqual({ kinds: [1], authors: ["author-pubkey"], limit: 200 });
  });

  test("until 只在分页时出现", () => {
    expect("until" in buildAuthorHistoryFilter("author-pubkey")).toBe(false);
    const paged = buildAuthorHistoryFilter("author-pubkey", 12345);
    expect(paged.until).toBe(12345);
    expect(paged.limit).toBe(AUTHOR_HISTORY_LIMIT);
  });

  test("AUTHOR_HISTORY_LIMIT 为 200", () => {
    expect(AUTHOR_HISTORY_LIMIT).toBe(200);
  });
});

describe("mergeHistoryEvents", () => {
  test("按 id 去重并按时间倒序", () => {
    const old = makeEvent({ id: "a", created_at: 100 });
    const dup = makeEvent({ id: "a", created_at: 100 });
    const newer = makeEvent({ id: "b", created_at: 300 });
    const older = makeEvent({ id: "c", created_at: 50 });
    const merged = mergeHistoryEvents([old, older], [dup, newer]);
    expect(merged.map((event) => event.id)).toEqual(["b", "a", "c"]);
  });

  test("不改动传入的数组", () => {
    const current = [makeEvent({ id: "a", created_at: 1 })];
    const incoming = [makeEvent({ id: "b", created_at: 2 })];
    mergeHistoryEvents(current, incoming);
    expect(current).toHaveLength(1);
    expect(incoming).toHaveLength(1);
  });

  test("空输入返回空数组", () => {
    expect(mergeHistoryEvents([], [])).toEqual([]);
  });
});

describe("作者历史接线", () => {
  test("打开作者页时发起历史订阅", () => {
    expect(appSrc).toContain("requestAuthorHistory(key)");
    expect(appSrc).toContain("authorHistoryRef");
    expect(appSrc).toContain("buildAuthorHistoryFilter");
  });

  test("订阅收发了 EOSE 并在关闭时 CLOSE", () => {
    expect(appSrc).toContain("\"EOSE\"");
    expect(appSrc).toContain("\"CLOSE\"");
    expect(appSrc).toContain("closeAuthorHistorySubs");
  });

  test("历史与主时间线隔离（不进 MAX_EVENTS 的裁剪）", () => {
    // 历史单独存 state，合并展示时才与主时间线并集。
    expect(appSrc).toContain("setAuthorHistory");
    expect(appSrc).toContain("mergeHistoryEvents(history, fromFeed)");
  });

  test("有加载状态与加载更早按钮", () => {
    expect(appSrc).toContain("加载更早的帖子");
    expect(appSrc).toContain("正在从资讯源拉取他的历史帖子");
    expect(appSrc).toContain("loadingMore");
    expect(appSrc).toContain("hasMore");
    expect(css).toContain(".load-more-button");
    expect(css).toContain(".profile-history-hint");
  });

  test("帮助中说明了作者历史拉取", () => {
    expect(appSrc).toContain("打开作者页会自动向资讯源拉取他的历史帖子");
  });
});
