import { beforeEach, describe, expect, test } from "bun:test";
import {
  MARQUEE_CARD_W,
  MARQUEE_GAP,
  MARQUEE_MAX_NOTES,
  MARQUEE_RESET_THRESHOLD,
  MARQUEE_ROWS,
  MARQUEE_SPEEDS,
  MARQUEE_STEP,
  buildReplyTags,
  loadViewMode,
  marqueePrepend,
  marqueeRecycle,
  marqueeStepOffset,
  saveViewMode,
} from "../src/App";
import { installLocalStorageMock, SAMPLE_HEX_ID, SAMPLE_HEX_PUBKEY } from "./fixtures";

installLocalStorageMock();

const css = await Bun.file(new URL("../src/theme.css", import.meta.url)).text();
const appSrc = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();

describe("浏览模式持久化（自动 / 手动）", () => {
  beforeEach(() => localStorage.clear());

  test("默认自动模式", () => {
    expect(loadViewMode()).toBe("auto");
  });

  test("manual 往返", () => {
    saveViewMode("manual");
    expect(loadViewMode()).toBe("manual");
  });

  test("auto 往返", () => {
    saveViewMode("auto");
    expect(loadViewMode()).toBe("auto");
  });

  test("非法值回退到 auto", () => {
    localStorage.setItem("nostr-min-view-mode-v1", "slideshow");
    expect(loadViewMode()).toBe("auto");
  });

  test("App 默认 state 使用 loadViewMode", () => {
    expect(appSrc).toContain("useState<ViewMode>(loadViewMode)");
  });

  test("模式切换写入 localStorage", () => {
    expect(appSrc).toContain("saveViewMode(viewMode)");
  });
});

describe("跑马灯数学（从左进入、向右溢出）", () => {
  test("步进：offset 随时间增大（向右流动）", () => {
    expect(marqueeStepOffset(0, 1000, 80)).toBe(80);
    expect(marqueeStepOffset(10, 500, 80)).toBe(50);
    expect(marqueeStepOffset(0, 0, 80)).toBe(0);
  });

  test("循环：右端整张溢出后搬到最左端，offset 回退一步", () => {
    const r = marqueeRecycle(["a", "b", "c"], MARQUEE_STEP, MARQUEE_STEP);
    expect(r.items).toEqual(["c", "a", "b"]);
    expect(r.offset).toBe(0);
  });

  test("循环：未溢出时原样返回", () => {
    const items = ["a", "b", "c"];
    const r = marqueeRecycle(items, MARQUEE_STEP - 1, MARQUEE_STEP);
    expect(r.items).toBe(items);
    expect(r.offset).toBe(MARQUEE_STEP - 1);
  });

  test("循环：不足两张不搬", () => {
    expect(marqueeRecycle(["a"], MARQUEE_STEP * 2, MARQUEE_STEP).items).toEqual(["a"]);
    expect(marqueeRecycle([], MARQUEE_STEP * 2, MARQUEE_STEP).items).toEqual([]);
  });

  test("新帖前置：队首加新帖，offset 左移相同步数", () => {
    const r = marqueePrepend(["b", "c"], 0, ["a"], MARQUEE_STEP);
    expect(r.items).toEqual(["a", "b", "c"]);
    expect(r.offset).toBe(-MARQUEE_STEP);
  });

  test("新帖前置：多个新帖保持最新在最左", () => {
    const r = marqueePrepend(["c"], 0, ["a", "b"], MARQUEE_STEP);
    expect(r.items).toEqual(["a", "b", "c"]);
    expect(r.offset).toBe(-2 * MARQUEE_STEP);
  });

  test("新帖前置：空 fresh 原样返回", () => {
    const items = ["b", "c"];
    const r = marqueePrepend(items, 5, [], MARQUEE_STEP);
    expect(r.items).toBe(items);
    expect(r.offset).toBe(5);
  });

  test("常量合理", () => {
    expect(MARQUEE_ROWS).toBe(2);
    expect(MARQUEE_STEP).toBe(MARQUEE_CARD_W + MARQUEE_GAP);
    expect(MARQUEE_CARD_W).toBe(300);
    expect(MARQUEE_GAP).toBe(16);
    expect(MARQUEE_SPEEDS).toHaveLength(MARQUEE_ROWS);
    for (const speed of MARQUEE_SPEEDS) expect(speed).toBeGreaterThan(0);
    expect(MARQUEE_MAX_NOTES).toBeGreaterThan(0);
    expect(MARQUEE_RESET_THRESHOLD).toBeGreaterThan(0);
    expect(MARQUEE_RESET_THRESHOLD).toBeLessThan(MARQUEE_MAX_NOTES);
  });
});

describe("NIP-10 回复标签", () => {
  test("e 标签带中继提示与 reply 标记，p 标签指向原作者", () => {
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

  test("无可用中继提示时 hint 为空字符串", () => {
    const tags = buildReplyTags({ id: SAMPLE_HEX_ID, pubkey: SAMPLE_HEX_PUBKEY, relays: ["本地发布"] });
    expect(tags[0]).toEqual(["e", SAMPLE_HEX_ID, "", "reply"]);
    expect(tags[1]).toEqual(["p", SAMPLE_HEX_PUBKEY]);
  });

  test("空 relays 不崩", () => {
    const tags = buildReplyTags({ id: SAMPLE_HEX_ID, pubkey: SAMPLE_HEX_PUBKEY, relays: [] });
    expect(tags).toHaveLength(2);
  });
});

describe("跑马灯样式（显示回归）", () => {
  test("旧单卡轮播动画已移除", () => {
    expect(css).not.toContain("@keyframes auto-enter-tl");
    expect(css).not.toContain("@keyframes auto-exit-br");
    expect(css).not.toContain("@keyframes auto-progress-fill");
    expect(css).not.toContain("auto-progress");
  });

  test("行容器裁掉溢出（卡片从左右两端进出）", () => {
    const row = css.match(/\.marquee-row\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(row).toContain("overflow");
    expect(row).toContain("hidden");
  });

  test("轨道是横向弹性行，JS 步长与 CSS 一致", () => {
    const track = css.match(/\.marquee-track\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(track).toContain("display: flex");
    expect(track).toContain("gap: 16px");
    const card = css.match(/\.marquee-card\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(card).toContain("300px");
  });

  test("自动模式锁定视口无滚动", () => {
    const shell = css.match(/\.app-shell\.auto-mode\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(shell).toContain("100dvh");
    expect(shell).toContain("overflow: hidden");
  });

  test("新组件类齐全", () => {
    for (const cls of [
      "view-switch",
      "view-option",
      "auto-stage",
      "marquee-rows",
      "marquee-row",
      "marquee-track",
      "marquee-card",
      "auto-bar",
      "auto-pause",
      "auto-count",
      "auto-hint",
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

describe("App 接线（跑马灯 / 回复）", () => {
  test("跑马灯用 rAF 驱动并写 translate3d", () => {
    expect(appSrc).toContain("requestAnimationFrame");
    expect(appSrc).toContain("translate3d(");
  });

  test("回复经 publishNote + buildReplyTags 发布", () => {
    expect(appSrc).toContain("buildReplyTags(target)");
    expect(appSrc).toContain("publishNote(content,");
  });

  test("悬停暂停跑马灯", () => {
    expect(appSrc).toContain("onMouseEnter");
    expect(appSrc).toContain("setAutoPaused(true)");
    expect(appSrc).toContain("setAutoPaused(false)");
  });

  test("弹窗打开或减少动态时不推进", () => {
    expect(appSrc).toContain("modalOpen");
    expect(appSrc).toContain("prefers-reduced-motion");
  });

  test("新帖从左侧进入（前置 + 跑马灯行）", () => {
    expect(appSrc).toContain("marqueePrepend");
    expect(appSrc).toContain("MarqueeRow");
  });

  test("手动模式冻结快照，只有刷新按钮主动更新", () => {
    expect(appSrc).toContain("const [manualEvents, setManualEvents]");
    expect(appSrc).toContain("function refreshManualFeed()");
    expect(appSrc).toContain('aria-label="手动刷新帖子"');
  });

  test("跑马灯卡片复用 NoteCard，保留回复入口", () => {
    expect(appSrc).toContain("marquee-card");
    expect(appSrc).toContain("openReply");
    expect(appSrc).toContain("reply-context");
  });
});
