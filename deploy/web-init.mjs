#!/usr/bin/env node
// web-init — put the built client into the served webroot, with the real bearer substituted in.
//
// The client reads its `/v1` bearer from `import.meta.env.VITE_API_TOKEN` (`client/src/api/client.ts`),
// which Vite inlines at *build* time. The image is built with the sentinel below instead of a real
// token (`deploy/Dockerfile`), so no secret is baked into the image or the registry; this step puts
// the token in at container start, where `doppler run` has resolved it (`docs/DEPLOY.md`, "the client
// bearer").
//
// It fails closed. An empty token, or a build that kept no sentinel, is a red `web-init` and `web`
// never starts — better a deploy that does not come up than an app that silently answers 401.
//
// Usage: node deploy/web-init.mjs [--self-check]

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SENTINEL = "__ASTROLAB_API_TOKEN__";
const SOURCE = fileURLToPath(new URL("../client/dist", import.meta.url));
const TEXT = new Set([".js", ".html", ".css"]);

/** Every file under `dir`, relative to it. */
function walk(dir, root = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, root, out);
    else out.push(relative(root, path));
  }
  return out;
}

/** Copies `source` into `target`, replacing the sentinel in text files. Returns the replacement count. */
export function substitute(source, target, token) {
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  let replaced = 0;
  for (const rel of walk(target)) {
    if (!TEXT.has(extname(rel))) continue;
    const path = join(target, rel);
    const text = readFileSync(path, "utf8");
    if (!text.includes(SENTINEL)) continue;
    // `split`/`join`, not a regex: the token is arbitrary bytes and must not be read as a pattern.
    const parts = text.split(SENTINEL);
    replaced += parts.length - 1;
    writeFileSync(path, parts.join(token));
  }
  return replaced;
}

function run() {
  const token = (process.env.API_TOKEN ?? "").trim();
  if (token === "") {
    console.error("[web-init] API_TOKEN is empty — refusing to serve a client with no bearer");
    process.exit(1);
  }
  const webroot = process.env.WEBROOT ?? "/webroot";
  const replaced = substitute(SOURCE, webroot, token);
  if (replaced < 1) {
    console.error(
      `[web-init] the built client kept no ${SENTINEL} — refusing to serve a client with no bearer`,
    );
    process.exit(1);
  }
  console.log(`[web-init] webroot=${webroot} substituted=${replaced}`);
}

// Assert-based self-check: the sentinel is substituted, a file without it is untouched, and the count
// is the number of occurrences — the three things `run` gates on.
function selfCheck() {
  const tmp = mkdtempSync(join(tmpdir(), "web-init-selfcheck-"));
  const src = join(tmp, "src");
  const out = join(tmp, "out");
  mkdirSync(join(src, "assets"), { recursive: true });
  writeFileSync(join(src, "index.html"), `<html>${SENTINEL}</html>`);
  writeFileSync(join(src, "assets", "a.js"), `const a="${SENTINEL}",b="${SENTINEL}";`);
  writeFileSync(join(src, "assets", "b.css"), "body{}");
  try {
    const replaced = substitute(src, out, "tok");
    const cases = [
      ["substitutes every occurrence", replaced, 3],
      [
        "writes the token",
        readFileSync(join(out, "assets", "a.js"), "utf8"),
        'const a="tok",b="tok";',
      ],
      [
        "substitutes into html too",
        readFileSync(join(out, "index.html"), "utf8"),
        "<html>tok</html>",
      ],
      [
        "leaves a file without the sentinel alone",
        readFileSync(join(out, "assets", "b.css"), "utf8"),
        "body{}",
      ],
    ];
    let failed = 0;
    for (const [label, got, want] of cases) {
      if (got === want) console.log(`✓ ${label}`);
      else {
        failed += 1;
        console.error(`✗ ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      }
    }
    console.log(failed === 0 ? "self-check: all cases pass" : `self-check: ${failed} FAILED`);
    process.exit(failed === 0 ? 0 : 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv.includes("--self-check")) selfCheck();
else run();
