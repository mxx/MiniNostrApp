// Site name injection: site.config.json -> __SITE_NAME__ placeholder.
//
// src/App.tsx declares `__SITE_NAME__` as an external global const, so the
// bundler leaves the identifier untouched in the emitted JS. After
// buildClient() finishes, injectSiteName() lexically replaces the
// placeholder in every emitted asset JS file with the JSON-encoded site
// name, and injectSiteTitle() rewrites the <title> in dist/index.html.
// The website name is therefore a config item (site.config.json), not
// hardcoded in source.
//
// Two entry points share this module:
//  - build.mjs (real pipeline, runs after the SDK build);
//  - tests (test/showcase.test.ts exercises getSiteName/injectSiteName).

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SITE_CONFIG_FILE = "site.config.json";
export const SITE_NAME_PLACEHOLDER = "__SITE_NAME__";
export const DEFAULT_SITE_NAME = "绿野仙踪";

/** 网站名取自 site.config.json 的 name 字段；缺失/非法时回退为默认值。 */
export function getSiteName(clientDir) {
  try {
    const raw = readFileSync(join(clientDir, SITE_CONFIG_FILE), "utf8");
    const parsed = JSON.parse(raw);
    const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
    return name || DEFAULT_SITE_NAME;
  } catch {
    return DEFAULT_SITE_NAME;
  }
}

/**
 * 把产物 JS 中的 __SITE_NAME__ 占位符替换为网站名。
 * 返回被改写的文件名列表。
 */
export function injectSiteName(assetsDir, siteName) {
  const changed = [];
  for (const name of readdirSync(assetsDir)) {
    if (!name.endsWith(".js")) continue;
    const path = join(assetsDir, name);
    const code = readFileSync(path, "utf8");
    if (!code.includes(SITE_NAME_PLACEHOLDER)) continue;
    const replaced = code.replace(
      new RegExp(`\\b${SITE_NAME_PLACEHOLDER}\\b`, "g"),
      JSON.stringify(siteName),
    );
    writeFileSync(path, replaced);
    changed.push(name);
  }
  return changed;
}

/** 把 dist/index.html 的 <title> 改写为网站名；没有 <title> 时原样返回 false。 */
export function injectSiteTitle(indexHtmlPath, siteName) {
  const html = readFileSync(indexHtmlPath, "utf8");
  if (!/<title>[^<]*<\/title>/.test(html)) return false;
  const escaped = siteName.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  writeFileSync(
    indexHtmlPath,
    html.replace(/<title>[^<]*<\/title>/, `<title>${escaped}</title>`),
  );
  return true;
}
