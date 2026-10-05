import { beforeEach, describe, expect, test } from "bun:test";
import {
  APP_VERSION,
  AUTO_GRID_CARD_H,
  AUTO_GRID_CARD_MIN_W,
  AUTO_GRID_GAP,
  AUTO_GRID_NARROW_COLS,
  AUTO_GRID_NARROW_W,
  autoGridCapacity,
  autoGridTile,
  autoGridWindow,
  avatarDisplay,
  buildReplyTags,
  buildThreadFilter,
  defaultUpdateEnv,
  fetchRelayPicks,
  forceAppUpdate,
  isRelayPicks,
  loadIncognitoMode,
  loadViewMode,
  mergeThreadEvents,
  RELAY_PICKS_URL,
  relayPicksUrl,
  saveIncognitoMode,
  saveViewMode,
  THREAD_REPLIES_LIMIT,
} from "../src/App";
import {
  APP_VERSION_PLACEHOLDER,
  getAppVersion,
  injectAppVersion,
} from "../scripts/app-version.mjs";
import {
  DEFAULT_SITE_NAME,
  getSiteName,
  injectSiteName,
  injectSiteTitle,
  SITE_NAME_PLACEHOLDER,
} from "../scripts/site-config.mjs";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLocalStorageMock, SAMPLE_HEX_ID, SAMPLE_HEX_PUBKEY } from "./fixtures";

installLocalStorageMock();

const css = await Bun.file(new URL("../src/theme.css", import.meta.url)).text();
const appSrc = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
const buildSrc = await Bun.file(new URL("../build.mjs", import.meta.url)).text();

describe("浏览模式持久化（自动 / 手动）", () => {
  beforeEach(() => localStorage.clear());

  test("默认自动模式", () => {
    expect(loadViewMode()).toBe("auto");
  });

  test("模式切换写入 localStorage", () => {
    expect(appSrc).toContain("saveViewMode(viewMode)");
  });
});

describe("自动网格数学（从左向右、从上向下推进）", () => {
  test("容量：按舞台尺寸算出完整行列", () => {
    // 列：300px 卡 + 12px 间距；行：340px 卡 + 12px 间距
    const c = autoGridCapacity(936, 716);
    expect(c.cols).toBe(3);
    expect(c.rows).toBe(2);
    expect(c.count).toBe(6);
  });

  test("容量：极小舞台至少 1x1", () => {
    expect(autoGridCapacity(100, 100)).toEqual({ cols: 1, rows: 1, count: 1 });
    expect(autoGridCapacity(0, 0)).toEqual({ cols: 1, rows: 1, count: 1 });
  });

  test("窗口始终保留最新 K 条，严格维持时间倒序", () => {
    expect(autoGridWindow(["最新", "次新", "更早", "最早"], 3)).toEqual(["最新", "次新", "更早"]);
  });

  test("新帖插入池首后进入左上角，其余帖子顺移", () => {
    expect(autoGridWindow(["新帖", "最新", "次新", "更早"], 3)).toEqual(["新帖", "最新", "次新"]);
  });

  test("窗口不回绕，避免旧帖出现在新帖前面", () => {
    expect(autoGridWindow(["a", "b", "c", "d", "e"], 3)).toEqual(["a", "b", "c"]);
  });

  test("窗口：池子小于容量时全显", () => {
    expect(autoGridWindow(["a", "b"], 6)).toEqual(["a", "b"]);
  });

  test("窗口：空池/零容量返回空", () => {
    expect(autoGridWindow([], 6)).toEqual([]);
    expect(autoGridWindow(["a"], 0)).toEqual([]);
  });

  test("常量合理：与 CSS 网格口径一致", () => {
    expect(AUTO_GRID_CARD_MIN_W).toBe(300);
    expect(AUTO_GRID_CARD_H).toBe(340);
    expect(AUTO_GRID_GAP).toBe(12);
    expect(AUTO_GRID_NARROW_W).toBe(700);
    expect(AUTO_GRID_NARROW_COLS).toBe(3);
  });

  test("窄屏 tile：竖分三列、卡片按列宽等比缩小", () => {
    const tile = autoGridTile(304);
    expect(tile.narrow).toBe(true);
    expect(tile.scale).toBeCloseTo(((304 - 2 * AUTO_GRID_GAP) / 3) / AUTO_GRID_CARD_MIN_W, 5);
    expect(tile.cardH).toBe(Math.round(AUTO_GRID_CARD_H * tile.scale));
    expect(tile.cardH).toBeLessThan(AUTO_GRID_CARD_H);
  });

  test("窄屏容量：列数固定 3，行数按缩小后的块高重算", () => {
    const tile = autoGridTile(304);
    const c = autoGridCapacity(304, 600);
    expect(c.cols).toBe(3);
    expect(c.rows).toBe(Math.max(1, Math.floor((600 + AUTO_GRID_GAP) / (tile.cardH + AUTO_GRID_GAP))));
    expect(c.count).toBe(c.cols * c.rows);
  });

  test("窄屏边界：700 以下启用、700 及以上走桌面口径", () => {
    expect(autoGridTile(699).narrow).toBe(true);
    expect(autoGridTile(700).narrow).toBe(false);
    expect(autoGridCapacity(700, 600).cols).toBe(Math.max(1, Math.floor((700 + AUTO_GRID_GAP) / (AUTO_GRID_CARD_MIN_W + AUTO_GRID_GAP))));
  });

  test("极窄舞台不启用窄屏（视为尚未布局完成）", () => {
    expect(autoGridTile(100)).toEqual({ cardH: 340, scale: 1, narrow: false });
    expect(autoGridCapacity(100, 100)).toEqual({ cols: 1, rows: 1, count: 1 });
  });

  test("桌面 tile 保持 340px 不缩放", () => {
    expect(autoGridTile(960)).toEqual({ cardH: 340, scale: 1, narrow: false });
  });

  test("窄屏接线：App 注入列数/块高/缩放变量并挂 narrow 类", () => {
    expect(appSrc).toContain('auto-grid${gridTile.narrow ? " narrow" : ""}');
    expect(appSrc).toContain("--auto-card-h");
    expect(appSrc).toContain("--auto-scale");
    expect(appSrc).toContain("AUTO_GRID_NARROW_COLS");
  });

  test("窄屏样式：显示块整块等比缩小", () => {
    expect(css).toContain(".auto-grid.narrow .note");
    expect(css).toContain("height: var(--auto-card-h)");
    expect(css).toContain("calc(31px * var(--auto-scale))");
    expect(css).toContain(".auto-grid.narrow .note-footer");
  });
});

describe("NIP-10 回复标签", () => {
  test("e 标签带资讯源提示与 reply 标记，p 标签指向原作者", () => {
    const tags = buildReplyTags({
      id: SAMPLE_HEX_ID,
      pubkey: SAMPLE_HEX_PUBKEY,
      relays: ["wss://relay.gulugulu.moe", "ws://lulin.org"],
    });
    expect(tags).toEqual([
      ["e", SAMPLE_HEX_ID, "wss://relay.gulugulu.moe", "reply"],
      ["p", SAMPLE_HEX_PUBKEY],
    ]);
  });

  test("无可用资讯源提示时 hint 为空字符串", () => {
    const tags = buildReplyTags({ id: SAMPLE_HEX_ID, pubkey: SAMPLE_HEX_PUBKEY, relays: ["本地发布"] });
    expect(tags[0]).toEqual(["e", SAMPLE_HEX_ID, "", "reply"]);
    expect(tags[1]).toEqual(["p", SAMPLE_HEX_PUBKEY]);
  });

  test("空 relays 不崩", () => {
    const tags = buildReplyTags({ id: SAMPLE_HEX_ID, pubkey: SAMPLE_HEX_PUBKEY, relays: [] });
    expect(tags).toHaveLength(2);
  });
});

describe("自动网格样式（显示回归）", () => {
  test("跑马灯样式与组件已移除", () => {
    expect(css).not.toContain(".marquee-rows");
    expect(css).not.toContain(".marquee-row");
    expect(css).not.toContain(".marquee-track");
    expect(css).not.toContain(".marquee-card");
    expect(appSrc).not.toContain("MarqueeRow");
  });

  test("自动网格复用手动 .feed-list 布局", () => {
    expect(appSrc).toContain("feed-list auto-grid");
    const list = css.match(/\.feed-list\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(list).toContain("display: grid");
  });

  test("自动网格无动画（直接替换）", () => {
    const grid = css.match(/\.auto-grid\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(grid).not.toContain("animation");
    expect(grid).not.toContain("transition");
    const note = css.match(/\.auto-grid \.note\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(note).toContain("animation: none");
    expect(note).toContain("transition: none");
    expect(appSrc).not.toContain("requestAnimationFrame");
  });

  test("网格容器裁掉溢出、自动模式视口锁定无滚动", () => {
    const wrap = css.match(/\.auto-grid-wrap\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(wrap).toContain("overflow: hidden");
    const shell = css.match(/\.app-shell\.auto-mode\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(shell).toContain("100dvh");
    expect(shell).toContain("overflow: hidden");
  });

  test("新组件类齐全", () => {
    for (const cls of [
      "view-switch",
      "view-option",
      "auto-stage",
      "auto-grid-wrap",
      "auto-grid",
      "app-version",
      "auto-bar",
      "auto-count",
      "auto-hint",
      "help-body",
      "note-actions",
      "reply-button",
      "detail-actions",
      "reply-context",
      "reply-context-label",
      "reply-context-cancel",
    ]) {
      expect(new RegExp(`\\.${cls}(?![\\w-])`).test(css), `${cls} 缺失`).toBe(true);
    }
  });
});

describe("App 接线（自动网格 / 回复 / 帮助）", () => {
  test("自动网格不做定时轮换，始终按当前时间倒序窗口渲染（经本地筛选）", () => {
    expect(appSrc).toContain("autoGridWindow(displayEvents, gridCapacity.count)");
    expect(appSrc).toContain("applyFilters(visibleEvents, filters)");
    expect(appSrc).not.toContain("setInterval");
    expect(appSrc).not.toContain("AUTO_GRID_STEP_MS");
    expect(appSrc).not.toContain("autoHead");
  });

  test("网格容量随舞台尺寸自适应（ResizeObserver）", () => {
    expect(appSrc).toContain("ResizeObserver");
    expect(appSrc).toContain("autoGridCapacity");
  });

  test("回复经 publishNote + buildReplyTags 发布", () => {
    expect(appSrc).toContain("buildReplyTags(target)");
    expect(appSrc).toContain("publishNote(content,");
  });


  test("手动模式冻结快照，只有刷新按钮主动更新", () => {
    expect(appSrc).toContain("const [manualEvents, setManualEvents]");
    expect(appSrc).toContain("function refreshManualFeed()");
    expect(appSrc).toContain('aria-label="手动刷新帖子"');
  });

  test("自动网格卡片复用 NoteCard，保留回复入口", () => {
    expect(appSrc).toContain("auto-grid");
    expect(appSrc).toContain("openReply");
    expect(appSrc).toContain("reply-context");
  });

  test("标题栏：绿野仙踪 + 版本号小字", () => {
    expect(appSrc).toContain("绿野仙踪");
    expect(appSrc).toContain("app-version");
    expect(appSrc).toContain("APP_VERSION");
  });

  test("版本更新按钮：清缓存后重载", () => {
    expect(appSrc).toContain('aria-label="版本更新，重新下载"');
    expect(appSrc).toContain("forceAppUpdate(defaultUpdateEnv())");
  });
});

describe("版本号（git describe 注入）", () => {
  test("getAppVersion 在仓库里返回非空版本", () => {
    const v = getAppVersion(new URL("../", import.meta.url));
    expect(v.length).toBeGreaterThan(0);
    expect(v).not.toBe("dev");
  });

  test("getAppVersion 在非仓库目录回退 dev", () => {
    expect(getAppVersion(tmpdir())).toBe("dev");
  });

  test("injectAppVersion 只改写含占位符的 JS", () => {
    const dir = mkdtempSync(join(tmpdir(), "ver-"));
    writeFileSync(join(dir, "a.js"), `const v=${APP_VERSION_PLACEHOLDER};console.log(v);`);
    writeFileSync(join(dir, "b.js"), `console.log("nope");`);
    writeFileSync(join(dir, "c.css"), `.x{content:"${APP_VERSION_PLACEHOLDER}"}`);
    const changed = injectAppVersion(dir, "abc123");
    expect(changed).toEqual(["a.js"]);
    expect(readFileSync(join(dir, "a.js"), "utf8")).toBe(`const v="abc123";console.log(v);`);
    expect(readFileSync(join(dir, "b.js"), "utf8")).toContain("nope");
  });

  test("App 声明 __APP_VERSION__ 外部全局，未注入时回退 dev", () => {
    expect(appSrc).toContain("declare const __APP_VERSION__");
    expect(APP_VERSION).toBe("dev");
  });

  test("build.mjs 在构建后注入版本", () => {
    expect(buildSrc).toContain("git describe");
    expect(buildSrc).toContain("injectAppVersion");
  });
});

describe("网站名（site.config.json 注入）", () => {
  test("getSiteName 读取 site.config.json", () => {
    expect(getSiteName(new URL("../", import.meta.url))).toBe("绿野仙踪");
  });

  test("getSiteName 缺失/非法时回退默认值", () => {
    expect(getSiteName(tmpdir())).toBe(DEFAULT_SITE_NAME);
    const dir = mkdtempSync(join(tmpdir(), "site-"));
    writeFileSync(join(dir, "site.config.json"), "not json{{");
    expect(getSiteName(dir)).toBe(DEFAULT_SITE_NAME);
    writeFileSync(join(dir, "site.config.json"), JSON.stringify({ name: "  " }));
    expect(getSiteName(dir)).toBe(DEFAULT_SITE_NAME);
  });

  test("getSiteName 支持改名", () => {
    const dir = mkdtempSync(join(tmpdir(), "site-"));
    writeFileSync(join(dir, "site.config.json"), JSON.stringify({ name: "我的小站" }));
    expect(getSiteName(dir)).toBe("我的小站");
  });

  test("injectSiteName 只改写含占位符的 JS", () => {
    const dir = mkdtempSync(join(tmpdir(), "site-"));
    writeFileSync(join(dir, "a.js"), `const n=${SITE_NAME_PLACEHOLDER};console.log(n);`);
    writeFileSync(join(dir, "b.js"), `console.log("nope");`);
    const changed = injectSiteName(dir, "我的小站");
    expect(changed).toEqual(["a.js"]);
    expect(readFileSync(join(dir, "a.js"), "utf8")).toBe(`const n="我的小站";console.log(n);`);
  });

  test("injectSiteTitle 改写 <title> 并转义", () => {
    const dir = mkdtempSync(join(tmpdir(), "site-"));
    const p = join(dir, "index.html");
    writeFileSync(p, `<html><head><title>旧标题</title></head></html>`);
    expect(injectSiteTitle(p, "我的小站")).toBe(true);
    expect(readFileSync(p, "utf8")).toContain("<title>我的小站</title>");
    writeFileSync(p, `<html><head><title>x</title></head></html>`);
    injectSiteTitle(p, `a<b>&"c`);
    expect(readFileSync(p, "utf8")).toContain("<title>a&lt;b&gt;&amp;\"c</title>");
    writeFileSync(p, `<html><head></head></html>`);
    expect(injectSiteTitle(p, "我的小站")).toBe(false);
  });

  test("App 声明 __SITE_NAME__ 外部全局，未注入时回退默认值", () => {
    expect(appSrc).toContain("declare const __SITE_NAME__");
    expect(appSrc).toContain("{SITE_NAME}");
    expect(appSrc).toContain("document.title = SITE_NAME");
  });

  test("build.mjs 在构建后注入网站名并改写 <title>", () => {
    expect(buildSrc).toContain("injectSiteName");
    expect(buildSrc).toContain("injectSiteTitle");
    expect(buildSrc).toContain("site.config.json");
  });

  test("源码中不再写死网站名", () => {
    // 标题栏与帮助文案都走 SITE_NAME；index.html 的 <title> 只是 JS 加载前的静态 fallback。
    expect(appSrc).not.toMatch(/<h1[^>]*>绿野仙踪/);
    expect(appSrc).not.toContain("绿野仙踪是一个极简的");
  });
});

describe("版本更新按钮（清缓存重载）", () => {
  test("删除全部缓存、注销 SW、最后重载", async () => {
    const deleted: string[] = [];
    let unregistered = 0;
    let reloaded = false;
    await forceAppUpdate({
      caches: {
        keys: async () => ["c1", "c2"],
        delete: async (name: string) => {
          deleted.push(name);
          return true;
        },
      },
      getServiceWorkerRegistrations: async () => [
        {
          unregister: async () => {
            unregistered++;
            return true;
          },
        },
      ],
      reload: () => {
        reloaded = true;
      },
    });
    expect(deleted).toEqual(["c1", "c2"]);
    expect(unregistered).toBe(1);
    expect(reloaded).toBe(true);
  });

  test("清理抛错也照样重载", async () => {
    let reloaded = false;
    await forceAppUpdate({
      caches: {
        keys: async () => {
          throw new Error("boom");
        },
        delete: async () => true,
      },
      reload: () => {
        reloaded = true;
      },
    });
    expect(reloaded).toBe(true);
  });

  test("无 caches/SW 环境直接重载", async () => {
    let reloaded = false;
    await forceAppUpdate({
      reload: () => {
        reloaded = true;
      },
    });
    expect(reloaded).toBe(true);
  });

  test("重载前强制刷新 HTTP 缓存（顺序：清缓存→注销SW→刷新文档→重载）", async () => {
    const order: string[] = [];
    await forceAppUpdate({
      caches: {
        keys: async () => ["c1"],
        delete: async (name: string) => {
          order.push(`del:${name}`);
          return true;
        },
      },
      getServiceWorkerRegistrations: async () => [
        {
          unregister: async () => {
            order.push("unregister");
            return true;
          },
        },
      ],
      refreshDocument: async () => {
        order.push("refresh");
      },
      reload: () => {
        order.push("reload");
      },
    });
    // 不刷新 HTTP 缓存的话，max-age 下 reload() 会命中旧 index.html，
    // 导致更新按钮看起来无效；refresh 必须发生在 reload 之前。
    expect(order).toEqual(["del:c1", "unregister", "refresh", "reload"]);
  });

  test("刷新文档抛错也照样重载", async () => {
    let refreshed = false;
    let reloaded = false;
    await forceAppUpdate({
      refreshDocument: async () => {
        refreshed = true;
        throw new Error("offline");
      },
      reload: () => {
        reloaded = true;
      },
    });
    expect(refreshed).toBe(true);
    expect(reloaded).toBe(true);
  });

  test("defaultUpdateEnv 在非浏览器环境可构造", () => {
    const env = defaultUpdateEnv();
    expect(typeof env.reload).toBe("function");
  });
});

describe("帮助弹窗", () => {
  test("帮助按钮与关闭按钮接线", () => {
    expect(appSrc).toContain('aria-label="使用说明"');
    expect(appSrc).toContain("setHelpOpen(true)");
    expect(appSrc).toContain('aria-label="关闭使用说明"');
  });

  test("帮助内容覆盖主要功能", () => {
    for (const phrase of ["自动模式", "手动模式", "资讯源", "NIP-07", "关注", "版本更新", "离线"]) {
      expect(appSrc).toContain(phrase);
    }
  });

  test("帮助正文准确说明自动网格不滚动、无动画", () => {
    expect(appSrc).toContain("页面不滚动，也没有切换动画");
  });

  test("帮助正文样式存在", () => {
    expect(css).toContain(".help-body");
  });
});

describe("隐私头像开关（隐身模式）", () => {
  beforeEach(() => localStorage.clear());

  test("缺省普通模式（不隐身）", () => {
    expect(loadIncognitoMode()).toBe(false);
  });

  test("开关持久化到 localStorage", () => {
    saveIncognitoMode(true);
    expect(loadIncognitoMode()).toBe(true);
    saveIncognitoMode(false);
    expect(loadIncognitoMode()).toBe(false);
  });

  test("普通模式：合法 http(s) 头像自动加载", () => {
    const cache = { k1: { profile: { picture: "https://example.com/a.png" }, created_at: 0, fetched_at: 0 } };
    expect(avatarDisplay("k1", cache, false)).toEqual({ kind: "image", src: "https://example.com/a.png" });
  });

  test("普通模式：无头像或非法地址只显示首字母", () => {
    expect(avatarDisplay("k2", {}, false)).toEqual({ kind: "initials" });
    const cache = { k3: { profile: { picture: "data:image/png;base64,xx" }, created_at: 0, fetched_at: 0 } };
    expect(avatarDisplay("k3", cache, false)).toEqual({ kind: "initials" });
  });

  test("隐身模式：有头像地址也不自动加载", () => {
    const cache = { k1: { profile: { picture: "https://example.com/a.png" }, created_at: 0, fetched_at: 0 } };
    expect(avatarDisplay("k1", cache, true)).toEqual({ kind: "initials" });
  });

  test("开关按钮与 AvatarMark 接线", () => {
    expect(appSrc).toContain('"打开隐身模式（不自动加载头像）"');
    expect(appSrc).toContain('"关闭隐身模式（恢复自动加载头像）"');
    expect(appSrc).toContain("aria-pressed={incognitoMode}");
    expect(appSrc).toContain("saveIncognitoMode(incognitoMode)");
    expect(appSrc).toContain("setIncognitoMode((enabled) => !enabled)");
    expect(appSrc).toContain("<AvatarMark");
    expect(appSrc).toContain('referrerPolicy="no-referrer"');
  });

  test("帮助说明提到隐身模式", () => {
    expect(appSrc).toContain("隐身模式");
  });

  test("头像 img 与开关激活态样式存在", () => {
    expect(css).toContain(".avatar-mark img");
    expect(css).toContain(".icon-button.active");
  });
});

describe("文案：中继在线 / 资讯中继管理 / utility bar hover 提示", () => {
  test("标题状态显示 X/Y 中继在线", () => {
    expect(appSrc).toContain("中继在线");
    expect(appSrc).not.toContain("资讯源在线");
  });

  test("控制页面标题为资讯中继管理", () => {
    expect(appSrc).toContain("<h2>资讯中继管理</h2>");
    expect(appSrc).toContain('aria-label="打开资讯中继管理"');
    expect(appSrc).toContain('aria-label="关闭资讯中继管理"');
    expect(appSrc).not.toContain("资讯源管理");
  });

  test("utility bar 所有功能图标都有 hover 提示气泡", () => {
    expect(appSrc).toContain('title="打开资讯中继管理"');
    expect(appSrc).toContain('title="使用说明"');
    expect(appSrc).toContain('title="版本更新，重新下载"');
    expect(appSrc).toContain('title={viewMode === "manual" ? "手动刷新帖子" : "重新连接资讯源"}');
    expect(appSrc).toContain('title={pubkey ? `已连接（${signerType === "nip46" ? "远程签名器" : "浏览器扩展"}），点击管理` : "连接签名器"}');
    // 早已存在的两个：
    expect(appSrc).toContain('title={incognitoMode ? "隐身模式：不自动加载远程头像" : "普通模式：自动加载远程头像"}');
    expect(appSrc).toContain('title={filtersActive(filters) ? "筛选已开启：隐藏回复 / 屏蔽关键词" : "筛选帖子：隐藏回复、屏蔽关键词"}');
  });
});

describe("对话 thread（帖子详情里的回复）", () => {
  const note = (id: string, created_at: number) => ({
    id, pubkey: SAMPLE_HEX_PUBKEY, created_at, kind: 1, content: "x", sig: "s", tags: [], relays: ["wss://x"],
  });

  test("buildThreadFilter 按 e 标签拉回复", () => {
    expect(buildThreadFilter("abc123")).toEqual({ kinds: [1], "#e": ["abc123"], limit: THREAD_REPLIES_LIMIT });
    expect(THREAD_REPLIES_LIMIT).toBe(200);
  });

  test("mergeThreadEvents 去重并按时间正序", () => {
    const a = note("a", 300);
    const b = note("b", 100);
    const c = note("c", 200);
    const merged = mergeThreadEvents([a], [b, c, { ...a }]);
    expect(merged.map((e) => e.id)).toEqual(["b", "c", "a"]);
  });

  test("打开详情时订阅 thread，消息路由收回复", () => {
    expect(appSrc).toContain("requestThreadReplies(eventId)");
    expect(appSrc).toContain("buildThreadFilter(eventId)");
    expect(appSrc).toContain("`thread-${createUuid().slice(0, 8)}`");
    expect(appSrc).toContain("threadRequestRef.current");
    expect(appSrc).toContain("setThreadReplies");
    expect(appSrc).toContain("finishThreadReplies");
  });

  test("详情关闭时收回 thread 订阅并清空", () => {
    expect(appSrc).toContain("closeThreadSubs()");
  });

  test("详情页渲染对话区", () => {
    expect(appSrc).toContain('className="thread-section"');
    expect(appSrc).toContain('className="thread-list"');
    expect(appSrc).toContain("条回复");
    expect(appSrc).toContain("暂无回复");
  });

  test("thread 样式存在", () => {
    expect(css).toContain(".thread-section");
    expect(css).toContain(".thread-list");
    expect(css).toContain(".thread-reply");
  });
});

describe("对话 thread：详情事件来源", () => {
  test("详情优先从主 events 取，缺失时回退 thread 缓存", () => {
    const lookup = appSrc.match(/const detailEvent =[\s\S]*?: null;/)?.[0] ?? "";
    expect(lookup).toContain("findNoteById(detailEventId, [");
    expect(lookup).toContain("seenThreadEventsRef.current,");
    expect(appSrc).toContain("seenThreadEventsRef.current.set(threadEvent.id, threadEvent)");
    expect(appSrc).toContain("seenThreadEventsRef.current.clear()");
  });
});

describe("帖子详情：手动快照的老帖子也能打开", () => {
  test("detailEvent 同时查 events、manualEvents 与 thread 缓存", () => {
    const lookup = appSrc.match(/const detailEvent =[\s\S]*?: null;/)?.[0] ?? "";
    expect(lookup).toContain("findNoteById(detailEventId, [");
    expect(lookup).toContain("events,");
    // 手动模式卡片来自冻结快照 manualEvents，而 events 只保留最新 120 条；
    // 不查快照会导致点老帖子时详情打不开（点击展开全文没反应）。
    expect(lookup).toContain("manualEvents,");
    expect(lookup).toContain("seenThreadEventsRef.current,");
  });
});

describe("每日推荐中继（lulin.org API）", () => {
  const sample = {
    date: "2026-10-02",
    generated_at: "2026-10-02T00:00:00+00:00",
    pool_size: 93,
    picks: [{ url: "wss://relay.damus.io", name: "Damus", description: "Damus strfry relay" }],
  };

  test("relayPicksUrl 带 ?date= 当日（避开 SW 缓存）", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(RELAY_PICKS_URL).toBe("https://lulin.org/client/api/relay-picks.json");
    expect(relayPicksUrl()).toBe(`${RELAY_PICKS_URL}?date=${today}`);
  });

  test("isRelayPicks 校验文档结构", () => {
    expect(isRelayPicks(sample)).toBe(true);
    expect(isRelayPicks({ date: "x", picks: [{ url: 42 }] })).toBe(false);
    expect(isRelayPicks({ date: "x" })).toBe(false);
    expect(isRelayPicks(null)).toBe(false);
  });

  test("fetchRelayPicks 首选当日 URL，404 时回退", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: string) => {
      calls.push(url);
      if (url.includes("?date=")) return { ok: false, status: 404 } as any;
      return { ok: true, json: async () => sample } as any;
    };
    try {
      const picks = await fetchRelayPicks();
      expect(picks?.picks[0]?.url).toBe("wss://relay.damus.io");
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain("?date=");
      expect(calls[1]).toBe(RELAY_PICKS_URL);
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });

  test("fetchRelayPicks 全失败返回 null", async () => {
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => { throw new Error("down"); };
    try {
      expect(await fetchRelayPicks()).toBeNull();
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });

  test("中继面板接线：打开面板拉取、推荐区 UI、加入按钮", () => {
    expect(appSrc).toContain("fetchRelayPicks()");
    expect(appSrc).toContain("if (!panelOpen) return;");
    expect(appSrc).toContain("每日推荐");
    expect(appSrc).toContain('className="relay-picks"');
    expect(appSrc).toContain("addRelayUrl(pick.url)");
    expect(appSrc).toContain("已在列表");
    expect(appSrc).toContain("function addRelayUrl(url: string): boolean");
  });

  test("推荐区样式存在", () => {
    expect(css).toContain(".relay-picks");
    expect(css).toContain(".relay-pick-info");
    expect(css).toContain(".pick-add");
  });
});
