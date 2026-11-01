/**
 * Gate 2 for the web vault's cold-load row: the boot must post **no write statement** over the
 * synchronous `expo-sqlite` worker channel (#186).
 *
 * Why this exists: the sync channel answers inside a main-thread busy-wait with a hard iteration cap
 * (`expo-sqlite/web/WorkerChannel.ts` `invokeWorkerSync`, ~133 ms on a 2-core box). Heavy *writes* —
 * the WAL conversion, DDL, `COMMIT`/`ROLLBACK`, `PRAGMA … = …`, the seed's upserts — can exceed it and
 * throw `Sync operation timeout` on a cold load. Reads are micro-seconds and stay synchronous, so the
 * fixed state is *"zero sync writes"*, not "zero sync calls". A green pass/fail row alone cannot tell a
 * fix from a lucky draw; this measures the mechanism.
 *
 * The rule, from the library at source (`58.0.13`): `data.source` (the SQL) is present **only** on the
 * `exec` and `prepare` messages. `run`/`step`/`getAll`/`finalize` carry none — and `executeSync` posts
 * `run`, which the app adapter uses for **reads** too. So a raw count of sync `run`s is a false red;
 * the check is `exec`/`prepare` filtered on `source`.
 *
 *   npm run build -w app
 *   node scripts/gate2-cold-load.mjs [n] [dir] [port]      # defaults: 25, app/dist, 8090
 *   node scripts/gate2-cold-load.mjs --selftest            # classifier · verdict · arg parsing, no browser
 *     also: --url <url> (serve elsewhere) · --chromium <path> · --wait <ms> (settle window)
 *
 * Importing is side-effect free — the browser run is the CLI's, not the module's. The pure exports
 * (`WRITE` · `isWritePost` · `verdictOf` · `parseArgs` · `GREEN_S0`) are therefore usable from a
 * test or another script; the guard that enforces it is checkable in one line, from any home:
 *
 *   node -e "import('./scripts/gate2-cold-load.mjs').then(m => console.log(Object.keys(m)))"
 *
 * A `PASS` is only printed for a run in which **every** load booted (rendered S0) and none posted a
 * write; the word is never printed for a run that measured nothing. Exit 0 iff PASS.
 *
 * Node built-ins only, by the house pattern for `scripts/` — no driver dependency to install. The
 * Chromium is discovered (flag → env → the shared Playwright/Puppeteer caches → PATH); `--url` skips
 * serving if you already have a COI host up.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Write statements that must not appear on the sync channel. Anchored: `PRAGMA <name>` is a query.
 *
 * `m` is load-bearing, not cosmetic. `migrate` execs each migration's whole DDL as **one** payload, and
 * three of the six open with a `-- §…` comment line (`0001_init`, `0003_reference_actions`,
 * `0004_retire_iteration_lineage_kind` — `core/src/store/migrations.ts`). Without `m`, `^` binds to the
 * payload's first byte, so those three classify as reads: the unguarded shape is a *partial* refactor
 * (transaction wrappers moved async, `exec(m.sql)` left on the sync port) that prints PASS while three
 * DDL statements still post. Line-anchored still keeps out `-- COMMIT …` (a comment) and
 * `PRAGMA foreign_keys` (a query, no `=`).
 */
export const WRITE =
  /^\s*(BEGIN|COMMIT|ROLLBACK|CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE)\b|^\s*PRAGMA\s+\w+\s*=/im;

/** Is this logged sync post a gate-2 write? Input is `{ type, source }`; reads carry a SELECT source. */
export function isWritePost(p) {
  return (p.type === "exec" || p.type === "prepare") && Boolean(p.source) && WRITE.test(p.source);
}

/**
 * The verdict line, and it is not allowed to be vacuous. A load that never rendered S0 never reached
 * the boot's write set, so its silence is *no evidence* — not a pass. `badLoads === 0` alone printed
 * `gate 2 PASS` on **0/n green** loads, which is reachable two ways, both cheap: the served root is
 * wrong (every load 404s) or the boot is slower than the settle window. `PASS` therefore requires
 * every load to have booted *and* no load to have posted a write; anything else is `FAIL` or
 * `NOT MEASURED`, and the word PASS is never printed for an unmeasured run.
 */
export function verdictOf(green, badLoads, n) {
  if (badLoads > 0)
    return { pass: false, line: `gate 2 FAIL on ${badLoads}/${n} loads (sync write posted)` };
  if (green === n) return { pass: true, line: "gate 2 PASS (no sync write on any load)" };
  return {
    pass: false,
    line: `gate 2 NOT MEASURED — ${n - green}/${n} loads never rendered S0, so no write evidence`,
  };
}

/** Flags that take a value. Their value is not a positional — it used to land in the served `dir`. */
const VALUE_FLAGS = new Set(["--url", "--chromium", "--wait"]);

/** `[n] [dir] [port]`, plus `--url <url>` · `--chromium <path>` · `--wait <ms>` · `--selftest`. */
export function parseArgs(argv) {
  const out = { selftest: false, url: null, chromium: null, wait: 9000, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!VALUE_FLAGS.has(a)) {
      if (a === "--selftest") out.selftest = true;
      else out.positional.push(a);
      continue;
    }
    const v = argv[++i];
    if (a === "--url") out.url = v ?? null;
    else if (a === "--chromium") out.chromium = v ?? null;
    else if (Number(v) > 0) out.wait = Number(v);
  }
  let i = 0;
  if (/^\d+$/.test(out.positional[0] ?? "")) i = 1;
  out.n = i ? Number(out.positional[0]) : 25;
  out.dir = out.positional[i] ?? "app/dist";
  out.port = out.positional[i + 1] ?? "8090";
  return out;
}

/** The commit under test, so a row reads *which* state produced its numbers. Best-effort, never fatal. */
function resolveHead() {
  try {
    const r = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** The one line injected before any page script, so the worker channel is wrapped before it is used. */
const INIT = `(() => {
  const wpost = Worker.prototype.postMessage;
  globalThis.__gate2 = [];
  Worker.prototype.postMessage = function (msg, transfer) {
    try {
      if (msg && msg.isSync) {
        const d = msg.data || {};
        globalThis.__gate2.push({ type: msg.type, source: d.source == null ? null : String(d.source) });
      }
    } catch (e) {}
    return wpost.call(this, msg, transfer);
  };
})();`;

/** S0 renders this only once the vault can spread — the pass/fail arm of the same cold load. */
export const GREEN_S0 = "Add a few ideas across unrelated domains to see sparks.";

/**
 * Importing this module must not run the gate. `main()` ends in `process.exit`, and the browser run
 * is a side effect of *being* the CLI — not of being imported. The pure exports (`WRITE`,
 * `isWritePost`, `verdictOf`, `parseArgs`, `GREEN_S0`) are this file's test surface; before the
 * guard a bare `import { parseArgs } from "./gate2-cold-load.mjs"` spawned a browser, ran n loads
 * and then exited the *importer's* process with the gate's status.
 */
function isEntrypoint() {
  const entry = process.argv[1];
  if (!entry) return false; // `node -e` / `node --input-type=module -e`: no script path
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  if (opts.selftest) {
    // The real hazard statements, and the read shapes that must NOT match. Assert, don't eyeball.
    const cases = [
      ["exec", "PRAGMA journal_mode = WAL", true],
      ["exec", "PRAGMA foreign_keys = ON", true],
      ["exec", "BEGIN IMMEDIATE", true],
      ["exec", "COMMIT", true],
      ["exec", "ROLLBACK", true],
      ["exec", "CREATE TABLE idea (id TEXT PRIMARY KEY)", true],
      ["exec", "PRAGMA user_version = 7", true],
      ["exec", "INSERT INTO vault_meta (id, revision) VALUES (1, 0);", true],
      [
        "prepare",
        "INSERT INTO domain_map (tag, cluster_id) VALUES (?, ?) ON CONFLICT(tag) DO UPDATE SET cluster_id = excluded.cluster_id",
        true,
      ],
      ["prepare", "DELETE FROM idea WHERE id = ?", true],
      // Multi-line payloads: the shape `migrate` actually execs. These two fail under the pre-`m` flags
      // (the payload opens with a `--` comment, so a single anchored `^` never reaches the DDL).
      [
        "exec",
        "\n-- §2.1 Idea and its history\nCREATE TABLE idea (\n  id TEXT PRIMARY KEY\n);\n\n-- §2.2 Provenance — explicitly NOT lineage\nCREATE TABLE provenance_edge (\n  derived_idea_id TEXT NOT NULL\n);",
        true,
      ],
      [
        "exec",
        "-- rebuild `child` with the reference dropped\nCREATE TABLE child_new (id TEXT PRIMARY KEY);\nINSERT INTO child_new SELECT * FROM child;\nDROP TABLE child;\nALTER TABLE child_new RENAME TO child;",
        true,
      ],
      // Guards that line-anchoring did not over-widen: a comment keyword, and a multi-line read.
      [
        "exec",
        "-- COMMIT and ROLLBACK belong to writeTransaction; this payload only reads\nSELECT 1",
        false,
      ],
      ["prepare", "SELECT tag,\n       cluster_id\nFROM domain_map\nWHERE tag = ?", false],
      ["prepare", "SELECT id\nFROM idea\n-- DELETE FROM idea is NOT executed here", false],
      ["prepare", "SELECT tag, cluster_id FROM domain_map", false],
      ["prepare", "PRAGMA foreign_keys", false],
      ["prepare", "PRAGMA user_version", false],
      ["prepare", "SELECT * FROM idea WHERE id = ?", false],
      ["run", null, false],
      ["step", null, false],
      ["getAll", null, false],
      ["finalize", null, false],
    ];
    const bad = cases.filter(([type, source, want]) => isWritePost({ type, source }) !== want);
    for (const [type, source, want] of bad)
      console.error(`misclassified: want=${want} ${type} ${source}`);

    // The verdict must not be satisfiable by a run that measured nothing: 0 green with 0 write posts is
    // the vacuous shape, and it is what a wrong `dir` (or a boot slower than the settle window) produces.
    const verdictCases = [
      ["all loads booted, no writes", 5, 0, 5, true],
      ["one load posted a write", 4, 1, 5, false],
      ["no writes, but nothing booted", 0, 0, 5, false],
      ["writes on every load", 0, 5, 5, false],
    ];
    const badVerdicts = verdictCases.filter(
      ([, green, badLoads, n, want]) => verdictOf(green, badLoads, n).pass !== want,
    );
    for (const [label, green, badLoads, n, want] of badVerdicts)
      console.error(`misverdict: want=${want} ${label} (green=${green} writes=${badLoads}/${n})`);

    // A flag's value is never a positional. `[n] [dir] [port]` with a value flag interleaved.
    const parseCases = [
      [
        ["25", "--chromium", "/opt/chrome"],
        { n: 25, dir: "app/dist", port: "8090", chromium: "/opt/chrome" },
      ],
      [
        ["--chromium", "/opt/chrome", "25", "app/dist", "8090"],
        { n: 25, dir: "app/dist", port: "8090", chromium: "/opt/chrome" },
      ],
      [["--wait", "20000", "3"], { n: 3, dir: "app/dist", wait: 20000 }],
      [["--url", "http://127.0.0.1:1/"], { n: 25, url: "http://127.0.0.1:1/" }],
      [[], { n: 25, dir: "app/dist", port: "8090", wait: 9000, chromium: null }],
    ];
    const badParses = parseCases.filter(([a, want]) =>
      Object.entries(want).some(([k, v]) => parseArgs(a)[k] !== v),
    );
    for (const [a, want] of badParses)
      console.error(`misparsed: ${JSON.stringify(a)} want ${JSON.stringify(want)}`);

    const badCount = bad.length + badVerdicts.length + badParses.length;
    const total = cases.length + verdictCases.length + parseCases.length;
    console.log(
      badCount
        ? `selftest FAILED (${total - badCount}/${total})`
        : `selftest OK (${total} cases: ${cases.length} classifier · ${verdictCases.length} verdict · ${parseCases.length} parse)`,
    );
    process.exit(badCount ? 1 : 0);
  }

  // `--url` means the caller already serves the build; else [dir] [port] go to scripts/serve-web.mjs.
  const { n, dir, port, url, wait } = opts;
  const head = resolveHead();

  function findChromium() {
    const candidates = [
      opts.chromium ?? process.env.ASTROLAB_CHROMIUM,
      ...["ms-playwright", "puppeteer"].flatMap((cache) =>
        [
          process.env.PLAYWRIGHT_BROWSERS_PATH,
          process.env.PUPPETEER_CACHE_DIR,
          `/var/cache/buzz/browsers/${cache}`,
          join(process.env.HOME ?? "", `.cache/${cache}`),
        ]
          .filter(Boolean)
          .flatMap((base) => {
            if (!existsSync(base)) return [];
            return readdirSync(base)
              .filter((d) => /^(chromium|chrome)/.test(d))
              .flatMap((d) =>
                [
                  "chrome-linux64/chrome",
                  "chrome-linux/chrome",
                  "chrome-headless-shell-linux64/chrome-headless-shell",
                ].map((s) => join(base, d, s)),
              );
          }),
      ),
      ...["chromium", "chromium-browser", "google-chrome", "chrome"].map((c) => {
        const p = (process.env.PATH ?? "").split(":").find((d) => existsSync(join(d, c)));
        return p ? join(p, c) : null;
      }),
    ].filter(Boolean);
    return candidates.find((c) => existsSync(c)) ?? null;
  }

  /** Minimal CDP client over Node's global WebSocket — enough for one isolated page per load. */
  function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const waiters = new Set();
    let id = 0;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const w of [...waiters]) {
          if (!w.test(msg)) continue;
          waiters.delete(w);
          w.resolve(msg);
        }
      }
    });
    const ready = new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP socket error")), { once: true });
    });
    return {
      ready,
      send: (method, params = {}, sessionId) =>
        new Promise((resolve, reject) => {
          const mid = ++id;
          pending.set(mid, { resolve, reject });
          ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
        }),
      once: (test) => new Promise((resolve) => waiters.add({ test, resolve })),
      close: () => ws.close(),
    };
  }

  const chromium = findChromium();
  if (!chromium) {
    console.error(
      "gate2-cold-load: no Chromium found. Pass --chromium <path>, set ASTROLAB_CHROMIUM, or install one\n" +
        "  (the shared caches under /var/cache/buzz/browsers and ~/.cache/ms-playwright are searched).",
    );
    process.exit(2);
  }

  // Attribute the run to the state that produced it. The pin requires the gated run at the merged head;
  // printing the commit and the served root is what lets the row read that back instead of trusting it.
  console.log(
    `gate2-cold-load · n=${n} · ${url ? `url=${url}` : `dir=${resolve(dir)}`} · wait=${wait}ms\n` +
      `  HEAD=${head ?? "unknown"} (resolved from ${process.cwd()}; nothing in the output is a claim about any other commit)`,
  );

  let server = null;
  if (!url) {
    const serveScript = fileURLToPath(new URL("./serve-web.mjs", import.meta.url));
    if (existsSync(serveScript)) {
      // The lane's own COI host, when this branch has it (#186). Spawned, not copied.
      server = spawn(process.execPath, [serveScript, dir, port], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      await new Promise((resolve, reject) => {
        // It prints its ready line once listening — wait on that, never on a timer.
        server.stdout.on("data", (b) => b.toString().includes("serving") && resolve());
        server.on("exit", (code) => reject(new Error(`serve-web exited (${code})`)));
      });
    } else {
      // shortcut: minimal COI host until scripts/serve-web.mjs is on this branch (#186); then it takes over.
      const root = resolve(dir);
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
      server = createServer((req, res) => {
        const pathname = decodeURIComponent((req.url ?? "/").split("?")[0]);
        const file = join(root, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
        if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
          res.writeHead(404).end("not found");
          return;
        }
        res.writeHead(200, {
          "content-type": TYPES[extname(file)] ?? "application/octet-stream",
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "credentialless",
        });
        res.end(readFileSync(file));
      });
      await new Promise((r) => server.listen(Number(port), "127.0.0.1", r));
    }
  }

  const profile = mkdtempSync(join(tmpdir(), "gate2-cold-load-"));
  const chrome = spawn(
    chromium,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--mute-audio",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const cleanup = () => {
    chrome.kill("SIGKILL");
    if (server) {
      if (server.kill) server.kill("SIGKILL");
      else server.close();
    }
    rmSync(profile, { recursive: true, force: true });
  };
  process.on("exit", cleanup);

  // Chrome prints the DevTools endpoint to stderr once the port is bound.
  const wsUrl = await new Promise((resolve, reject) => {
    chrome.stderr.on("data", (b) => {
      const m = /(ws:\/\/\S+)/.exec(b.toString());
      if (m) resolve(m[1]);
    });
    chrome.on("exit", (code) => reject(new Error(`chromium exited (${code})`)));
  });

  const cdp = connect(wsUrl);
  await cdp.ready;

  let green = 0;
  let badLoads = 0;
  for (let i = 1; i <= n; i++) {
    const { browserContextId } = await cdp.send("Target.createBrowserContext");
    const { targetId } = await cdp.send("Target.createTarget", {
      url: "about:blank",
      browserContextId,
    });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    try {
      await cdp.send("Page.enable", {}, sessionId);
      // Must precede the navigation: the wrap has to exist before the app builds its worker.
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INIT }, sessionId);
      const loaded = cdp.once(
        (m) => m.method === "Page.loadEventFired" && m.sessionId === sessionId,
      );
      await cdp.send("Page.navigate", { url: url ?? `http://127.0.0.1:${port}/` }, sessionId);
      await loaded;
      await new Promise((r) => setTimeout(r, wait)); // the boot is async; let it play out in real time
      const read = async (expression) =>
        (await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result
          .value;
      // `textContent`, not `innerText` — measured on this box's chromium-1248: `innerText` reads
      // `""` for the whole document here, including a node injected by the test itself, while
      // `textContent` carries the rendered S0 string. An `innerText` predicate therefore never fires
      // and every load reads "never booted" — a false NOT MEASURED, not a false pass. See #194.
      const text = await read("document.body.textContent");
      const log = JSON.parse((await read("JSON.stringify(globalThis.__gate2 || [])")) || "[]");
      const writes = log.filter(isWritePost);
      const ok = text.includes(GREEN_S0);
      if (ok) green++;
      if (writes.length) badLoads++;
      // A RED load with no posts is not evidence of absence: the boot never reached the write set.
      const inert = !ok && !writes.length;
      console.log(
        `#${i} ${ok ? "S0" : "RED"}  sync_posts=${log.length}  write_posts=${writes.length}` +
          `${writes.length ? "  <<<< FAIL" : ""}${inert ? "  (not evidence — this load never booted)" : ""}`,
      );
      for (const w of writes.slice(0, 5))
        console.log(`      ${w.type} ${w.source.replace(/\s+/g, " ").slice(0, 80)}`);
    } finally {
      await cdp.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
    }
  }

  const verdict = verdictOf(green, badLoads, n);
  console.log(`\n${green}/${n} cold loads green · ${verdict.line}`);
  cdp.close();
  process.exit(verdict.pass ? 0 : 1);
}

if (isEntrypoint()) await main();
