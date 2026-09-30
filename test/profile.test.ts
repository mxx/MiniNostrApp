import { beforeEach, describe, expect, test } from "bun:test";
import {
  encodeNip19,
  loadProfileCache,
  loadStoredFollows,
  mergeContactTags,
  parseProfileContent,
  profileName,
  profilePicture,
  shortKey,
} from "../src/App";
import { SAMPLE_HEX_PUBKEY, SAMPLE_PROFILE_JSON, installLocalStorageMock, makeKind0Event } from "./fixtures";

installLocalStorageMock();

beforeEach(() => {
  localStorage.clear();
});

describe("parseProfileContent", () => {
  test("解析标准 kind-0 JSON", () => {
    const profile = parseProfileContent(SAMPLE_PROFILE_JSON);
    expect(profile?.name).toBe("alice");
    expect(profile?.display_name).toBe("Alice 绿林");
    expect(profile?.about).toBe("测试简介\n第二行");
    expect(profile?.picture).toBe("https://example.com/avatar.png");
    expect(profile?.nip05).toBe("alice@example.com");
  });

  test("空白字段被忽略", () => {
    const profile = parseProfileContent(JSON.stringify({ name: "  ", about: "ok" }));
    expect(profile?.name).toBeUndefined();
    expect(profile?.about).toBe("ok");
  });

  test("全空对象返回 null", () => {
    expect(parseProfileContent("{}")).toBeNull();
    expect(parseProfileContent(JSON.stringify({ name: "" }))).toBeNull();
  });

  test("非法 JSON / 非对象返回 null", () => {
    expect(parseProfileContent("not json")).toBeNull();
    expect(parseProfileContent("123")).toBeNull();
    expect(parseProfileContent('"str"')).toBeNull();
  });

  test("真实 kind-0 事件 content 可解析", () => {
    const event = makeKind0Event();
    expect(parseProfileContent(event.content)?.display_name).toBe("Alice 绿林");
  });
});

describe("profileName / profilePicture", () => {
  const cache = {
    [SAMPLE_HEX_PUBKEY]: {
      profile: { display_name: "Alice 绿林", name: "alice", picture: "https://example.com/a.png" },
      created_at: 1,
      fetched_at: Date.now(),
    },
  };

  test("优先 display_name，其次 name", () => {
    expect(profileName(SAMPLE_HEX_PUBKEY, cache)).toBe("Alice 绿林");
    const nameOnly = { [SAMPLE_HEX_PUBKEY]: { profile: { name: "alice" }, created_at: 1, fetched_at: 1 } };
    expect(profileName(SAMPLE_HEX_PUBKEY, nameOnly)).toBe("alice");
  });

  test("无 profile 时回退为 npub 缩短码", () => {
    const expected = shortKey(encodeNip19("npub", SAMPLE_HEX_PUBKEY));
    expect(profileName(SAMPLE_HEX_PUBKEY, {})).toBe(expected);
    expect(expected).toContain("…");
  });

  test("profilePicture 取 picture，缺失时 undefined", () => {
    expect(profilePicture(SAMPLE_HEX_PUBKEY, cache)).toBe("https://example.com/a.png");
    expect(profilePicture(SAMPLE_HEX_PUBKEY, {})).toBeUndefined();
  });
});

describe("mergeContactTags", () => {
  test("保留非 p 标签，替换 p 标签", () => {
    const merged = mergeContactTags(
      [
        ["p", "old1"],
        ["p", "old2"],
        ["e", "keep"],
      ],
      ["new1", "new2"],
    );
    expect(merged).toEqual([
      ["e", "keep"],
      ["p", "new1"],
      ["p", "new2"],
    ]);
  });

  test("无旧标签时直接生成 p 标签", () => {
    expect(mergeContactTags(undefined, ["a"])).toEqual([["p", "a"]]);
  });

  test("清空关注时只剩非 p 标签", () => {
    expect(mergeContactTags([["p", "x"], ["e", "y"]], [])).toEqual([["e", "y"]]);
  });
});

describe("loadProfileCache / loadStoredFollows", () => {
  test("profile 缓存 round-trip", () => {
    const cache = {
      [SAMPLE_HEX_PUBKEY]: {
        profile: { name: "alice" },
        created_at: 10,
        fetched_at: 20,
      },
    };
    localStorage.setItem("nostr-min-profiles-v1", JSON.stringify(cache));
    expect(loadProfileCache()).toEqual(cache);
  });

  test("损坏的缓存返回空对象", () => {
    localStorage.setItem("nostr-min-profiles-v1", "{bad");
    expect(loadProfileCache()).toEqual({});
  });

  test("链上关注按 pubkey 分键存储", () => {
    localStorage.setItem("nostr-min-follows-v1", JSON.stringify({ [SAMPLE_HEX_PUBKEY]: ["a", "b"] }));
    expect(loadStoredFollows(SAMPLE_HEX_PUBKEY)).toEqual(["a", "b"]);
    expect(loadStoredFollows("other")).toEqual([]);
  });

  test("本地关注走独立 key", () => {
    localStorage.setItem("nostr-min-follows-local-v1", JSON.stringify(["x"]));
    expect(loadStoredFollows(null)).toEqual(["x"]);
    expect(loadStoredFollows(SAMPLE_HEX_PUBKEY)).toEqual([]);
  });

  test("损坏数据回退空数组", () => {
    localStorage.setItem("nostr-min-follows-v1", "nope");
    localStorage.setItem("nostr-min-follows-local-v1", "nope");
    expect(loadStoredFollows(SAMPLE_HEX_PUBKEY)).toEqual([]);
    expect(loadStoredFollows(null)).toEqual([]);
  });
});
