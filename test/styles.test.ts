import { describe, expect, test } from "bun:test";

const cssPath = new URL("../src/theme.css", import.meta.url);
const appPath = new URL("../src/App.tsx", import.meta.url);
const css = await Bun.file(cssPath).text();
const appSrc = await Bun.file(appPath).text();

const DESIGN_TOKENS = [
  "--bg",
  "--surface",
  "--surface-raised",
  "--text",
  "--dim",
  "--border",
  "--accent",
  "--accent-soft",
  "--danger",
  "--warning",
  "--radius",
];

function rootBlock(): string {
  const match = css.match(/:root\s*\{([^}]*)\}/);
  return match?.[1] ?? "";
}

function darkBlock(): string {
  const match = css.match(/@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)\s*\{([^]*?)\n\}/);
  return match?.[1] ?? "";
}

/** 从 App.tsx 的 className 属性中提取全部 CSS 类 token。 */
function extractClassTokens(src: string): string[] {
  const tokens = new Set<string>();
  const attrRe = /className=(?:"([^"]*)"|`([^`]*)`|\{`([^`]*)`\}|"([^"]*)")/g;
  const push = (chunk: string) => {
    for (const t of chunk.split(/\s+/)) {
      if (/^[a-z][a-z0-9-]*$/.test(t) && t.length > 1) tokens.add(t);
    }
  };
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(src))) {
    const literal = m[1] ?? m[2] ?? m[4] ?? "";
    // 模板字面量：字面部分去掉 ${...} 插值
    const noInterp = literal.replace(/\$\{[^}]*\}/g, " ");
    push(noInterp);
    // 三元分支里的字符串字面量（条件类名）
    const tpl = m[3];
    if (tpl) {
      const ternRe = /\?\s*"([^"]*)"\s*:\s*"([^"]*)"/g;
      let tm: RegExpExecArray | null;
      while ((tm = ternRe.exec(tpl))) {
        push(tm[1]);
        push(tm[2]);
      }
    }
  }
  return [...tokens];
}

describe("设计 token（显示回归）", () => {
  test("浅色 :root 定义全部 token", () => {
    const root = rootBlock();
    for (const token of DESIGN_TOKENS) {
      expect(root.includes(`${token}:`), `${token} 缺失`).toBe(true);
    }
  });

  test("深色模式覆盖全部 token（--radius 为模式无关常量，继承 :root）", () => {
    const dark = darkBlock();
    expect(dark.length).toBeGreaterThan(0);
    for (const token of DESIGN_TOKENS) {
      if (token === "--radius") continue;
      expect(dark.includes(`${token}:`), `深色 ${token} 缺失`).toBe(true);
    }
  });

  test("所有 var(--x) 引用都有定义", () => {
    const defined = new Set<string>();
    for (const mm of css.matchAll(/(--[a-z-]+)\s*:/g)) defined.add(mm[1]);
    const missing: string[] = [];
    for (const mm of css.matchAll(/var\((--[a-z-]+)\)/g)) {
      if (!defined.has(mm[1])) missing.push(mm[1]);
    }
    expect(missing).toEqual([]);
  });
});

describe("className ↔ CSS 交叉检查（显示回归）", () => {
  test("App.tsx 引用的每个类都在 theme.css 有定义", () => {
    const tokens = extractClassTokens(appSrc);
    expect(tokens.length).toBeGreaterThan(20);
    const missing = tokens.filter((t) => !new RegExp(`\\.${t}(?![\\w-])`).test(css));
    expect(missing).toEqual([]);
  });
});

describe("布局不变量（等尺寸卡片网格）", () => {
  const rule = (selector: string): string => {
    const match = css.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`));
    return match?.[1] ?? "";
  };

  test("feed-list 使用 grid 多列", () => {
    expect(rule(".feed-list")).toContain("grid-template-columns");
  });

  test("note 卡片固定高度（等尺寸 box）", () => {
    expect(rule(".note")).toMatch(/height:\s*\d+px/);
  });

  test("卡片正文多行截断（line-clamp）", () => {
    expect(rule(".note-content")).toContain("-webkit-line-clamp");
  });

  test("新组件类存在：feed-tab / follow-button / avatar-img / expand-hint / follow-list", () => {
    for (const cls of [".feed-tab", ".follow-button", ".avatar-img", ".expand-hint", ".follow-list"]) {
      expect(new RegExp(`\\${cls}(?![\\w-])`).test(css), `${cls} 缺失`).toBe(true);
    }
  });
});
