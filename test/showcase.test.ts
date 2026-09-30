import { beforeEach, describe, expect, test } from "bun:test";
import {
  AUTO_ADVANCE_MS,
  AUTO_EXIT_MS,
  buildReplyTags,
  loadViewMode,
  nextAutoIndex,
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

describe("自动轮播序号", () => {
  test("正常递进", () => {
    expect(nextAutoIndex(0, 3)).toBe(1);
    expect(nextAutoIndex(1, 3)).toBe(2);
  });

  test("末尾回到开头", () => {
    expect(nextAutoIndex(2, 3)).toBe(0);
  });

  test("空列表停在 0", () => {
    expect(nextAutoIndex(0, 0)).toBe(0);
    expect(nextAutoIndex(3, 0)).toBe(0);
  });

  test("越界 / 非法序号回到开头", () => {
    expect(nextAutoIndex(5, 3)).toBe(0);
    expect(nextAutoIndex(-1, 3)).toBe(0);
    expect(nextAutoIndex(Number.NaN, 3)).toBe(0);
  });

  test("时间常量合理：退出动画短于停留时长", () => {
    expect(AUTO_ADVANCE_MS).toBeGreaterThan(0);
    expect(AUTO_EXIT_MS).toBeGreaterThan(0);
    expect(AUTO_EXIT_MS).toBeLessThan(AUTO_ADVANCE_MS);
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

describe("自动轮播样式（显示回归）", () => {
  test("进入 / 退出关键帧存在", () => {
    expect(css).toContain("@keyframes auto-enter-tl");
    expect(css).toContain("@keyframes auto-exit-br");
    expect(css).toContain("@keyframes auto-progress-fill");
  });

  test("进入动画从左上开始（负位移）", () => {
    expect(css).toContain("translate(-64px, -64px)");
  });

  test("退出动画向右下挤出（正位移 + 缩小）", () => {
    expect(css).toContain("translate(72px, 72px)");
    expect(css).toContain("scale(.8)");
  });

  test("舞台无滚动（overflow hidden）", () => {
    const stage = css.match(/\.auto-stage\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(stage).toContain("overflow");
    expect(stage).toContain("hidden");
  });

  test("新组件类齐全", () => {
    for (const cls of [
      "view-switch",
      "view-option",
      "auto-stage",
      "auto-note",
      "auto-enter",
      "auto-exit",
      "auto-bar",
      "auto-pause",
      "auto-count",
      "auto-hint",
      "auto-progress",
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

describe("App 接线（自动模式 / 回复）", () => {
  test("轮播定时器使用导出的时间常量", () => {
    expect(appSrc).toContain("AUTO_ADVANCE_MS");
    expect(appSrc).toContain("AUTO_EXIT_MS");
  });

  test("回复经 publishNote + buildReplyTags 发布", () => {
    expect(appSrc).toContain("buildReplyTags(target)");
    expect(appSrc).toContain("publishNote(content,");
  });

  test("悬停卡片暂停轮播", () => {
    expect(appSrc).toContain("onMouseEnter");
    expect(appSrc).toContain("setAutoPaused(true)");
    expect(appSrc).toContain("setAutoPaused(false)");
  });

  test("弹窗打开时不推进", () => {
    expect(appSrc).toContain("modalOpen");
  });

  test("新帖到达时跳到最新", () => {
    expect(appSrc).toContain("headIdRef");
  });

  test("卡片与详情页都有回复入口", () => {
    expect(appSrc).toContain("openReply");
    expect(appSrc).toContain("reply-context");
  });
});
