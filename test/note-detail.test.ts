import { describe, expect, test } from "bun:test";
import { findNoteById } from "../src/App";
import { makeEvent, SAMPLE_HEX_ID, SAMPLE_HEX_PUBKEY } from "./fixtures";

const appSrc = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();

/** NostrEvent 需要 relays 字段，fixture 里补上。 */
const note = (overrides: Record<string, unknown> = {}) => ({
  ...makeEvent(overrides),
  relays: ["wss://relay.example"],
});

describe("findNoteById", () => {
  test("主时间线里的帖子能找到", () => {
    const event = note({ id: "a".repeat(64) });
    expect(findNoteById(event.id, [[event], [], new Map()])?.id).toBe(event.id);
  });

  test("回归 2026-10-05：只在关注专属订阅里的帖子也能打开详情", () => {
    // 关注标签页的帖子可能不在主 events 里（专属订阅拉的），
    // 之前详情解析只查 events/manualEvents/thread，导致点按无反应。
    const main = note({ id: "a".repeat(64) });
    const followOnly = note({ id: "b".repeat(64), pubkey: SAMPLE_HEX_PUBKEY });
    const found = findNoteById(followOnly.id, [[main], [], [followOnly], new Map()]);
    expect(found?.id).toBe(followOnly.id);
  });

  test("回归 2026-10-05：只在作者历史里的帖子也能打开详情", () => {
    // 作者窗口的帖子存在 authorHistory.events，之前详情解析查不到，
    // 点按后作者窗口关闭（openNote 里的 setProfilePubkey(null)）但详情打不开。
    const main = note({ id: "a".repeat(64) });
    const historyOnly = note({ id: "c".repeat(64) });
    const found = findNoteById(historyOnly.id, [[main], [], [], [historyOnly], new Map()]);
    expect(found?.id).toBe(historyOnly.id);
  });

  test("Map 源（thread 回复缓存）能找到", () => {
    const reply = note({ id: "d".repeat(64) });
    const cache = new Map([[reply.id, reply]]);
    expect(findNoteById(reply.id, [[], cache])?.id).toBe(reply.id);
  });

  test("靠前的源优先返回", () => {
    const id = "e".repeat(64);
    const first = note({ id, content: "from main" });
    const second = note({ id, content: "from follow" });
    expect(findNoteById(id, [[first], [second]])?.content).toBe("from main");
  });

  test("null / undefined 源被跳过", () => {
    const event = note({ id: "f".repeat(64) });
    expect(findNoteById(event.id, [null, undefined, [event]])?.id).toBe(event.id);
  });

  test("哪里都找不到返回 null", () => {
    expect(findNoteById("0".repeat(64), [[note()], new Map()])).toBeNull();
    expect(findNoteById("0".repeat(64), [])).toBeNull();
  });
});

describe("详情解析接线", () => {
  test("detailEvent 的查找源包含 followEvents 与 authorHistory", () => {
    // 保证将来的重构不会把这两个源从详情解析里丢掉。
    expect(appSrc).toContain("findNoteById(detailEventId, [");
    expect(appSrc).toContain("followEvents,");
    expect(appSrc).toContain("authorHistory?.events,");
  });

  test("关注标签页与作者窗口的帖子点按都走 openNote", () => {
    expect(appSrc).toContain("onOpenNote={openNote}");
    expect(appSrc).toContain("onClick={() => openNote(item.id)}");
  });
});
