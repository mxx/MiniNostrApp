// Client bundle for the space.
//
// Bundling is owned by the SDK so every space produces an identical
// production-mode React bundle. See @hatch/space-sdk/build for the
// canonical Bun.build() configuration (entrypoint, outdir, NODE_ENV
// define, asset naming, tailwind plugin).

import { buildClient } from "@hatch/space-sdk/build";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

await buildClient();

// 标题栏版本号：由 `git describe` 生成，注入产物 JS 的 __APP_VERSION__ 占位符。
// 必须在 standalone-sw 之前执行，sw.js 的 precache 清单只关心文件名，不受内容替换影响。
{
  const { getAppVersion, injectAppVersion } = await import("./scripts/app-version.mjs");
  const clientDir = fileURLToPath(new URL("./", import.meta.url));
  const version = getAppVersion(clientDir);
  const changed = injectAppVersion(join(clientDir, "dist", "assets"), version);
  for (const name of changed) console.log(`app version ${version} injected into ${name}`);
}

// Standalone static deployments (e.g. lulin.org/client/) opt in to the
// service worker + site icons. Muse's artifact packager accepts exactly one
// JavaScript entry, so the artifact relies on the host shell's offline asset
// cache while still using the same localStorage data persistence. The
// static build sets MININOSTR_STANDALONE=1 and receives a root-scoped sw.js
// (with every emitted file precached) plus favicon.ico / apple-touch-icon.png
// beside index.html. The same step runs by hand via
// scripts/standalone-sw.mjs before uploading to a plain static host.
if (process.env.MININOSTR_STANDALONE === "1") {
  const { buildStandaloneSw } = await import("./scripts/standalone-sw.mjs");
  await buildStandaloneSw(
    fileURLToPath(new URL("./", import.meta.url)),
    fileURLToPath(new URL("./dist/", import.meta.url)),
  );
}
