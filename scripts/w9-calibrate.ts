/**
 * W9 calibration harness — the runnable entry point (issue #34; bar `docs/W9_CALIBRATION.md`).
 *
 * **Run it:**
 *
 * ```sh
 * npm run build -w store          # required — see below
 * npx tsx scripts/w9-calibrate.ts post
 * ```
 *
 * The build is **not** optional. The driver imports `@astrolab/store` bare, whose runtime entry is
 * `dist/index.js`; `tsx` does not apply `vitest.config.ts`'s source alias, so on a fresh checkout the
 * harness dies with `ERR_MODULE_NOT_FOUND` without `npm run build -w store` first (David, 2026-10-14).
 *
 * ## Commands, and the spend rule they implement
 *
 * Every phase's count is posted and ratified **before** it fires (bar §5). `--confirm <n>` makes that
 * mechanical: the harness recomputes the number from the **committed** vault and refuses on a
 * mismatch, so a superseded posting cannot fire. Nothing spends without it.
 *
 * | command | calls | what it does |
 * | :-- | :-- | :-- |
 * | `post` | **0** | seed the fixture, check C1, print P1's posting (`promptChars`) |
 * | `p1 --confirm <promptChars>` | **28** | one extraction call per idea, cached in `idea_mechanism` |
 * | `p2 --confirm <M>` | **M** | adjudicate the union at τ ≥ 0.35, under the hard cap `M` |
 * | `report` | **0** | the union size `M` and the alignment distribution |
 *
 * ## Why this lives in `scripts/` and not in `worker/src/`
 *
 * It reads a file and writes `idea`, and `worker/src/provider/boundary.test.ts` forbids both inside a
 * package's `src/` (`ARCHITECTURE.md` §7; `PRD.md` §3.4 item 3). A calibration fixture is neither of
 * those things, but the guards are path-based, and widening them with a carve-out is where a check
 * starts lying — so the harness lives where the repo keeps its tools, and both guards stand as
 * authored. The guards scan paths containing a `src` segment; `scripts/` is not one (David's ruling,
 * option A, 2026-10-14).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DatabaseSync } from "node:sqlite";

import { readDescriptors, vaultMutation } from "@astrolab/store";

import { bootWorker } from "../worker/src/boot.js";
import {
  coverageViolations,
  createCalibrationRun,
  parseVault,
  p1Posting,
  W9_VAULT_PATH,
  type CalibrationRun,
  type W9Idea,
} from "../worker/src/engine/calibration/w9-run.js";
import {
  createAdapterFromEnv,
  type MechanismDescriptor,
  type Provider,
} from "../worker/src/provider/index.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ARTIFACTS = join(ROOT, "artifacts", "w9");

/** The fixture's db. File-backed, so P1's cache survives into the separately-ratified P2. Gitignored. */
const DB_PATH = process.env.DB_PATH ?? join(ROOT, "data", "w9-calibration.sqlite");

/** The committed fixture — the input of record. Read here, never in `src/` (see the module note). */
function loadVault(): W9Idea[] {
  return parseVault(readFileSync(W9_VAULT_PATH, "utf8"), W9_VAULT_PATH);
}

/** Upsert the vault into `idea`, through `vaultMutation` (§4's trigger). Idempotent: a re-run updates. */
function seedVault(db: DatabaseSync, ideas: readonly W9Idea[]): void {
  vaultMutation(db, () => {
    const upsert = db.prepare(
      `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                         lineage_parent_id, status, visibility, current_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, 'w9', 'w9')
       ON CONFLICT(id) DO UPDATE SET
         hypothesis = excluded.hypothesis, problem = excluded.problem,
         monetization = excluded.monetization, domain_tags = excluded.domain_tags`,
    );
    for (const idea of ideas) {
      upsert.run(
        idea.id,
        idea.hypothesis,
        idea.problem,
        idea.monetization,
        JSON.stringify([idea.cluster]),
      );
    }
  });
}

/** How many of the vault's ideas already carry a cached descriptor. `report`/`p2` refuse at 0-cost otherwise. */
function cachedCount(db: DatabaseSync, ideas: readonly W9Idea[]): number {
  const rows = readDescriptors(
    db,
    ideas.map((idea) => idea.id),
  );
  return rows.length;
}

/** A provider that must never be called — so "this command spends 0" is checked, not asserted in prose. */
const noProvider: Provider = {
  extract(): Promise<MechanismDescriptor> {
    return Promise.reject(new Error("W9: this command must make no provider call"));
  },
  adjudicate(): Promise<null> {
    return Promise.reject(new Error("W9: this command must make no provider call"));
  },
  normalizeTag(): Promise<string> {
    return Promise.reject(new Error("W9: this command must make no provider call"));
  },
};

function writeArtifact(name: string, value: unknown): string {
  mkdirSync(ARTIFACTS, { recursive: true });
  const path = join(ARTIFACTS, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

/** `--confirm <n>` — the ratified number the command checks itself against before spending. */
function readConfirm(argv: readonly string[]): number | undefined {
  const index = argv.indexOf("--confirm");
  if (index === -1) return undefined;
  const raw = argv[index + 1];
  const value = Number(raw);
  return raw === undefined || !Number.isFinite(value) ? undefined : value;
}

/** Firing takes a second, deliberate key: `W9_LIVE=1`. A matching `--confirm` alone is not "post then fire". */
function requireLive(what: string): void {
  if (process.env.W9_LIVE !== "1") {
    throw new Error(
      `${what}: refusing to fire — set W9_LIVE=1 once the posting is ratified. (--confirm alone is not ` +
        "the ratification; it only proves the number matches the committed vault.)",
    );
  }
}

function requireConfirm(what: string, confirm: number | undefined, actual: number): void {
  if (confirm === undefined) {
    throw new Error(
      `${what}: refusing to spend without --confirm <n>. Ratified number for this vault: ${actual}`,
    );
  }
  if (confirm !== actual) {
    throw new Error(
      `${what}: --confirm ${confirm} does not match the committed vault's number ${actual} — ` +
        "a superseded posting does not fire (bar §5). Re-post and re-ratify.",
    );
  }
}

/** The run, wired with either the real adapter or the throwing stub, so each command's spend is explicit. */
function runFor(db: DatabaseSync, provider: Provider): CalibrationRun {
  return createCalibrationRun(db, {
    extractor: provider,
    adjudicator: provider,
    // `AI_MODEL` unset ⇒ the pinned `deepseek/deepseek-v4-flash`; the same value the adapter uses.
    model: process.env.AI_MODEL?.trim() || "deepseek/deepseek-v4-flash",
  });
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  const ideas = loadVault();
  const db = bootWorker(DB_PATH);
  seedVault(db, ideas);

  const coverage = coverageViolations(db, ideas);
  if (coverage.length > 0) throw new Error(`C1 fails: ${coverage.join("; ")}`);

  if (command === "post") {
    const posting = p1Posting(ideas);
    const artifact = {
      vault: { ideas: ideas.length, clusters: new Set(ideas.map((i) => i.cluster)).size },
      model: process.env.AI_MODEL?.trim() || "deepseek/deepseek-v4-flash",
      zdr: true,
      posting,
      cached: cachedCount(db, ideas),
    };
    writeArtifact("p1-posting.json", artifact);
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
    return;
  }

  if (command === "report") {
    const cached = cachedCount(db, ideas);
    if (cached < ideas.length) {
      throw new Error(
        `report: ${cached}/${ideas.length} descriptors cached — refusing, because the matrix would ` +
          "extract on a cold cache (28 calls). Run `p1` first.",
      );
    }
    const run = runFor(db, noProvider);
    const pairs = await run.union();
    const artifact = {
      union: pairs.length,
      pairs,
      extractCalls: run.extractCalls,
      adjudicateCalls: run.adjudicateCalls,
    };
    writeArtifact("union.json", artifact);
    process.stdout.write(
      `${JSON.stringify({ union: pairs.length, extractCalls: run.extractCalls }, null, 2)}\n`,
    );
    return;
  }

  if (command === "p1") {
    const posting = p1Posting(ideas);
    requireConfirm("p1", readConfirm(argv), posting.promptChars);
    requireLive("p1");
    const run = runFor(db, createAdapterFromEnv());
    await run.extract();
    const artifact = { posting, extractCalls: run.extractCalls };
    writeArtifact("p1-actuals.json", artifact);
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
    return;
  }

  if (command === "p2") {
    const cached = cachedCount(db, ideas);
    if (cached < ideas.length) {
      throw new Error(`p2: ${cached}/${ideas.length} descriptors cached — run \`p1\` first.`);
    }
    const run = runFor(db, createAdapterFromEnv());
    const union = await run.union(); // deterministic from the cached descriptors; no calls
    requireConfirm("p2", readConfirm(argv), union.length);
    requireLive("p2");
    if (run.adjudicateCalls > union.length) {
      throw new Error(`p2: cap exceeded (${run.adjudicateCalls} > ${union.length})`);
    }
    const adjudication = await run.adjudicate();
    const artifact = {
      union: union.length,
      adjudicateCalls: run.adjudicateCalls,
      confirmed: adjudication.confirmed.map((spark) => spark.key),
      rejected: adjudication.rejected.map((pair) => pair.key),
    };
    writeArtifact("p2-actuals.json", artifact);
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
    return;
  }

  throw new Error(
    `unknown command ${JSON.stringify(command ?? "")} — expected post | p1 | p2 | report`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
