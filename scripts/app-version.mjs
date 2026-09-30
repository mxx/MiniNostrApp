// App version injection: `git describe` -> __APP_VERSION__ placeholder.
//
// src/App.tsx declares `__APP_VERSION__` as an external global const, so the
// bundler leaves the identifier untouched in the emitted JS. After
// buildClient() finishes, injectAppVersion() lexically replaces the
// placeholder in every emitted asset JS file with the JSON-encoded version.
//
// Two entry points share this module:
//  - build.mjs (real pipeline, runs after the SDK build);
//  - tests (test/showcase.test.ts exercises getAppVersion/injectAppVersion).

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const APP_VERSION_PLACEHOLDER = "__APP_VERSION__";

/** 版本号由 `git describe --tags --always --dirty` 生成；失败时回退为 "dev"。 */
export function getAppVersion(cwd) {
  try {
    const out = execFileSync("git", ["describe", "--tags", "--always", "--dirty"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || "dev";
  } catch {
    return "dev";
  }
}

/**
 * 把产物 JS 中的 __APP_VERSION__ 占位符替换为版本号。
 * 返回被改写的文件名列表。
 */
export function injectAppVersion(assetsDir, version) {
  const changed = [];
  for (const name of readdirSync(assetsDir)) {
    if (!name.endsWith(".js")) continue;
    const path = join(assetsDir, name);
    const code = readFileSync(path, "utf8");
    if (!code.includes(APP_VERSION_PLACEHOLDER)) continue;
    const replaced = code.replace(
      new RegExp(`\\b${APP_VERSION_PLACEHOLDER}\\b`, "g"),
      JSON.stringify(version),
    );
    writeFileSync(path, replaced);
    changed.push(name);
  }
  return changed;
}
