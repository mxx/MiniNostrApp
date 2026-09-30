import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyFilters,
  filtersActive,
  isReplyEvent,
  loadFilters,
  saveFilters,
} from "../src/App";

const appSrc = readFileSync(join(__dirname, "../src/App.tsx"), "utf8");
const css = readFileSync(join(__dirname, "../src/theme.css"), "utf8");

type TestEvent = Parameters<typeof applyFilters>[0][number];

function makeEvent(overrides: Partial<{ id: string; content: string; tags: string[][] }> = {}): TestEvent {
  return {
    id: overrides.id ?? `id-${Math.random()}`,
    pubkey: "pubkey-1",
    created_at: 1,
    kind: 1,
    tags: overrides.tags ?? [],
    content: overrides.content ?? "",
    sig: "sig",
    relays: [],
  };
}

describe("loadFilters / saveFilters", () => {
  beforeEach(() => localStorage.clear());

  test("缺省：不隐藏回复、无屏蔽词", () => {
    expect(loadFilters()).toEqual({ hideReplies: false, mutedKeywords: [] });
  });

  test("开关与屏蔽词持久化", () => {
    saveFilters({ hideReplies: true, mutedKeywords: ["广告", "spam"] });
    expect(loadFilters()).toEqual({ hideReplies: true, mutedKeywords: ["广告", "spam"] });
  });

  test("损坏的 JSON 回退缺省", () => {
    localStorage.setItem("nostr-min-filters-v1", "{broken");
    expect(loadFilters()).toEqual({ hideReplies: false, mutedKeywords: [] });
  });

  test("清洗屏蔽词：去空、去重空白、上限 50", () => {
    const stored = { hideReplies: false, mutedKeywords: ["  广告  ", "", "   ", 123, ...Array.from({ length: 60 }, (_, i) => `k${i}`)] };
    localStorage.setItem("nostr-min-filters-v1", JSON.stringify(stored));
    const loaded = loadFilters();
    expect(loaded.mutedKeywords[0]).toBe("广告");
    expect(loaded.mutedKeywords).toHaveLength(50);
    expect(loaded.mutedKeywords.every((k) => typeof k === "string" && k.length > 0)).toBe(true);
  });
});

describe("isReplyEvent", () => {
  test("带 e 标签的是回复", () => {
    expect(isReplyEvent(makeEvent({ tags: [["e", "abc123"]] }))).toBe(true);
  });

  test("只有 p 标签 / 无标签 / e 值为空都不是回复", () => {
    expect(isReplyEvent(makeEvent({ tags: [["p", "pubkey-2"]] }))).toBe(false);
    expect(isReplyEvent(makeEvent())).toBe(false);
    expect(isReplyEvent(makeEvent({ tags: [["e", ""]] }))).toBe(false);
  });
});

describe("applyFilters", () => {
  const original = makeEvent({ id: "original", content: "hello world" });
  const reply = makeEvent({ id: "reply", content: "re: hello", tags: [["e", "root-id"]] });
  const spam = makeEvent({ id: "spam", content: "买一送一广告" });

  test("无筛选条件时原样返回", () => {
    const events = [original, reply, spam];
    expect(applyFilters(events, { hideReplies: false, mutedKeywords: [] })).toBe(events);
    expect(filtersActive({ hideReplies: false, mutedKeywords: [] })).toBe(false);
  });

  test("隐藏回复", () => {
    const result = applyFilters([original, reply, spam], { hideReplies: true, mutedKeywords: [] });
    expect(result.map((e) => e.id)).toEqual(["original", "spam"]);
    expect(filtersActive({ hideReplies: true, mutedKeywords: [] })).toBe(true);
  });

  test("关键词屏蔽：大小写不敏感的子串匹配", () => {
    const en = makeEvent({ id: "en", content: "I love BITCOIN" });
    const result = applyFilters([original, en, spam], { hideReplies: false, mutedKeywords: ["bitcoin", "广告"] });
    expect(result.map((e) => e.id)).toEqual(["original"]);
  });

  test("组合筛选同时生效", () => {
    const result = applyFilters([original, reply, spam], { hideReplies: true, mutedKeywords: ["广告"] });
    expect(result.map((e) => e.id)).toEqual(["original"]);
  });
});

describe("筛选 UI 接线", () => {
  test("工具栏有筛选按钮与面板", () => {
    expect(appSrc).toContain('aria-label="筛选帖子"');
    expect(appSrc).toContain("setFilterOpen(true)");
    expect(appSrc).toContain('aria-label="筛选帖子"');
    expect(appSrc).toContain("applyFilters(visibleEvents, filters)");
    expect(appSrc).toContain("saveFilters(filters)");
  });

  test("面板包含隐藏回复开关与关键词管理", () => {
    expect(appSrc).toContain("隐藏回复");
    expect(appSrc).toContain("屏蔽关键词");
    expect(appSrc).toContain("addMutedKeyword");
    expect(appSrc).toContain("removeMutedKeyword");
    expect(appSrc).toContain("清除筛选");
    expect(appSrc).toContain("清除全部筛选");
  });

  test("空状态与计数感知筛选", () => {
    expect(appSrc).toContain("筛选隐藏了全部帖子");
    expect(appSrc).toContain("hiddenByFilters");
    expect(appSrc).toContain("被筛选隐藏");
  });

  test("帮助说明提到筛选", () => {
    expect(appSrc).toContain("筛选");
    expect(appSrc).toContain("漏斗");
  });

  test("筛选样式存在", () => {
    for (const cls of ["filter-row", "filter-section", "keyword-add", "keyword-list", "keyword-chip", "filter-clear"]) {
      expect(css, `${cls} 缺失`).toContain(`.${cls}`);
    }
  });
});
