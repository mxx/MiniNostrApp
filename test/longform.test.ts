import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyFilters,
  isSafeHttpUrl,
  loadCachedLongforms,
  LONGFORM_KIND,
  LONGFORM_LIMIT,
  longformExcerpt,
  longformKey,
  MAX_LONGFORMS,
  mergeLongformEvents,
  parseLongformMeta,
  renderMarkdownHtml,
  saveCachedLongforms,
} from "../src/App";

const appSrc = readFileSync(join(__dirname, "../src/App.tsx"), "utf8");
const css = readFileSync(join(__dirname, "../src/theme.css"), "utf8");

type TestEvent = Parameters<typeof parseLongformMeta>[0];

function makeLongform(overrides: Partial<TestEvent> = {}): TestEvent {
  return {
    id: overrides.id ?? `id-${Math.random()}`,
    pubkey: overrides.pubkey ?? "pubkey-1",
    created_at: overrides.created_at ?? 1000,
    kind: LONGFORM_KIND,
    tags: overrides.tags ?? [],
    content: overrides.content ?? "",
    sig: "sig",
    relays: overrides.relays ?? [],
  };
}

describe("parseLongformMeta", () => {
  test("从标签提取标题、摘要、封面、发布时间与 d 标识", () => {
    const meta = parseLongformMeta(
      makeLongform({
        tags: [
          ["d", "my-article"],
          ["title", "标题"],
          ["summary", "摘要"],
          ["image", "https://example.com/cover.png"],
          ["published_at", "1700000000"],
        ],
      }),
    );
    expect(meta).toEqual({
      title: "标题",
      summary: "摘要",
      image: "https://example.com/cover.png",
      publishedAt: 1700000000,
      identifier: "my-article",
    });
  });

  test("缺标签时回退空值，非法 published_at 为 null", () => {
    const meta = parseLongformMeta(makeLongform({ tags: [["published_at", "not-a-number"]] }));
    expect(meta.title).toBe("");
    expect(meta.summary).toBe("");
    expect(meta.image).toBe("");
    expect(meta.publishedAt).toBeNull();
    expect(meta.identifier).toBe("");
  });
});

describe("longformKey / mergeLongformEvents", () => {
  test("键为 kind:pubkey:d", () => {
    expect(longformKey(makeLongform({ pubkey: "abc", tags: [["d", "x"]] }))).toBe("30023:abc:x");
    expect(longformKey(makeLongform({ pubkey: "abc" }))).toBe("30023:abc:");
  });

  test("同键只保留 created_at 最大的（NIP-33 可替换语义）", () => {
    const old = makeLongform({ id: "old", created_at: 100, tags: [["d", "x"]], content: "旧版" });
    const newer = makeLongform({ id: "new", created_at: 200, tags: [["d", "x"]], content: "新版" });
    const merged = mergeLongformEvents([old], [newer]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("new");
    // 旧版后到不覆盖新版
    expect(mergeLongformEvents([newer], [old])[0]?.id).toBe("new");
  });

  test("d 不同则视为不同文章，按时间倒序", () => {
    const a = makeLongform({ id: "a", created_at: 100, tags: [["d", "x"]] });
    const b = makeLongform({ id: "b", created_at: 300, tags: [["d", "y"]] });
    const merged = mergeLongformEvents([a], [b]);
    expect(merged.map((event) => event.id)).toEqual(["b", "a"]);
  });

  test("LONGFORM_LIMIT 为 20，缓存上限为 40", () => {
    expect(LONGFORM_KIND).toBe(30023);
    expect(LONGFORM_LIMIT).toBe(20);
    expect(MAX_LONGFORMS).toBe(40);
  });
});

describe("longformExcerpt", () => {
  test("优先用 summary 标签", () => {
    expect(longformExcerpt(makeLongform({ tags: [["summary", "摘要文本"]], content: "正文" }))).toBe("摘要文本");
  });

  test("无摘要时截正文前 140 字", () => {
    const long = "a".repeat(200);
    const excerpt = longformExcerpt(makeLongform({ content: long }));
    expect(excerpt).toBe(`${"a".repeat(140)}…`);
    expect(longformExcerpt(makeLongform({ content: "短" }))).toBe("短");
  });
});

describe("isSafeHttpUrl", () => {
  test("只放行 http(s)", () => {
    expect(isSafeHttpUrl("https://example.com/a.png")).toBe(true);
    expect(isSafeHttpUrl("http://example.com")).toBe(true);
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("data:text/html,<h1>x</h1>")).toBe(false);
    expect(isSafeHttpUrl("ftp://example.com")).toBe(false);
  });
});

describe("renderMarkdownHtml", () => {
  test("标题、粗体、斜体、分隔线", () => {
    const html = renderMarkdownHtml("# 大标题\n\n这是 **粗体** 和 *斜体*。\n\n---", true);
    expect(html).toContain("<h1>大标题</h1>");
    expect(html).toContain("<strong>粗体</strong>");
    expect(html).toContain("<em>斜体</em>");
    expect(html).toContain("<hr>");
  });

  test("链接只放行 http(s)，javascript: 按纯文本", () => {
    const html = renderMarkdownHtml("[站外](https://example.com) [坏](javascript:alert(1))", true);
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noreferrer">站外</a>');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("坏");
  });

  test("图片：普通模式输出 img，隐身模式只给链接", () => {
    const withImg = renderMarkdownHtml("![封面](https://example.com/c.png)", true);
    expect(withImg).toContain('<img src="https://example.com/c.png"');
    expect(withImg).toContain('referrerpolicy="no-referrer"');
    const hidden = renderMarkdownHtml("![封面](https://example.com/c.png)", false);
    expect(hidden).not.toContain("<img");
    expect(hidden).toContain("隐身模式未加载");
  });

  test("原始 HTML 被转义，不执行脚本", () => {
    const html = renderMarkdownHtml('<script>alert(1)</script>\n\n```\n<script>alert(2)</script>\n```', true);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("<pre><code>");
  });

  test("行内代码里的 markdown 语法不被解释", () => {
    const html = renderMarkdownHtml("这是 `**不是粗体**` 的代码", true);
    expect(html).toContain("<code>**不是粗体**</code>");
    expect(html).not.toContain("<strong>");
  });

  test("引用与列表", () => {
    const html = renderMarkdownHtml("> 引用一句\n\n- 一\n- 二\n\n1. 甲\n2. 乙", true);
    expect(html).toContain("<blockquote>引用一句</blockquote>");
    expect(html).toContain("<ul><li>一</li><li>二</li></ul>");
    expect(html).toContain("<ol><li>甲</li><li>乙</li></ol>");
  });

  test("裸 URL 自动成链", () => {
    const html = renderMarkdownHtml("看看 https://example.com 好站", true);
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noreferrer">https://example.com</a>');
  });

  test("裸 URL 不吞掉后面的中文标点", () => {
    const html = renderMarkdownHtml("看看 https://lulin.org。还有", true);
    expect(html).toContain('href="https://lulin.org"');
    expect(html).toContain("</a>。还有");
  });

  test("非法协议的链接不残留括号", () => {
    const html = renderMarkdownHtml("[坏链接](javascript:alert(1)) 不应可点", true);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("坏链接)");
    expect(html).toContain("坏链接 不应可点");
  });

  test("表格等不支持的语法按段落原文显示", () => {
    const html = renderMarkdownHtml("| a | b |\n|---|---|\n| 1 | 2 |", true);
    expect(html).toContain("<p>");
    expect(html).not.toContain("<table>");
  });

  test("CRLF 换行不会死循环（真实长文曾因此卡死浏览器）", () => {
    const html = renderMarkdownHtml("# 标题\r\n\r\n段落 **粗体**\r\n\r\n- 列表\r\n> 引用\r\n", true);
    expect(html).toContain("<h1>标题</h1>");
    expect(html).toContain("<strong>粗体</strong>");
    expect(html).toContain("<ul><li>列表</li></ul>");
    expect(html).toContain("<blockquote>引用</blockquote>");
    expect(html).not.toContain("\r");
  });

  test("单独 CR 换行同样处理", () => {
    const html = renderMarkdownHtml("# 标题\r段落\r", true);
    expect(html).toContain("<h1>标题</h1>");
    expect(html).toContain("<p>段落</p>");
  });
});

describe("长文缓存", () => {
  beforeEach(() => localStorage.clear());

  test("存取往返，只保留 kind 30023", () => {
    saveCachedLongforms([
      makeLongform({ id: "keep" }),
      { ...makeLongform({ id: "drop" }), kind: 1 },
    ]);
    const loaded = loadCachedLongforms();
    expect(loaded.map((event) => event.id)).toEqual(["keep"]);
  });

  test("损坏的 JSON 回退空数组", () => {
    localStorage.setItem("nostr-min-longforms-v1", "{broken");
    expect(loadCachedLongforms()).toEqual([]);
  });
});

describe("长文筛选", () => {
  const filters = { hideReplies: true, mutedKeywords: ["广告"] };

  test("关键词对标题、摘要、正文都生效", () => {
    const byTitle = makeLongform({ id: "t", tags: [["title", "广告勿扰"]], content: "正文" });
    const bySummary = makeLongform({ id: "s", tags: [["summary", "这是广告"]], content: "正文" });
    const byContent = makeLongform({ id: "c", content: "正文里有广告" });
    const clean = makeLongform({ id: "ok", tags: [["title", "干净标题"]], content: "干净正文" });
    expect(applyFilters([byTitle, bySummary, byContent, clean], filters).map((e) => e.id)).toEqual(["ok"]);
  });

  test("隐藏回复不影响长文", () => {
    const article = makeLongform({ id: "a", tags: [["e", "parent-id"]], content: "正文" });
    expect(applyFilters([article], { hideReplies: true, mutedKeywords: [] })).toHaveLength(1);
  });
});

describe("长文接线", () => {
  test("订阅了 kind 30023（与 kind-1 分开）", () => {
    expect(appSrc).toContain("longformSubId");
    expect(appSrc).toContain("kinds: [LONGFORM_KIND]");
    expect(appSrc).toContain("LONGFORM_LIMIT");
    expect(appSrc).toContain("addLongformEvent");
  });

  test("有长文标签页、卡片与详情", () => {
    expect(appSrc).toContain('"longform"');
    expect(appSrc).toContain("LongformCard");
    expect(appSrc).toContain("longformDetail");
    expect(appSrc).toContain("renderMarkdownHtml");
    expect(appSrc).toContain("dangerouslySetInnerHTML");
    expect(appSrc).toContain("KIND 30023 LONGFORM");
  });

  test("帮助中说明了长文", () => {
    expect(appSrc).toContain("「长文」标签页显示资讯源里的 NIP-23 长文");
  });

  test("长文样式存在", () => {
    expect(css).toContain(".longform-body");
    expect(css).toContain(".longform-badge");
    expect(css).toContain(".longform-open");
    expect(css).toContain(".longform-cover");
  });
});
