import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { MIGRATIONS, migrate, openStore, seedDomainTaxonomy } from "@astrolab/store";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createApp } from "./server.js";

/**
 * K1 (#35) — `GET /v1/sparks/events`, the run-progress stream (`docs/API.md` §4.11).
 *
 * **File-backed, with three handles** — the slice's whole point. The stream's sampler reads
 * `PRAGMA data_version` on a **second** connection (`watchDb`); the "worker" writes on a **third**
 * (`workerDb`); the API's own writes go through `db` (its HTTP routes). `:memory:` would make each
 * handle a *different* database and every detection assertion unfalsifiable, so these run on a temp
 * file — exactly as the plan and David's ruling require.
 */

const TOKEN = "test-token-sse-91c2";
const INTERVAL_MS = 20;
const HEARTBEAT_MS = 40;

let dir: string;
let db: DatabaseSync;
let watchDb: DatabaseSync;
let workerDb: DatabaseSync;
let server: Server;
let base: string;
const controllers: AbortController[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "astrolab-sse-"));
  const file = join(dir, "vault.sqlite");
  db = openStore(file);
  migrate(db, MIGRATIONS);
  // The shipped taxonomy, so the seeded pairs resolve to two clusters and E0's floor is out of the
  // way — without it every vault reads E0 and no state transition is observable.
  seedDomainTaxonomy(db);
  watchDb = openStore(file);
  workerDb = openStore(file);
  server = createApp({
    db,
    watchDb,
    sparkEvents: { intervalMs: INTERVAL_MS, heartbeatMs: HEARTBEAT_MS },
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  base = `http://127.0.0.1:${address.port}`;
  process.env.API_TOKEN = TOKEN;
});

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  delete process.env.API_TOKEN;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  watchDb.close();
  workerDb.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Frame {
  event: string;
  data: unknown;
}

interface Stream {
  frames: Frame[];
  raw: string;
  close: () => void;
}

/** `event:` + `data:` blocks, blank-line terminated; comment frames (`:`) are dropped. */
function parseFrame(raw: string): Frame | null {
  let event: string | null = null;
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) return null; // heartbeat comment
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) data += line.slice("data:".length).trim();
  }
  return event === null ? null : { event, data: JSON.parse(data) };
}

async function openStream(): Promise<Stream> {
  const controller = new AbortController();
  controllers.push(controller);
  const res = await fetch(`${base}/v1/sparks/events`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");

  const stream: Stream = { frames: [], raw: "", close: () => controller.abort() };
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        const text = decoder.decode(value, { stream: true });
        stream.raw += text;
        buffer += text;
        let end = buffer.indexOf("\n\n");
        while (end !== -1) {
          const parsed = parseFrame(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          if (parsed !== null) stream.frames.push(parsed);
          end = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // the client aborted — expected at teardown
    }
  })();
  return stream;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the stream");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Let several cadences pass with no write — the window in which an accidental timer would fire. */
function settle(cadences = 6): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, INTERVAL_MS * cadences + 80));
}

function seedSpread(target: DatabaseSync): void {
  for (const [id, tag] of [
    ["a", "fintech"],
    ["b", "health"],
  ] as const) {
    target
      .prepare(
        `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                           lineage_parent_id, status, visibility, current_version, created_at, updated_at)
         VALUES (?, 'h', 'p', 'm', ?, 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, 't', 't')`,
      )
      .run(id, JSON.stringify([tag]));
  }
}

/** A `spark` row on the given handle — `OFFERED` unless the caller asks for a resolution. */
function insertSpark(
  target: DatabaseSync,
  id: string,
  a: string,
  b: string,
  status = "OFFERED",
): void {
  const [x, y] = [a, b].sort();
  target
    .prepare(
      `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, status, created_at)
       VALUES (?, ?, ?, ?, 'a direction', 'a claim', ?, '2026-01-01T00:00:00Z')`,
    )
    .run(id, a, b, `${x}|${y}`, status);
}

const stateOf = (frame: Frame): string => (frame.data as { state: string }).state;

describe("GET /v1/sparks/events — the run-progress stream (§4.11)", () => {
  test("connect: `text/event-stream` and one baseline `state` frame", async () => {
    const stream = await openStream();
    await waitFor(() => stream.frames.length >= 1);
    expect(stream.frames[0]).toEqual({
      event: "state",
      data: { state: "E0", unreviewed: 0, run: null },
    });
  });

  test("idle cadences are silent; a new live offer arrives once, on the write (§4.11)", async () => {
    seedSpread(db); // E0's floor out of the way, so the deck is observable
    const stream = await openStream();
    await waitFor(() => stream.frames.length >= 1);
    const baseline = stream.frames.length;

    // The timer mutation — "emit the whole deck each tick" — goes red here.
    await settle();
    expect(stream.frames.length).toBe(baseline);

    // The worker's write, on its own connection.
    insertSpark(workerDb, "sp-1", "a", "b");
    await waitFor(() => stream.frames.some((frame) => frame.event === "offer"));
    const offers = stream.frames.filter((frame) => frame.event === "offer");
    expect(offers).toEqual([
      {
        event: "offer",
        data: {
          id: "sp-1",
          direction: "a direction",
          claim: "a claim",
          domain_tags: ["fintech", "health"],
          created_at: "2026-01-01T00:00:00Z",
        },
      },
    ]);

    // No repeat: an offer surfaces once, not on every subsequent tick.
    await settle();
    expect(stream.frames.filter((frame) => frame.event === "offer")).toHaveLength(1);
  });

  test("the API's own commit moves the stream — `POST /v1/sparks/run` ⇒ one `state: E1` (§4.11, §4.16)", async () => {
    seedSpread(db);
    const stream = await openStream();
    await waitFor(() => stream.frames.length >= 1);

    const res = await fetch(`${base}/v1/sparks/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(202);
    await res.text();

    await waitFor(() => stream.frames.some((frame) => stateOf(frame) === "E1"));
    expect(stream.frames.filter((frame) => stateOf(frame) === "E1")).toHaveLength(1);
    // Enqueueing a run is a state change, never an offer.
    expect(stream.frames.filter((frame) => frame.event === "offer")).toHaveLength(0);
  });

  test("a resolved spark is never an `offer`, and an unmoved state is not re-sent (§4.11)", async () => {
    seedSpread(db);
    const stream = await openStream();
    await waitFor(() => stream.frames.length >= 1);
    const baseline = stream.frames.length;

    insertSpark(workerDb, "sp-1", "a", "b", "RESOLVED-DISMISSED");
    await settle();
    // The commit moved `data_version`, the sampler ran — and emitted nothing: a resolved spark is
    // not a deck entry, and `unreviewed` (hence the state) did not move.
    expect(stream.frames.length).toBe(baseline);
  });

  test("resolving a live offer drops it from the deck without a second `offer` (§4.11)", async () => {
    seedSpread(db);
    const stream = await openStream();
    await waitFor(() => stream.frames.length >= 1);

    insertSpark(workerDb, "sp-1", "a", "b");
    await waitFor(() => stream.frames.some((frame) => frame.event === "offer"));

    workerDb.prepare("UPDATE spark SET status = 'RESOLVED-DISMISSED' WHERE id = 'sp-1'").run();
    await waitFor(() => stream.frames.some((frame) => stateOf(frame) === "E3"));
    // The disappearance is a state change (E2 → E3), never a re-offer.
    expect(stream.frames.filter((frame) => frame.event === "offer")).toHaveLength(1);
  });

  test("an idle stream carries a heartbeat comment so an intermediary does not reap it (§4.11)", async () => {
    const stream = await openStream();
    await waitFor(() => stream.raw.includes(": keepalive"));
  });

  test("a disconnect stops the sampler — per-subscriber, live-only (§4.11)", async () => {
    const clear = vi.spyOn(globalThis, "clearInterval");
    const stream = await openStream();
    await waitFor(() => stream.frames.length >= 1);
    stream.close();
    // Both the watcher and the heartbeat are cleared on close.
    await waitFor(() => clear.mock.calls.length >= 2);
    clear.mockRestore();
  });
});

/**
 * The stream **reads through** the two owned reads — the deck (`liveOffers`, §4.9) and the state
 * (`engineState`, §4.10) — and never around them (K1's fence). The mistake has two shapes, so there
 * are two checks: re-deriving the ladder arrives as an **import**, and hand-rolling it arrives as
 * **SQL**. Its one prepared statement must be the change signal, `PRAGMA data_version`.
 */
describe("the stream reads the deck and the state through their owners (K1's fence)", () => {
  const MODULE_PATH = fileURLToPath(new URL("./spark-events.ts", import.meta.url));
  const MODULE_TEXT = readFileSync(MODULE_PATH, "utf8");

  /** Every module specifier in a file — the extractor the sibling guards use. */
  function specifiers(text: string): string[] {
    return [...text.matchAll(/(?:from\s+|import\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm)].map(
      (match) => match[1] ?? "",
    );
  }

  test("the extractor sees every import form — a side-effect import has no `from`", () => {
    const text = [
      'import "@astrolab/worker";',
      'import { a } from "./a.js";',
      'import type { B } from "@astrolab/worker";',
      'const c = await import("./c.js");',
    ].join("\n");

    expect(specifiers(text)).toEqual(["@astrolab/worker", "./a.js", "@astrolab/worker", "./c.js"]);
  });

  test("the scan is real — it read this module and found its imports", () => {
    expect(MODULE_PATH.endsWith("/api/src/spark-events.ts")).toBe(true);
    expect(MODULE_TEXT.length).toBeGreaterThan(0);
    expect(specifiers(MODULE_TEXT)).toContain("@astrolab/store");
  });

  test("its only specifiers are the HTTP/SQLite types, the store's deck read, and the two owned reads", () => {
    expect(specifiers(MODULE_TEXT)).toEqual([
      "node:http",
      "node:sqlite",
      "@astrolab/store",
      "./engine-state.js",
      "./sparks.js",
    ]);
  });

  test("its one prepared statement is the change signal — no deck or ladder SQL", () => {
    // A hand-rolled deck or ladder could dodge the import route above by writing the SQL here.
    expect(MODULE_TEXT.match(/\.prepare\(/g)).toHaveLength(1);
    expect(MODULE_TEXT).toMatch(/PRAGMA\s+data_version/);
    expect(MODULE_TEXT).not.toMatch(/FROM\s+(spark|idea|spark_run|vault_meta)\b/i);
    // Non-vacuity, both ways: the shapes exist where they belong, so neither negative assertion is
    // scanning nothing — the store read prepares against `spark`, the state read owns `spark_run`.
    const storeRead = readFileSync(new URL("../../store/src/sparks.ts", import.meta.url), "utf8");
    expect(storeRead).toMatch(/FROM\s+spark\b/i);
    const stateRead = readFileSync(new URL("./engine-state.ts", import.meta.url), "utf8");
    expect(stateRead).toMatch(/FROM\s+spark_run\b/i);
  });
});
