import { describe, expect, test } from "bun:test";
import { applyRelayQuotas, PER_RELAY_MIN } from "../src/App";
import { makeEvent } from "./fixtures";

const note = (id: string, created_at: number, relay: string) => ({
  ...makeEvent({ id, created_at }),
  relays: [relay],
});

/** 生成 n 条某中继的帖子，时间递减（越新越大）。 */
function relayNotes(relay: string, count: number, baseTime: number, idPrefix: string) {
  return Array.from({ length: count }, (_, i) =>
    note(`${idPrefix}-${i}`.padEnd(64, "0"), baseTime - i, relay),
  );
}

describe("applyRelayQuotas", () => {
  test("总量配额常量合理", () => {
    expect(PER_RELAY_MIN).toBeGreaterThan(0);
    expect(PER_RELAY_MIN * 4).toBeLessThanOrEqual(120);
  });

  test("未超上限时原样返回", () => {
    const events = relayNotes("wss://a", 10, 1000, "a");
    expect(applyRelayQuotas(events, 120, 15)).toHaveLength(10);
  });

  test("回归 2026-10-08：高流量中继挤不掉低流量中继的帖子", () => {
    // 中继 A 有 100 条全新的帖子，中继 B（低流量，如 lulin.org）只有 5 条旧帖子。
    // 旧逻辑纯按时间截断，B 的 5 条会全部消失；新逻辑 B 至少保留 perRelayMin 条。
    const high = relayNotes("wss://high", 100, 2000, "h");
    const low = relayNotes("wss://low", 5, 1000, "l");
    const merged = [...high, ...low].sort((a, b) => b.created_at - a.created_at);
    const result = applyRelayQuotas(merged, 20, 5);
    const lowKept = result.filter((e) => e.relays[0] === "wss://low");
    expect(lowKept).toHaveLength(5);
    expect(result).toHaveLength(20);
  });

  test("每个中继都有保底名额", () => {
    const a = relayNotes("wss://a", 50, 3000, "a");
    const b = relayNotes("wss://b", 50, 2000, "b");
    const c = relayNotes("wss://c", 3, 1000, "c");
    const merged = [...a, ...b, ...c].sort((x, y) => y.created_at - x.created_at);
    const result = applyRelayQuotas(merged, 30, 5);
    expect(result.filter((e) => e.relays[0] === "wss://a").length).toBeGreaterThanOrEqual(5);
    expect(result.filter((e) => e.relays[0] === "wss://b").length).toBeGreaterThanOrEqual(5);
    // c 只有 3 条，全保留
    expect(result.filter((e) => e.relays[0] === "wss://c")).toHaveLength(3);
    expect(result).toHaveLength(30);
  });

  test("总数永不超过上限且按时间倒序", () => {
    const a = relayNotes("wss://a", 80, 5000, "a");
    const b = relayNotes("wss://b", 80, 4000, "b");
    const merged = [...a, ...b].sort((x, y) => y.created_at - x.created_at);
    const result = applyRelayQuotas(merged, 40, 10);
    expect(result).toHaveLength(40);
    for (let i = 1; i < result.length; i += 1) {
      expect(result[i - 1]!.created_at).toBeGreaterThanOrEqual(result[i]!.created_at);
    }
  });

  test("同一事件多中继见过只计一次", () => {
    const dup = { ...note("d".repeat(64), 1000, "wss://a"), relays: ["wss://a", "wss://b"] };
    const others = relayNotes("wss://a", 30, 900, "x");
    const merged = [dup, ...others].sort((x, y) => y.created_at - x.created_at);
    const result = applyRelayQuotas(merged, 20, 5);
    expect(result.filter((e) => e.id === dup.id)).toHaveLength(1);
    expect(result).toHaveLength(20);
  });

  test("中继数很多时总数仍受上限约束", () => {
    const all = Array.from({ length: 10 }, (_, r) =>
      relayNotes(`wss://r${r}`, 20, 1000 - r, `r${r}`),
    ).flat().sort((x, y) => y.created_at - x.created_at);
    const result = applyRelayQuotas(all, 30, 5);
    expect(result.length).toBeLessThanOrEqual(30);
  });
});
