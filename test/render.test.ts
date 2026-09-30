import { describe, expect, test } from "bun:test";
import { FormattedNote, renderInline } from "../src/App";
import { SAMPLE_NPUB } from "./fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

function kids(el: any): any[] {
  const c = el?.props?.children;
  if (Array.isArray(c)) return c;
  return c === undefined || c === null ? [] : [c];
}

function textOf(node: any): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as any).props.children);
  return "";
}

describe("renderInline", () => {
  test("纯文本原样返回", () => {
    expect(renderInline("hello world", "k")).toEqual(["hello world"]);
  });

  test("URL 转链接并剥离尾部标点", () => {
    const parts = renderInline("看 https://example.com/x。", "k");
    const link = parts.find((p: any) => p?.type === "a") as any;
    expect(link).toBeDefined();
    expect(link.props.href).toBe("https://example.com/x");
    expect(textOf(link)).toBe("example.com/x");
    expect(link.props.target).toBe("_blank");
    // 尾部句号被剥离为独立文本节点
    expect(parts.some((p: any) => p?.type === "span" && textOf(p) === "。")).toBe(true);
  });

  test("URL 标签显示 host+path（query 按既有行为省略）", () => {
    const parts = renderInline("https://example.com/a/b?x=1", "k");
    const link = parts.find((p: any) => p?.type === "a") as any;
    expect(link.props.href).toBe("https://example.com/a/b?x=1");
    expect(textOf(link)).toBe("example.com/a/b");
  });

  test("nostr: npub 显示缩短码并保留完整 title", () => {
    const parts = renderInline(`提到了 nostr:${SAMPLE_NPUB} 好`, "k");
    const token = parts.find((p: any) => p?.props?.className === "nostr-token") as any;
    expect(token).toBeDefined();
    expect(token.props.title).toBe(`nostr:${SAMPLE_NPUB}`);
    expect(textOf(token)).toBe(`${SAMPLE_NPUB.slice(0, 8)}…${SAMPLE_NPUB.slice(-6)}`);
  });

  test("不带 nostr: 前缀的 npub 同样识别", () => {
    const parts = renderInline(SAMPLE_NPUB, "k");
    const token = parts.find((p: any) => p?.props?.className === "nostr-token") as any;
    expect(token?.props.title).toBe(SAMPLE_NPUB);
  });

  test("hashtag 高亮", () => {
    const parts = renderInline("聊聊 #比特币 吧", "k");
    const tag = parts.find((p: any) => p?.props?.className === "hashtag") as any;
    expect(textOf(tag)).toBe("#比特币");
  });
});

describe("FormattedNote", () => {
  test("空字符串显示占位", () => {
    const el = FormattedNote({ content: "" }) as any;
    expect(el.type).toBe("span");
    expect(el.props.className).toBe("muted");
  });

  test("纯空白内容按既有行为渲染空段落（非占位）", () => {
    const el = FormattedNote({ content: "   " }) as any;
    expect(el.type).toBe("div");
    expect(textOf(el)).toBe("");
  });

  test("列表块渲染为 ul/li", () => {
    const el = FormattedNote({ content: "- 苹果\n- 香蕉" }) as any;
    expect(el.props.className).toBe("note-prose");
    const blocks = kids(el);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("ul");
    expect(kids(blocks[0])).toHaveLength(2);
    expect(textOf(blocks[0])).toContain("苹果");
    expect(textOf(blocks[0])).toContain("香蕉");
  });

  test("引用块渲染为 blockquote", () => {
    const el = FormattedNote({ content: "> 引用的话" }) as any;
    const blocks = kids(el);
    expect(blocks[0].type).toBe("blockquote");
    expect(textOf(blocks[0])).toContain("引用的话");
  });

  test("空行分段为多个 p", () => {
    const el = FormattedNote({ content: "第一段\n\n第二段" }) as any;
    const blocks = kids(el);
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b: any) => b.type === "p")).toBe(true);
  });

  test("段内单换行保留 br", () => {
    const el = FormattedNote({ content: "行一\n行二" }) as any;
    const blocks = kids(el);
    expect(blocks).toHaveLength(1);
    const brs = kids(blocks[0]).flatMap((s: any) => kids(s)).filter((n: any) => n?.type === "br");
    expect(brs.length).toBeGreaterThan(0);
  });
});
