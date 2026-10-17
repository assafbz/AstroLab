import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import {
  MIGRATIONS,
  migrate,
  openStore,
  seedDomainTaxonomy,
  upsertDescriptor,
  vaultMutation,
} from "@astrolab/store";
import { describe, expect, test } from "vitest";

import type { IdeaText, MechanismDescriptor } from "../../provider/index.js";
import { hashIdeaText, EXTRACTOR_VERSION } from "../mechanism.js";
import { createCalibrationRun, parseVault, W9_VAULT_PATH, type W9Idea } from "./w9-run.js";

/**
 * **W9 C5 — the regression fixture** (issue #34; bar `docs/W9_CALIBRATION.md` §3 C5, §4 step 7).
 *
 * This is a **snapshot, not a validation.** The deterministic half — `pair_key`, `domain_distance`,
 * `alignment` — is *asserted*: the shipped gate, over the committed vault and the committed descriptors,
 * must return exactly the pairs the fixture names. The provider half (`confirmed` / `rejected` and the 21
 * frozen drafts) is *recorded*, `snapshot`-labelled, and is **never** asserted against a live reply —
 * the adjudicator is not reproducible (`engine/adjudicate.ts` D2), and the label set it produced *is* the
 * metric's own candidate set (bar §6 selection bias), so nothing here is precision evidence or makes C3
 * hold.
 *
 * A future signal change (the **F** and **E** branches of issue #106) is **expected to fail this suite
 * loudly** — that is the fixture doing its job, not a flake.
 *
 * **0 provider calls, and that is enforced, not promised.** The descriptor cache is seeded with the
 * artifact of record's own descriptors under the *exact* producer it was written with, so every
 * `descriptorFor` is a hit; the extractor and the adjudicator handed to the driver both **throw**
 * (`w9-run.ts`'s D2 pattern). A hash mismatch — vault text, `EXTRACTOR_VERSION` or model moved since the
 * run — turns the fixture red instead of quietly re-extracting 28 ideas.
 *
 * Provenance: `w9-c5-fixture.json` is generated from `p2-actuals.json`
 * (`sha256 b5e37875…90e03c3`, the relay messages `ee452598…` ‖ `e1b2ca87…` on #34's thread) by
 * `scripts/w9-c5-fixture.ts`; a reviewer holding those bytes can re-run it and expect no diff.
 */

const FIXTURE_URL = new URL("./w9-c5-fixture.json", import.meta.url);
/** The artifact of record this fixture was derived from — pinned so a silent re-generation is visible. */
const ARTIFACT_SHA256 = "b5e378758aa5d0106a426089db2cfe8f5c9e0c35ba7b78f0e00b27c4390e03c3";
/** τ\* (`ARCHITECTURE.md` §3.4) — the floor the fixture was generated at, passed explicitly, never read. */
const FLOOR = 0.02;

interface FixturePair {
  key: string;
  distance: number | null;
  alignment: number;
  gated: boolean;
  verb: number;
  object_class: number;
  constraint: number;
  transferable_structure: number;
}

interface Fixture {
  provenance: {
    issue: string;
    artifact: { name: string; bytes: number; sha256: string; relay: { event: string }[] };
    producer: { extractorVersion: string; model: string };
    floor: number;
  };
  descriptors: { ideaId: string; descriptor: MechanismDescriptor }[];
  pairs: FixturePair[];
  confirmed: string[];
  rejected: string[];
  snapshot: { key: string; draft: Record<string, string> }[];
}

const fixture = JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as Fixture;
const MODEL = fixture.provenance.producer.model;

function newDb(): DatabaseSync {
  const db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  seedDomainTaxonomy(db);
  return db;
}

const loadVault = (): W9Idea[] => parseVault(readFileSync(W9_VAULT_PATH, "utf8"), W9_VAULT_PATH);

const textOf = (idea: W9Idea): IdeaText => ({
  hypothesis: idea.hypothesis,
  problem: idea.problem,
  monetization: idea.monetization,
});

/** Seed the vault into `idea` through `vaultMutation` (§4's trigger), exactly as the run's harness did. */
function seedVault(db: DatabaseSync, ideas: readonly W9Idea[]): void {
  vaultMutation(db, () => {
    const insert = db.prepare(
      `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                         lineage_parent_id, status, visibility, current_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, 'w9', 'w9')`,
    );
    for (const idea of ideas) {
      insert.run(
        idea.id,
        idea.hypothesis,
        idea.problem,
        idea.monetization,
        JSON.stringify([idea.cluster]),
      );
    }
  });
}

/**
 * Seed `idea_mechanism` from the fixture's descriptors, keyed by the **recomputed** `source_hash`. Uses
 * the live `EXTRACTOR_VERSION` and the fixture's pinned model, so the seed is what makes the run 0 calls:
 * if the extraction contract or the vault text has moved, the hashes no longer line up and the throwing
 * extractor fires rather than the test passing on a stale cache.
 */
function seedDescriptors(db: DatabaseSync, ideas: readonly W9Idea[], model = MODEL): void {
  const byId = new Map(ideas.map((idea) => [idea.id, idea]));
  for (const row of fixture.descriptors) {
    const idea = byId.get(row.ideaId);
    if (idea === undefined) throw new Error(`fixture descriptor for unknown idea ${row.ideaId}`);
    upsertDescriptor(db, {
      ideaId: row.ideaId,
      descriptor: JSON.stringify(row.descriptor),
      sourceHash: hashIdeaText(textOf(idea), { version: EXTRACTOR_VERSION, model }),
    });
  }
}

const providerCall = (what: string) => ({
  async extract(): Promise<never> {
    throw new Error(`PROVIDER CALL: ${what} — the fixture must make none`);
  },
  async adjudicate(): Promise<never> {
    throw new Error(`PROVIDER CALL: ${what} — the fixture must make none`);
  },
});

/** The run over a warm cache: seeder, both throwers, and the fixture's own floor passed explicitly. */
function runFixture(db: DatabaseSync, unionTau = FLOOR) {
  seedDescriptors(db, loadVault());
  const calls = providerCall("extractor/adjudicator fired");
  return createCalibrationRun(db, {
    extractor: { extract: calls.extract },
    adjudicator: { adjudicate: calls.adjudicate },
    model: MODEL,
    unionTau,
  });
}

/** The metric, re-written from its spec — a *frozen copy*, so a change to `alignment.ts` cannot move it. */
const FIELDS = ["verb", "object_class", "constraint", "transferable_structure"] as const;
const tokenise = (text: string): Set<string> => {
  const set = new Set<string>();
  for (const token of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (token !== "") set.add(token);
  return set;
};
const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
};

describe("the C5 fixture is the artifact of record's own data", () => {
  test("it is pinned to the artifact and to the producer it was extracted under", () => {
    expect(fixture.provenance.issue).toBe("#34");
    expect(fixture.provenance.artifact.name).toBe("p2-actuals.json");
    expect(fixture.provenance.artifact.bytes).toBe(71_691);
    expect(fixture.provenance.artifact.sha256).toBe(ARTIFACT_SHA256);
    expect(fixture.provenance.artifact.relay.map((part) => part.event)).toEqual([
      "ee4525983e1598edc858fb5039acfd3de9190cd7a771f59f389af5c37a7d0b7b",
      "e1b2ca87ecc06caee95c5106fdc4de6760b7a9e9f87644171c823ee859877793",
    ]);
    expect(fixture.provenance.floor).toBe(FLOOR);
    expect(fixture.provenance.producer.model).toBe("deepseek/deepseek-v4-flash");
    // The extraction contract has not moved. If it does (the **F** branch of #106 re-cuts the descriptor
    // fields), this fails — and so does every cache hit below, which is the point.
    expect(fixture.provenance.producer.extractorVersion).toBe(EXTRACTOR_VERSION);
  });

  test("the shape C5 names is present — 28 descriptors, 67 pairs, a labelled provider snapshot", () => {
    expect(fixture.descriptors).toHaveLength(28);
    expect(new Set(fixture.descriptors.map((row) => row.ideaId)).size).toBe(28);
    expect(fixture.pairs).toHaveLength(67);
    expect(fixture.pairs.every((pair) => pair.gated)).toBe(true);
    expect(fixture.confirmed.length + fixture.rejected.length).toBe(67);
    expect(fixture.snapshot).toHaveLength(21);
    // C5's own floor: at least five pairs carry the four named fields, and all three distance classes the
    // taxonomy can express are exercised — a fixture that only saw `null` would not pin the axis.
    expect(fixture.pairs.length).toBeGreaterThanOrEqual(5);
    expect(new Set(fixture.pairs.map((pair) => pair.distance))).toEqual(new Set([1, 2, null]));
  });
});

describe("the premise — the committed alignments come from the committed descriptors", () => {
  test("every per-field term re-derives from the fixture's own descriptor strings", () => {
    const byId = new Map(fixture.descriptors.map((row) => [row.ideaId, row.descriptor]));
    for (const pair of fixture.pairs) {
      const [aId, bId] = pair.key.split("|") as [string, string];
      const a = byId.get(aId);
      const b = byId.get(bId);
      expect(a, `${pair.key}: descriptor for ${aId}`).toBeDefined();
      expect(b, `${pair.key}: descriptor for ${bId}`).toBeDefined();
      for (const field of FIELDS) {
        expect(jaccard(tokenise(a![field]), tokenise(b![field])), `${pair.key} · ${field}`).toBe(
          pair[field],
        );
      }
      const mean = FIELDS.reduce((total, field) => total + pair[field], 0) / FIELDS.length;
      expect(mean, `${pair.key} · mean`).toBe(pair.alignment);
    }
  });

  test("the re-derivation is not vacuous — the terms vary, and some are zero", () => {
    // A frozen copy that always returned the same number would pass the loop above on a constant fixture.
    const terms = fixture.pairs.flatMap((pair) => FIELDS.map((field) => pair[field]));
    expect(new Set(terms).size).toBeGreaterThan(5);
    expect(terms.some((term) => term === 0)).toBe(true);
    expect(terms.some((term) => term > 0)).toBe(true);
  });
});

describe("the deterministic half — the shipped gate at explicit τ* returns the committed pairs", () => {
  test("67 pairs, exact keys · distances · alignments, with no provider call", async () => {
    const db = newDb();
    seedVault(db, loadVault());
    const run = runFixture(db);

    // A warm cache: the throwing extractor is never reached, which is what makes "0 calls" measured.
    await run.extract();
    expect(run.extractCalls).toBe(0);

    const union = await run.union();
    expect(run.adjudicateCalls).toBe(0); // the provider half is a snapshot — nothing is adjudicated here

    // `union()` is the shipped gate's own read (`w9-run.ts` D1) filtered at the floor the fixture was
    // generated at. On a one-idea-per-cluster vault every pair is `distance ≥ 1`, so it is *identical* to
    // `createGate(…, { minDomainDistance: 1, minAlignment: FLOOR }).gatedPairs(cut)` — `gated?` below is
    // exactly "in that set", and the comparator's own inclusivity at the boundary is pinned separately by
    // `gate.test.ts` (#111/#112).

    // `gated?` is exactly "in the union at τ*", so the whole row is compared field for field.
    expect(
      union.map((pair) => ({
        key: pair.key,
        distance: pair.distance,
        alignment: pair.alignment,
        gated: true,
      })),
    ).toEqual(
      fixture.pairs.map((pair) => ({
        key: pair.key,
        distance: pair.distance,
        alignment: pair.alignment,
        gated: pair.gated,
      })),
    );
  });

  test("the floor bites — a τ just above τ* drops the boundary pairs", async () => {
    // Without this, a block that gated *everything* would satisfy the test above. The pairs sitting
    // exactly on τ* (exact `1/50`, stored exactly `0.02`) are the ones that must fall away.
    const atFloor = await (async () => {
      const db = newDb();
      seedVault(db, loadVault());
      return (await runFixture(db).union()).map((pair) => pair.key);
    })();
    const justAbove = await (async () => {
      const db = newDb();
      seedVault(db, loadVault());
      return (await runFixture(db, 0.0200001).union()).map((pair) => pair.key);
    })();
    expect(atFloor.length).toBe(67);
    // Exactly the four pairs whose exact alignment is `1/50` (stored exactly `0.02`) fall away — no
    // other pair sits between `0.02` and the next attainable value (`0.020270…`).
    expect(justAbove.length).toBe(63);
    expect(justAbove.every((key) => atFloor.includes(key))).toBe(true);
  });

  test("the cache is load-bearing — a stale producer fires the throwing extractor", async () => {
    // Non-vacuity for "0 provider calls": plant the state the guard forbids (a descriptor seeded for a
    // different model ⇒ hash mismatch ⇒ miss) and watch it fail rather than spend.
    const db = newDb();
    seedVault(db, loadVault());
    seedDescriptors(db, loadVault(), "some-other-model");
    const run = createCalibrationRun(db, {
      extractor: providerCall("extractor fired on a cache miss"),
      adjudicator: providerCall("adjudicator fired on a cache miss"),
      model: MODEL,
      unionTau: FLOOR,
    });
    await expect(run.extract()).rejects.toThrow(/PROVIDER CALL/);
  });
});

describe("the provider half is a snapshot, and is not evidence", () => {
  test("the recorded keys partition the gated set, and the drafts are recorded only", () => {
    const gated = new Set(fixture.pairs.map((pair) => pair.key));
    const confirmed = new Set(fixture.confirmed);
    const rejected = new Set(fixture.rejected);
    expect(confirmed.size).toBe(21);
    expect(rejected.size).toBe(46);
    expect([...confirmed, ...rejected].sort()).toEqual([...gated].sort());
    expect(fixture.confirmed.filter((key) => rejected.has(key))).toEqual([]);
    // The snapshot rows are the confirmed keys' drafts — the field set a blind score would read.
    expect(fixture.snapshot.map((row) => row.key).sort()).toEqual([...confirmed].sort());
    for (const row of fixture.snapshot) {
      for (const field of ["direction", "claim", "what_it_takes", "first_step", "mechanism"]) {
        expect(row.draft[field], `${row.key} · ${field}`).toBeTruthy();
      }
    }
  });
});
