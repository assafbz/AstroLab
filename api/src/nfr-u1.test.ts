import { readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { MIGRATIONS, migrate, openStore, seedDomainTaxonomy } from "@astrolab/store";
import { afterEach, beforeEach, expect, test } from "vitest";

import { createApp } from "./server.js";

/**
 * EV7 (#49) — **NFR-U1, the onboarding completion test** (`PRD.md` §4 NFR-U1, §3.4; `ARCHITECTURE.md` §7;
 * `FLOW.md` §4.2 T02/T04, §5.2).
 *
 * The requirement is a property of a *completed flow*, so it is proved end to end against the **real**
 * server (`createApp`) on a migrated vault with the **shipped** taxonomy — never against a stubbed
 * `VaultSummary`, which is where the existing client tests stop. No provider is reachable from any path
 * exercised here: the vault routes answer while the engine is down (NFR-A1), so this is **0 provider
 * calls**.
 *
 * The Done clause is three claims. Each is asserted on the one authority that owns it, and each has a
 * second, **discriminating** fixture that makes it fail — a claim a fixture cannot falsify is not
 * evidence:
 *
 * | # | claim | read from | the fixture that fails it |
 * | :-- | :-- | :-- | :-- |
 * | 1 | ≥ 2 distinct *resolved* domains at exit | `GET /v1/vault/summary` | a provisional-only vault (typed `Other` lane) |
 * | 2 | E0 is not Cold on the first run | `GET /v1/sparks/state` | one idea spanning two clusters — `eligible` is true, the **idea arm** still says E0 |
 * | 3 | the vault holds only user-authored ideas | the `idea` rows **and** the insert sites | a module outside `capture.ts` / `fork.ts` inserting an idea |
 *
 * Claim 2's fixture is the point of the whole file: `VaultSummary` carries no idea count
 * (`docs/API.md` §6), so a test that asserts `!spreadGate(summary)` would miss the second arm of E0
 * (`FLOW.md` §4.1's *"or < 2 ideas"*) entirely. The state read is the only surface that owns both arms
 * (`api/src/engine-state.ts:104`), so it is the only thing that can carry the claim.
 *
 * **Out of scope:** T03's *Skip* exit (`FLOW.md`:130) leaves onboarding with an E0 vault **on purpose** —
 * it is a recorded deviation, not a completion. Claim 2 is about the T04 completion path only.
 */

const TOKEN = "test-token-ev7-4c19";
const JSON_UTF8 = "application/json; charset=utf-8";

/** Three shipped clusters, one per S0 prompt. The picker writes the cluster **key** (`store/seed/README.md` rule 2). */
const PICKED = ["devtools", "health", "fintech"] as const;
/** A tag no cluster maps — S0's `Other → free text` lane, provisional by construction (`ARCHITECTURE.md` §3.2). */
const PROVISIONAL = "bespoke-domain-of-mine";

let server: Server;
let db: DatabaseSync;
let base: string;

beforeEach(async () => {
  db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  seedDomainTaxonomy(db); // what `api/src/index.ts` does at boot, before the first gate reads it
  server = createApp({ db });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  base = `http://localhost:${address.port}`;
  process.env.API_TOKEN = TOKEN;
});

afterEach(async () => {
  delete process.env.API_TOKEN;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Call {
  status: number;
  contentType: string | null;
  body: unknown;
}

async function call(method: string, path: string, options: { json?: unknown } = {}): Promise<Call> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  let body: string | undefined;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const res = await fetch(`${base}${path}`, { method, headers, body });
  const text = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    body: text === "" ? null : JSON.parse(text),
  };
}

/** One S0 capture — the four mandatory fields and one picked domain tag (`FLOW.md` §4.2 T02). */
async function capture(domainTags: string[], n: number): Promise<void> {
  const result = await call("POST", "/v1/ideas", {
    json: {
      hypothesis: `hypothesis ${n}`,
      problem: `problem ${n}`,
      monetization: `monetization ${n}`,
      domain_tags: domainTags,
    },
  });
  expect(result.status).toBe(201);
}

interface Summary {
  resolved_domains: number;
  provisional_domains: number;
  target: number;
  floor: number;
  eligible: boolean;
}

interface State {
  state: string;
  unreviewed: number;
  run: unknown;
}

async function summary(): Promise<Summary> {
  const result = await call("GET", "/v1/vault/summary");
  expect(result.status).toBe(200);
  expect(result.contentType).toBe(JSON_UTF8);
  return result.body as Summary;
}

async function engineState(): Promise<State> {
  const result = await call("GET", "/v1/sparks/state");
  expect(result.status).toBe(200);
  expect(result.contentType).toBe(JSON_UTF8);
  return result.body as State;
}

/** The onboarding loop: one picked-domain idea per prompt, then T04's exit side effect. */
async function completeOnboarding(): Promise<void> {
  for (const [n, tag] of PICKED.entries()) await capture([tag], n);
  const run = await call("POST", "/v1/sparks/run");
  expect(run.status).toBe(202); // T04's side effect — the exit kicks the run
}

test("a completed onboarding exits at ≥ 2 resolved domains and S1 does not land E0 (claims 1 & 2)", async () => {
  await completeOnboarding();

  const after = await summary();
  // Claim 1 — the **resolved** count, and the same boolean the S0 gate opens on (`FLOW.md` §7).
  expect(after.resolved_domains).toBe(PICKED.length);
  expect(after.resolved_domains).toBeGreaterThanOrEqual(after.floor);
  expect(after.eligible).toBe(true);

  // Claim 2 — read from the state endpoint, which owns E0's two arms. The requirement is only *not
  // Cold*: T04 kicks the run, so a completion-path read here is E1, but one that enqueued nothing
  // would be E3. Pin the not-E0 form — an `=== E1`/`=== E2` assertion would encode run timing
  // (`FLOW.md` §4.1: a 0-offer, 0-run vault at/above the floor is E3, not E0).
  const state = await engineState();
  expect(state.state).not.toBe("E0");
});

test("claim 1 discriminates: a provisional-only vault never clears the floor (E0, no exit)", async () => {
  for (const n of PICKED.keys()) await capture([PROVISIONAL], n);

  const after = await summary();
  // The typed `Other` lane is provisional: three ideas, still zero resolved clusters.
  expect(after.provisional_domains).toBe(1);
  expect(after.resolved_domains).toBe(0);
  expect(after.eligible).toBe(false);

  // …so the exit is absent and S1 lands cold — the state the completion test must rule out.
  expect((await engineState()).state).toBe("E0");
});

test("claim 2 discriminates: E0 is the state read's, not `eligible`'s (one idea, two clusters)", async () => {
  // One idea carrying two mapped clusters: the domain arm is satisfied while the idea arm is not.
  await capture(["devtools", "health"], 0);

  const after = await summary();
  expect(after.resolved_domains).toBe(2);
  expect(after.eligible).toBe(true); // the arm a summary-only test would stop at

  // `VaultSummary` cannot see the idea count, so only the state read can carry the second arm.
  const ideas = db.prepare("SELECT COUNT(*) AS n FROM idea").get() as { n: number };
  expect(ideas.n).toBe(1);
  expect((await engineState()).state).toBe("E0");
});

test("claim 3 discriminates: the vault holds only the ideas the user captured (ARCH §7)", async () => {
  await completeOnboarding();

  const rows = db.prepare("SELECT lineage_kind, lineage_parent_id FROM idea").all() as Array<{
    lineage_kind: string;
    lineage_parent_id: string | null;
  }>;
  // Not one idea more than the user captured, and none of them a derivative.
  expect(rows).toHaveLength(PICKED.length);
  for (const row of rows) {
    expect(row.lineage_kind).toBe("ROOT");
    expect(row.lineage_parent_id).toBeNull();
  }
});

/**
 * Claim 3's structural half — the count above is a snapshot; a synthesis path that happens not to fire
 * would pass it. `ARCHITECTURE.md` §7: *"neither the engine nor the API generates ideas on the user's
 * behalf."* The only ways an idea may enter the vault are the two **user-initiated** routes, so the set
 * of production modules that insert one is asserted **exactly** — an addition and a removal both fail.
 * The two write statements are `api/src/capture.ts:215` (`insertIdea`, both §4.2 capture and §4.6
 * inspire) and `api/src/fork.ts:80`.
 *
 * Scope is shipped runtime — `api/src` · `worker/src` · `store/src`, over the **same source-extension
 * union** `worker/src/provider/boundary.test.ts` already scans (`.ts` · `.tsx` · `.js` · `.jsx` ·
 * `.mjs` · `.cjs`, tests excluded). `scripts/` is out (it holds calibration fixtures), and
 * `store/src/migrations.ts`'s table-rebuild targets `idea_new`, which the matcher's boundary excludes on
 * the table name rather than by skipping the file.
 *
 * Non-vacuity is asserted too: the walk must reach both expected files, and the matcher must separate
 * `idea` from `idea_version` (written beside every capture) and `idea_new` (the migration rebuild).
 * #123 closed two holes this canary had: SQLite's other spellings of the same table (`INSERT OR
 * REPLACE`/`OR IGNORE`, a quoted `"idea"`, any casing) and the `.tsx` extension a `.ts`-only walk
 * cannot see — the same omission `boundary.test.ts`'s walk was fixed for.
 */
test("only the capture and fork routes insert an idea — the engine never does (ARCH §7)", () => {
  // `INSERT OR REPLACE`/`OR IGNORE`, a quoted identifier and any casing all write the **same** table.
  // The trailing lookahead is a statement about the *table name*'s last character, so it separates
  // `idea` from `idea_version` / `idea_new` even when a closing quote intervenes.
  const INSERT_IDEA = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+"?idea"?(?![\w])/i;

  // The matcher's own boundary, asserted both ways: `idea_version` (written beside every capture) and
  // `idea_new` (the `store/src/migrations.ts` table-rebuild) are **different tables** — a bare
  // `INSERT INTO idea` substring would sweep in all three and the set would never be two.
  expect(INSERT_IDEA.test("INSERT INTO idea (id) VALUES (1)")).toBe(true);
  expect(INSERT_IDEA.test("INSERT INTO idea_version (idea_id) VALUES (1)")).toBe(false);
  expect(INSERT_IDEA.test("INSERT INTO idea_new (id) VALUES (1)")).toBe(false);
  expect(INSERT_IDEA.test('INSERT INTO "idea_version" (idea_id) VALUES (1)')).toBe(false);

  // The shapes #123 reproduced as slipping past a `INSERT\s+INTO\s+idea` canary.
  expect(INSERT_IDEA.test("INSERT OR REPLACE INTO idea (id) VALUES (1)")).toBe(true);
  expect(INSERT_IDEA.test("INSERT OR IGNORE INTO idea (id) VALUES (1)")).toBe(true);
  expect(INSERT_IDEA.test('INSERT INTO "idea" (id) VALUES (1)')).toBe(true);
  expect(INSERT_IDEA.test("insert into idea (id) values (1)")).toBe(true);

  // The walk's extension union, pinned as a unit: no `.tsx` ships under a scanned package today, so
  // the real tree cannot exercise that half — this predicate is what keeps it from being a claim
  // about nothing.
  expect(isShippedSource("zz.ts")).toBe(true);
  expect(isShippedSource("zz.tsx")).toBe(true);
  expect(isShippedSource("zz.test.ts")).toBe(false);
  expect(isShippedSource("zz.test.tsx")).toBe(false);

  const root = fileURLToPath(new URL("../../", import.meta.url));
  const packages = ["api/src", "worker/src", "store/src"];
  const visited: string[] = [];
  const inserting: string[] = [];
  for (const pkg of packages) {
    for (const file of sourcesUnder(join(root, pkg))) {
      const rel = `${pkg}/${file}`;
      visited.push(rel);
      if (INSERT_IDEA.test(readFileSync(join(root, pkg, file), "utf8"))) inserting.push(rel);
    }
  }

  // Non-vacuity: the walk reached the package's real files, both expected ones among them.
  expect(visited.length).toBeGreaterThan(20);
  expect(inserting).toEqual(["api/src/capture.ts", "api/src/fork.ts"]);
});

/** The shipped-source extension union, mirroring `worker/src/provider/boundary.test.ts`. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/** Whether `name` is a shipped source file — tests are out, since they insert fixtures directly. */
function isShippedSource(name: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)) && !TEST_FILE.test(name);
}

/** Every shipped source file under `dir`, recursively, in stable order. */
function sourcesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const nested of sourcesUnder(join(dir, entry.name)))
        found.push(join(entry.name, nested));
    } else if (isShippedSource(entry.name)) {
      found.push(entry.name);
    }
  }
  return found.sort();
}
