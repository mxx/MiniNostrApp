// Standalone static-deploy helper: stages sw.js + site icons into dist/ and
// injects the full emitted-file list into the service worker's precache
// marker, so one online visit caches the entire app.
//
// Two entry points share this module:
//  - build.mjs, when MININOSTR_STANDALONE=1 (real pipeline);
//  - by hand before uploading to a plain static host:
//      bun scripts/standalone-sw.mjs        (run from client/)
//
// The marker in sw.js source:
//   const PRECACHE_URLS = /* __PRECACHE_URLS__ */ ["./", "./index.html"]

import { copyFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PRECACHE_MARKER = '/* __PRECACHE_URLS__ */ ["./", "./index.html"]';
export const STATIC_FILES = ["sw.js", "favicon.ico", "apple-touch-icon.png"];

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(absolute)));
    else files.push(absolute);
  }
  return files;
}

export async function buildStandaloneSw(clientDir, distDir) {
  for (const name of STATIC_FILES) {
    await copyFile(resolve(clientDir, name), resolve(distDir, name));
  }
  // Inject every emitted file into the install list. This makes one online
  // visit sufficient: registration happens after load, but install still
  // fetches the JS/CSS that the uncontrolled first page view could not cache.
  const emitted = (await listFiles(distDir))
    .map((absolute) => relative(distDir, absolute).split(sep).join("/"))
    .filter((path) => path !== "sw.js")
    .map((path) => `./${path}`)
    .sort();
  const precacheUrls = [...new Set(["./", ...emitted])];
  const template = await Bun.file(resolve(clientDir, "sw.js")).text();
  if (!template.includes(PRECACHE_MARKER)) {
    throw new Error("sw.js precache marker missing — refusing to write a worker with a stale list");
  }
  const worker = template.replace(PRECACHE_MARKER, JSON.stringify(precacheUrls));
  await Bun.write(resolve(distDir, "sw.js"), worker);
  return precacheUrls;
}

const invokedAsMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  const clientDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const urls = await buildStandaloneSw(clientDir, resolve(clientDir, "dist"));
  console.log(`standalone sw.js written (${urls.length} precache urls)`);
}
