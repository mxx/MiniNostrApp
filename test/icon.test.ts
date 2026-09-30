/**
 * 网站 icon 测试：
 *  - favicon.ico：合法 ICO，多尺寸 16/32/48；
 *  - apple-touch-icon.png：合法 PNG，180x180；
 *  - index.html 引用了这两个相对路径；
 *  - build.mjs 通过 scripts/standalone-sw.mjs 接入 standalone 流程；
 *  - standalone-sw.mjs：把 sw.js/icons 拷入 dist 并注入完整 precache 清单。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStandaloneSw, PRECACHE_MARKER, STATIC_FILES } from "../scripts/standalone-sw.mjs";

const ROOT = join(import.meta.dir, "..");

function read(rel: string): Buffer {
  return readFileSync(join(ROOT, rel));
}

function pngSize(buf: Buffer): [number, number] {
  // PNG signature(8) + IHDR: width/height big-endian at offset 16/20
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

describe("favicon.ico", () => {
  test("存在且为合法 ICO", () => {
    expect(existsSync(join(ROOT, "favicon.ico"))).toBe(true);
    const buf = read("favicon.ico");
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]));
  });

  test("包含 16/32/48 三种尺寸", () => {
    const buf = read("favicon.ico");
    const count = buf.readUInt16LE(4);
    const sizes = new Set<string>();
    for (let i = 0; i < count; i++) {
      const entry = buf.subarray(6 + i * 16, 6 + (i + 1) * 16);
      const w = entry[0] === 0 ? 256 : entry[0];
      const h = entry[1] === 0 ? 256 : entry[1];
      sizes.add(`${w}x${h}`);
    }
    expect(sizes.has("16x16")).toBe(true);
    expect(sizes.has("32x32")).toBe(true);
    expect(sizes.has("48x48")).toBe(true);
  });
});

describe("apple-touch-icon.png", () => {
  test("存在且为 180x180 PNG", () => {
    expect(existsSync(join(ROOT, "apple-touch-icon.png"))).toBe(true);
    expect(pngSize(read("apple-touch-icon.png"))).toEqual([180, 180]);
  });
});

describe("接线", () => {
  test("index.html 用相对路径引用两个图标", () => {
    const html = readFileSync(join(ROOT, "index.html"), "utf-8");
    expect(html).toContain('href="./favicon.ico"');
    expect(html).toContain('href="./apple-touch-icon.png"');
    expect(html).toContain("apple-touch-icon");
  });

  test("build.mjs 经 standalone-sw.mjs 接入（MININOSTR_STANDALONE）", () => {
    const build = readFileSync(join(ROOT, "build.mjs"), "utf-8");
    expect(build).toContain("MININOSTR_STANDALONE");
    expect(build).toContain("standalone-sw.mjs");
  });

  test("sw.js 源码保留 precache 占位标记", () => {
    const sw = readFileSync(join(ROOT, "sw.js"), "utf-8");
    expect(sw).toContain(PRECACHE_MARKER);
  });
});

describe("buildStandaloneSw", () => {
  test("拷贝静态文件并注入完整 precache 清单", async () => {
    const clientDir = mkdtempSync(join(tmpdir(), "sw-client-"));
    const distDir = join(clientDir, "dist");
    mkdirSync(join(distDir, "assets"), { recursive: true });
    for (const name of STATIC_FILES) writeFileSync(join(clientDir, name), `fake-${name}`);
    // sw.js 模板用占位标记
    writeFileSync(
      join(clientDir, "sw.js"),
      `const PRECACHE_URLS = ${PRECACHE_MARKER};`,
    );
    writeFileSync(join(distDir, "index.html"), "<html>");
    writeFileSync(join(distDir, "assets", "index-abc123.js"), "js");

    const urls = await buildStandaloneSw(clientDir, distDir);

    // 静态文件全部拷入 dist
    for (const name of STATIC_FILES) {
      expect(existsSync(join(distDir, name))).toBe(true);
    }
    // precache 注入了所有产物（含图标），sw.js 自身除外
    expect(urls).toContain("./");
    expect(urls).toContain("./index.html");
    expect(urls).toContain("./favicon.ico");
    expect(urls).toContain("./apple-touch-icon.png");
    expect(urls).toContain("./assets/index-abc123.js");
    expect(urls.some((u) => u.endsWith("sw.js"))).toBe(false);
    const worker = readFileSync(join(distDir, "sw.js"), "utf-8");
    expect(worker).toContain('"./assets/index-abc123.js"');
    expect(worker).not.toContain(PRECACHE_MARKER);
  });

  test("sw.js 缺占位标记时拒绝写入（避免发布过期清单）", async () => {
    const clientDir = mkdtempSync(join(tmpdir(), "sw-client-"));
    const distDir = join(clientDir, "dist");
    mkdirSync(distDir, { recursive: true });
    for (const name of STATIC_FILES) writeFileSync(join(clientDir, name), `fake-${name}`);
    writeFileSync(join(clientDir, "sw.js"), "const PRECACHE_URLS = [];");
    await expect(buildStandaloneSw(clientDir, distDir)).rejects.toThrow();
  });
});
