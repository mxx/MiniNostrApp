import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildFollowFilter,
  FOLLOW_POSTS_LIMIT,
  MAX_FOLLOW_EVENTS,
  mergeFollowingFeed,
} from "../src/App";
import { makeEvent } from "./fixtures";

const ROOT = join(import.meta.dir, "..");

type TestEvent = Parameters<typeof mergeFollowingFeed>[0][number];

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const CAROL = "c".repeat(64);

function note(id: string, pubkey: string, created_at: number): TestEvent {
  return makeEvent({ id, pubkey, created_at, content: `note ${id}` }) as TestEvent;
}

describe("buildFollowFilter", () => {
  test("按关注列表的作者拉 kind-1", () => {
    expect(buildFollowFilter([ALICE, BOB])).toEqual({
      kinds: [1],
      authors: [ALICE, BOB],
      limit: FOLLOW_POSTS_LIMIT,
    });
  });

  test("常量是正整数", () => {
    expect(FOLLOW_POSTS_LIMIT).toBeGreaterThan(0);
    expect(MAX_FOLLOW_EVENTS).toBeGreaterThan(0);
  });
});

describe("mergeFollowingFeed", () => {
  test("只保留关注人的帖子，按时间倒序", () => {
    const feed = [
      note("f1", ALICE, 100),
      note("f2", CAROL, 300),
      note("f3", BOB, 200),
    ];
    const merged = mergeFollowingFeed(feed, [], [ALICE, BOB]);
    expect(merged.map((event) => event.id)).toEqual(["f3", "f1"]);
  });

  test("专属订阅的帖子会合并进来（关注的人不在公共信息流里时）", () => {
    const merged = mergeFollowingFeed([], [note("s1", ALICE, 50)], [ALICE]);
    expect(merged.map((event) => event.id)).toEqual(["s1"]);
  });

  test("两边重复的帖子按 id 去重", () => {
    const dup = note("dup", ALICE, 100);
    const merged = mergeFollowingFeed([dup], [dup], [ALICE]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("dup");
  });

  test("已取消关注的人的帖子被过滤掉", () => {
    const merged = mergeFollowingFeed(
      [note("f1", ALICE, 100)],
      [note("s1", BOB, 200)],
      [ALICE],
    );
    expect(merged.map((event) => event.id)).toEqual(["f1"]);
  });

  test("关注列表为空时返回空数组", () => {
    expect(mergeFollowingFeed([note("f1", ALICE, 100)], [note("s1", BOB, 200)], [])).toEqual([]);
  });

  test("不改动传入的数组", () => {
    const feed = [note("f1", ALICE, 100)];
    const follow = [note("s1", BOB, 200)];
    mergeFollowingFeed(feed, follow, [ALICE, BOB]);
    expect(feed).toHaveLength(1);
    expect(follow).toHaveLength(1);
  });
});

describe("关注人订阅的接线", () => {
  const appSrc = readFileSync(join(ROOT, "src", "App.tsx"), "utf8");

  test("连接建立时按关注列表发送专属订阅", () => {
    expect(appSrc).toContain("buildFollowFilter(followAuthors)");
  });

  test("关注列表变化时 CLOSE 旧订阅、REQ 新订阅", () => {
    expect(appSrc).toContain('["CLOSE", oldSubId]');
    expect(appSrc).toContain("buildFollowFilter(follows)");
  });

  test("专属订阅的事件进入 followEvents（带上限）", () => {
    expect(appSrc).toContain("followSubIdsRef.current.has(frame[1])");
    expect(appSrc).toContain("MAX_FOLLOW_EVENTS");
  });

  test("关注标签页用 mergeFollowingFeed 合并两路帖子", () => {
    expect(appSrc).toContain("mergeFollowingFeed(feedEvents, followEvents, follows)");
  });

  test("关注人的资料也被纳入 kind-0 拉取", () => {
    expect(appSrc).toContain("...followEvents.map((event) => event.pubkey)");
  });

  test("空状态区分「没关注人」和「关注的人暂无帖子」", () => {
    expect(appSrc).toContain("关注的人还没有新帖子");
  });
});
