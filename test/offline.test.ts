/**
 * 离线持久化测试：
 *  - Service Worker（sw.js）：app shell 预缓存、同源 cache-first、版本清理、
 *    绝不拦截跨域（relay）请求；
 *  - 入口注册（main.tsx）与构建拷贝（build.mjs）；
 *  - 帖子 feed 的 localStorage 持久化（loadCachedEvents / saveCachedEvents）；
 *  - scripts/release.sh 的推送门禁：origin/main 为本地祖先时允许推送。
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLocalStorageMock } from "./fixtures";
import { loadCachedEvents, saveCachedEvents, MAX_EVENTS } from "../src/App";

const ROOT = join(import.meta.dir, "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf-8");
}

// ---------- Service Worker ----------

describe("sw.js", () => {
  test("存在于客户端根目录", () => {
    expect(existsSync(join(ROOT, "sw.js"))).toBe(true);
  });

  test("缓存名带版本号，activate 清理旧版本", () => {
    const sw = read("sw.js");
    expect(sw).toContain("CACHE_VERSION");
    expect(sw).toContain("mininostr-app-");
    expect(sw).toContain("caches.delete");
  });

  test("预缓存 app shell（源码保留开发环境 fallback）", () => {
    const sw = read("sw.js");
    expect(sw).toContain('"./"');
    expect(sw).toContain('"./index.html"');
    expect(sw).toContain("addAll");
    expect(sw).toContain("skipWaiting");
  });

  test("只处理同源 GET 请求，不拦截 relay（跨域/WS）流量", () => {
    const sw = read("sw.js");
    expect(sw).toContain('request.method !== "GET"');
    expect(sw).toContain("url.origin !== self.location.origin");
  });

  test("不硬编码带 hash 的 bundle 文件名（hash 变化不影响缓存）", () => {
    const sw = read("sw.js");
    // bundle 产物形如 assets/index-5vt4mm2c.js，SW 必须用运行时缓存而非写死
    expect(/index-[a-z0-9]{6,}\.(js|css)/.test(sw)).toBe(false);
  });

  test("离线时 navigation 回退到缓存的 index.html", () => {
    const sw = read("sw.js");
    expect(sw).toContain('request.mode === "navigate"');
    expect(sw).toContain('caches.match("./index.html")');
  });

  test("命中缓存直接返回，未命中才走网络并回填缓存", () => {
    const sw = read("sw.js");
    expect(sw).toContain("caches.match(request)");
    expect(sw).toContain("cache.put(request");
  });
});

describe("入口与构建", () => {
  test("main.tsx 在 serviceWorker 可用时注册 ./sw.js", () => {
    const main = read("src/main.tsx");
    expect(main).toContain('"serviceWorker" in navigator');
    expect(main).toContain('register("./sw.js")');
  });

  test("build.mjs 把 standalone 构建委托给 scripts/standalone-sw.mjs", () => {
    const build = read("build.mjs");
    expect(build).toContain('MININOSTR_STANDALONE === "1"');
    expect(build).toContain("standalone-sw.mjs");
    expect(build).toContain("buildStandaloneSw");
  });
});

// ---------- 帖子持久化 ----------

type StoredEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
  relays: string[];
};

function makeStoredEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    pubkey: "aa".repeat(32),
    created_at: 1700000000,
    kind: 1,
    tags: [],
    content: "hello nostr",
    sig: "bb".repeat(64),
    relays: ["wss://relay.example"],
    ...overrides,
  };
}

describe("loadCachedEvents / saveCachedEvents", () => {
  beforeEach(() => {
    installLocalStorageMock();
  });

  test("空缓存返回 []", () => {
    expect(loadCachedEvents()).toEqual([]);
  });

  test("写入后读回完全一致（含 relays）", () => {
    const events = [makeStoredEvent(), makeStoredEvent({ content: "第二条" })];
    saveCachedEvents(events);
    expect(loadCachedEvents()).toEqual(events);
  });

  test("损坏的 JSON / 非数组返回 [] 而不抛错", () => {
    localStorage.setItem("nostr-min-events-v1", "{not json");
    expect(loadCachedEvents()).toEqual([]);
    localStorage.setItem("nostr-min-events-v1", JSON.stringify({ a: 1 }));
    expect(loadCachedEvents()).toEqual([]);
  });

  test("写入与读取都截断到 MAX_EVENTS", () => {
    const events = Array.from({ length: MAX_EVENTS + 10 }, () => makeStoredEvent());
    saveCachedEvents(events);
    const loaded = loadCachedEvents();
    expect(loaded.length).toBe(MAX_EVENTS);
    // localStorage 里实际存的也不超过上限
    const raw = JSON.parse(localStorage.getItem("nostr-min-events-v1") as string);
    expect(raw.length).toBe(MAX_EVENTS);
  });

  test("丢弃 kind 非 1 / 缺字段的脏数据，缺 relays/tags 补 []", () => {
    const good = makeStoredEvent();
    const dirty = [
      good,
      { ...makeStoredEvent(), kind: 0 },
      { ...makeStoredEvent(), id: 123 },
      { ...makeStoredEvent(), relays: undefined, tags: undefined },
    ];
    localStorage.setItem("nostr-min-events-v1", JSON.stringify(dirty));
    const loaded = loadCachedEvents();
    expect(loaded.length).toBe(2);
    expect(loaded[0]).toEqual(good);
    expect(loaded[1]!.relays).toEqual([]);
    expect(loaded[1]!.tags).toEqual([]);
  });

  test("存储配额不足时不抛错（feed 照常工作）", () => {
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };
    Object.defineProperty(globalThis, "localStorage", {
      value: throwing,
      configurable: true,
      writable: true,
    });
    expect(() => saveCachedEvents([makeStoredEvent()])).not.toThrow();
    expect(loadCachedEvents()).toEqual([]);
  });
});

// ---------- release.sh 推送门禁 ----------
// 门禁语义（scripts/release.sh）：origin/main 是本地 HEAD 的祖先 → 允许推送；
// 已分叉 → 拒绝。用临时仓库验证该谓词。

function sh(dir: string, cmd: string): void {
  execSync(cmd, { cwd: dir, stdio: "pipe" });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  sh(dir, "git init -b main -q");
  sh(dir, 'git config user.email "t@t" && git config user.name "t"');
  writeFileSync(join(dir, "f"), "1");
  sh(dir, "git add . && git commit -qm init");
  return dir;
}

/** 与 release.sh 完全相同的门禁谓词 */
function gateAllows(repo: string): boolean {
  try {
    execSync('git merge-base --is-ancestor "origin/main" HEAD', { cwd: repo, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

describe("release.sh 推送门禁", () => {
  test("本地与远端一致 → 允许", () => {
    const bare = mkdtempSync(join(tmpdir(), "bare-"));
    sh(bare, "git init --bare -q");
    const repo = initRepo();
    sh(repo, `git remote add origin "${bare}" && git push -q origin main`);
    expect(gateAllows(repo)).toBe(true);
  });

  test("本地领先远端（有新提交待 push）→ 允许", () => {
    const bare = mkdtempSync(join(tmpdir(), "bare-"));
    sh(bare, "git init --bare -q");
    const repo = initRepo();
    sh(repo, `git remote add origin "${bare}" && git push -q origin main`);
    writeFileSync(join(repo, "f"), "2");
    sh(repo, "git commit -qam more");
    expect(gateAllows(repo)).toBe(true);
  });

  test("已分叉（远端也有新提交）→ 拒绝", () => {
    const bare = mkdtempSync(join(tmpdir(), "bare-"));
    sh(bare, "git init --bare -q");
    const repo = initRepo();
    sh(repo, `git remote add origin "${bare}" && git push -q origin main`);
    // 另一克隆推送了新提交
    const other = mkdtempSync(join(tmpdir(), "other-"));
    sh(
      other,
      `git clone -q "${bare}" . && git config user.email "t@t" && git config user.name "t" && git checkout -q -b main origin/main`,
    );
    writeFileSync(join(other, "f"), "remote");
    sh(other, "git commit -qam remote && git push -q origin main");
    // 本地也提交并 fetch，历史分叉
    writeFileSync(join(repo, "f"), "local");
    sh(repo, "git commit -qam local && git fetch -q origin");
    expect(gateAllows(repo)).toBe(false);
  });
});
