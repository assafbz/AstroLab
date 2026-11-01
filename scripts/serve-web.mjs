/**
 * Serve a built web bundle with the cross-origin-isolation headers `expo-sqlite`'s web target needs.
 *
 * `app/dist` is a plain static export, and no Expo config can set response headers on it — dev-server
 * middleware does not travel to a host (that limitation is recorded in `app/metro.config.js`). Without
 * `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: credentialless` the page is
 * not cross-origin isolated, `SharedArrayBuffer` is undefined, and the vault cannot open (#186). So the
 * run path ships its host here rather than in a scratch directory nobody can reproduce.
 *
 * **A local run host, not a production server**: one static dir, one port, no caching, no compression,
 * no directory listing, no HTTPS. Shipping the web build means picking a host and setting these same two
 * headers on it — an owner-level decision that is still open (see `app/README.md`).
 *
 *   node scripts/serve-web.mjs [dir] [port]     # defaults: app/dist, 8090
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? "app/dist");
const port = Number(process.argv[3] ?? 8090);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`serve-web: no directory at ${root} — build it first (npm run build)`);
  process.exit(1);
}

createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent((req.url ?? "/").split("?")[0]);
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }
  if (pathname.endsWith("/")) pathname += "index.html";

  const file = join(root, normalize(pathname));
  // `join` + `normalize` collapses `..`, but keep the containment check so a crafted path cannot escape.
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
    return;
  }

  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "credentialless",
  });
  res.end(readFileSync(file));
}).listen(port, "127.0.0.1", () => {
  console.log(
    `serving ${root} → http://127.0.0.1:${port} (COOP: same-origin · COEP: credentialless)`,
  );
});
