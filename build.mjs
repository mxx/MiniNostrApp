// Client bundle for the space.
//
// Bundling is owned by the SDK so every space produces an identical
// production-mode React bundle. See @hatch/space-sdk/build for the
// canonical Bun.build() configuration (entrypoint, outdir, NODE_ENV
// define, asset naming, tailwind plugin).

import { buildClient } from "@hatch/space-sdk/build";
import { fileURLToPath } from "node:url";

await buildClient();

// Ship the service worker next to the bundle: the SDK only emits bundled
// output, so copy the app-scope sw.js into dist/ for static hosts.
// (Runs only in the real pipeline — hand builds exit inside buildClient.)
const distDir = fileURLToPath(new URL("./dist/", import.meta.url));
const swSource = fileURLToPath(new URL("./sw.js", import.meta.url));
await Bun.write(`${distDir}sw.js`, Bun.file(swSource));
