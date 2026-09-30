// Client bundle for the space.
//
// Bundling is owned by the SDK so every space produces an identical
// production-mode React bundle. See @hatch/space-sdk/build for the
// canonical Bun.build() configuration (entrypoint, outdir, NODE_ENV
// define, asset naming, tailwind plugin).

import { buildClient } from "@hatch/space-sdk/build";
import { fileURLToPath } from "node:url";

await buildClient();

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
