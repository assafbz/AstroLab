import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import {
  currentVaultRevision,
  MIGRATIONS,
  migrate,
  openStore,
  readClusters,
  readDomainMap,
  seedDomainTaxonomy,
  vaultMutation,
} from "@astrolab/store";
import { describe, expect, test } from "vitest";

import {
  EXTRACTION_SYSTEM,
  type IdeaText,
  type MechanismDescriptor,
} from "../../provider/index.js";
import {
  coverageViolations,
  createCalibrationRun,
  ideaTextOf,
  p1Posting,
  parseVault,
  perTauCurve,
  sameClusterSurfaced,
  selectTau,
  W9_TAUS,
  W9_UNION_TAU,
  W9_VAULT_PATH,
  type CalibrationPair,
  type W9Idea,
} from "./w9-run.js";

/**
 * W9 slice 1 — the vault, the driver, and the deterministic gate/score path (issue #34; bar
 * `docs/W9_CALIBRATION.md`). No provider call is made anywhere in this file: the extractor and the
 * adjudicator are scripted, and the numbers the bar names are asserted against the **committed** vault.
 *
 * The load-bearing case is `p1Posting` on the shipped file: P1's posting is a function of the vault
 * text, so pinning 15,587 chars makes a quiet edit fail the suite — the mechanical half of the spend
 * rule (*a superseded number is not fired on*). The rest pins the slice boundaries (28 / 0 / M) and the
 * curve's definition.
 */

function newDb(): DatabaseSync {
  const db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  seedDomainTaxonomy(db);
  return db;
}

/**
 * The committed fixture, read **here** rather than in `w9-run.ts` (D4): the driver stays free of a file
 * read so `provider/boundary.test.ts`'s "the only reader in a `src/` is the shipped taxonomy" stays
 * exact, and this file (a test) is outside that guard's walk by construction. Reading the *committed*
 * file — not a copy — is what makes the P1 pin below a guard against a silent vault edit.
 */
function loadVault(): W9Idea[] {
  return parseVault(readFileSync(W9_VAULT_PATH, "utf8"), W9_VAULT_PATH);
}

/** Seed the vault into `idea`, through `vaultMutation` (§4's trigger). The harness's write, not the driver's. */
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

/** A descriptor identical for every idea: every pair aligns at 1, so the union is the whole matrix. */
function uniformDescriptor(): MechanismDescriptor {
  return {
    verb: "amortise",
    object_class: "a fixed setup cost",
    constraint: "one batch",
    transferable_structure: "spread a fixed setup cost across many units",
  };
}

/**
 * Only `transferable_structure` is shared ⇒ every pair aligns at exactly 0.25 — below the union floor.
 * The other three fields are keyed on a digest of the whole text, so no two ideas can share a token
 * there however alike their prose is.
 */
function weaklyAligned(text: IdeaText): MechanismDescriptor {
  const digest = createHash("sha256").update(JSON.stringify(text)).digest("hex").slice(0, 12);
  return {
    verb: digest,
    object_class: `${digest}a`,
    constraint: `${digest}b`,
    transferable_structure: "spread a fixed setup cost across many units",
  };
}

const countExtractor = (descriptorFor: (text: IdeaText) => MechanismDescriptor) => {
  const seen: string[] = [];
  return {
    seen,
    extractor: {
      async extract(text: IdeaText): Promise<MechanismDescriptor> {
        seen.push(text.hypothesis);
        return descriptorFor(text);
      },
    },
  };
};

const noAdjudicator = {
  async adjudicate(): Promise<null> {
    return null;
  },
};

describe("the committed vault (C1)", () => {
  test("parses to 28 ideas covering the shipped taxonomy exactly, order included", () => {
    const db = newDb();
    const ideas = loadVault();

    expect(ideas).toHaveLength(28);
    expect(new Set(ideas.map((idea) => idea.id)).size).toBe(28);
    expect(coverageViolations(db, ideas)).toEqual([]);
    // Exact coverage of the shipped taxonomy — `readClusters` sorts by id, the vault is in file order, so
    // the comparison is as sets: no missing cluster, no extra.
    const shipped = readClusters(db).map((cluster) => cluster.id);
    expect([...ideas.map((idea) => idea.cluster)].sort()).toEqual([...shipped].sort());
  });

  test("every tag is a shipped cluster key, so every tag resolves locally", () => {
    const db = newDb();
    const ideas = loadVault();
    const mapped = readDomainMap(
      db,
      ideas.map((idea) => idea.cluster),
    );
    expect(mapped.size).toBe(28); // all resolve — 0 normalisation calls (bar §4, §5)
  });

  test("rejects a malformed file: no list, blank field, duplicate id, duplicate cluster", () => {
    expect(() => parseVault("just: a mapping", "x")).toThrow(/must be a YAML list/);
    expect(() =>
      parseVault("- id: a\n  cluster: c\n  hypothesis: ''\n  problem: p\n  monetization: m", "x"),
    ).toThrow(/hypothesis/);
    const two = (first: string, second: string) =>
      parseVault(
        `- id: ${first}\n  cluster: c\n  hypothesis: h\n  problem: p\n  monetization: m\n` +
          `- id: ${second}\n  cluster: d\n  hypothesis: h\n  problem: p\n  monetization: m`,
        "x",
      );
    expect(() => two("dup", "dup")).toThrow(/duplicate idea id/);
    expect(() =>
      parseVault(
        "- id: a\n  cluster: c\n  hypothesis: h\n  problem: p\n  monetization: m\n- id: b\n  cluster: c\n  hypothesis: h\n  problem: p\n  monetization: m",
        "x",
      ),
    ).toThrow(/one per cluster/);
  });
});

describe("P1's posting is derived from the committed text (spend rule)", () => {
  test("the shipped vault posts 28 calls at 15,587 prompt chars", () => {
    const posting = p1Posting(loadVault());

    expect(posting.calls).toBe(28);
    expect(posting.systemCharsPerCall).toBe(EXTRACTION_SYSTEM.length);
    expect(posting.systemCharsPerCall).toBe(295);
    expect(posting.userChars).toBe(7_327);
    expect(posting.promptChars).toBe(15_587);
    expect(posting.meanCharsPerCall).toBeCloseTo(556.68, 1);
  });

  test("editing one vault line moves the number — the posting cannot go stale silently", () => {
    const ideas = loadVault();
    const edited = ideas.map((idea, i) =>
      i === 0 ? { ...idea, hypothesis: `${idea.hypothesis} Extra words here.` } : idea,
    );

    expect(p1Posting(edited).promptChars).toBeGreaterThan(p1Posting(ideas).promptChars);
  });
});

describe("seedVault writes the fixture through the sanctioned path", () => {
  test("28 ACTIVE ideas, each tagged with its cluster key, stamped by vaultMutation", () => {
    const db = newDb();
    const ideas = loadVault();
    const before = currentVaultRevision(db);

    seedVault(db, ideas);

    expect(db.prepare("SELECT COUNT(*) AS n FROM idea").get()).toEqual({ n: 28 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM idea WHERE status = 'ACTIVE'").get()).toEqual({
      n: 28,
    });
    expect(db.prepare("SELECT domain_tags FROM idea WHERE id = ?").get("w9-devtools")).toEqual({
      domain_tags: '["devtools"]',
    });
    expect(currentVaultRevision(db)).toBe(before + 1); // a real vault mutation (§4)
  });
});

describe("the driver — slice boundaries (28 → 0 → M)", () => {
  test("P1 fires once per idea, then the matrix is AI-free and complete, the union filters it", async () => {
    const db = newDb();
    seedVault(db, loadVault());
    const { extractor, seen } = countExtractor(uniformDescriptor);
    const run = createCalibrationRun(db, {
      extractor,
      adjudicator: noAdjudicator,
      model: "deepseek/deepseek-v4-flash",
    });

    expect(run.cut.ideaIds).toHaveLength(28);

    // P1: one call per idea (slice 2).
    await run.extract();
    expect(run.extractCalls).toBe(28);
    expect(seen).toHaveLength(28);
    // Warm cache: a second pass spends nothing (mechanism.ts's `source_hash` hit).
    await run.extract();
    expect(run.extractCalls).toBe(28);

    // The matrix: every cross-cluster pair, `pair_key`-sorted, no AI call (slice 2).
    const matrix = await run.matrix();
    expect(matrix).toHaveLength((28 * 27) / 2);
    expect(matrix.map((pair) => pair.key)).toEqual([...matrix.map((pair) => pair.key)].sort());
    expect(matrix.some((pair) => pair.distance === 0)).toBe(false);
    expect(run.extractCalls).toBe(28);
    // Deterministic read.
    expect((await run.matrix()).map((pair) => pair.key)).toEqual(matrix.map((pair) => pair.key));

    // The union (slice 3): at alignment 1 every pair clears 0.35.
    const union = await run.union();
    expect(union).toHaveLength(matrix.length);
    expect(union.every((pair) => pair.alignment >= W9_UNION_TAU)).toBe(true);
  });

  test("P2 makes exactly one call per union pair and never exceeds the cap", async () => {
    const db = newDb();
    seedVault(db, loadVault());
    const { extractor } = countExtractor(uniformDescriptor);
    const keys: string[] = [];
    const run = createCalibrationRun(db, {
      extractor,
      adjudicator: {
        async adjudicate(a, b) {
          keys.push([a, b].sort().join("|"));
          return null;
        },
      },
      model: "deepseek/deepseek-v4-flash",
    });

    const union = await run.union();
    const adjudication = await run.adjudicate();

    expect(run.adjudicateCalls).toBe(union.length);
    expect(run.adjudicateCalls).toBe(378);
    expect(adjudication.confirmed).toEqual([]); // the script declines every pair
    expect(adjudication.rejected).toHaveLength(378);
    expect(keys).toHaveLength(378);
  });

  test("a vault whose pairs sit below the floor yields an empty union — 0 P2 calls", async () => {
    const db = newDb();
    seedVault(db, loadVault());
    const { extractor } = countExtractor(weaklyAligned);
    const run = createCalibrationRun(db, {
      extractor,
      adjudicator: noAdjudicator,
      model: "deepseek/deepseek-v4-flash",
    });

    const matrix = await run.matrix();
    expect(matrix).toHaveLength(378);
    expect(matrix.every((pair) => pair.alignment === 0.25)).toBe(true); // 1 of 4 fields shared
    expect(await run.union()).toEqual([]);
    expect((await run.adjudicate()).confirmed).toEqual([]);
    expect(run.adjudicateCalls).toBe(0);
  });

  /**
   * The widening (bar §4 step 6.4) makes the floor a **runtime** value, and the floor is filtered in
   * **two** independent places — `union()` (the dry pass the harness caps against) and `adjudicate()`
   * (the live spend). If only one honoured `unionTau` the cap would stop tracking the spend:
   * parameterizing `union()` alone silently **under-spends** (`M_wide` claimed over `adjudicateCalls:
   * 0`), and `adjudicate()` alone spends `M_wide` before a cap computed as `0` trips. This pins the two
   * filters equal at a non-default floor, so a future edit to one site fails the suite (David/Max, #34).
   */
  test("the widened floor is one source of truth — union() and adjudicate() filter the same set", async () => {
    const db = newDb();
    seedVault(db, loadVault());
    // Every pair aligns at exactly 0.25: below the default 0.35 floor, above the widened 0.02 one.
    const { extractor } = countExtractor(weaklyAligned);
    // The adjudicator sees `IdeaText`, not ids — so key each pair through its text back to its id.
    const idByText = new Map(
      loadVault().map((idea) => [JSON.stringify(ideaTextOf(idea)), idea.id]),
    );
    const keys: string[] = [];
    const widened = createCalibrationRun(db, {
      extractor,
      adjudicator: {
        async adjudicate(a, b) {
          const ka = idByText.get(JSON.stringify(a))!;
          const kb = idByText.get(JSON.stringify(b))!;
          keys.push([ka, kb].sort().join("|"));
          return null;
        },
      },
      model: "deepseek/deepseek-v4-flash",
      unionTau: 0.02,
    });

    const union = await widened.union();
    await widened.adjudicate();

    // The whole matrix clears the widened floor; the default floor would have surfaced nothing.
    expect(union).toHaveLength(378);
    // The cap input (`union.length`) equals the live spend, and the pair sets are key-equal.
    expect(widened.adjudicateCalls).toBe(union.length);
    expect(new Set(keys)).toEqual(new Set(union.map((pair) => pair.key)));

    // Defaults untouched: the same (now warm) cache with no `unionTau` yields an empty union, 0 calls.
    const atDefault = createCalibrationRun(db, {
      extractor,
      adjudicator: noAdjudicator,
      model: "deepseek/deepseek-v4-flash",
    });
    expect(await atDefault.union()).toEqual([]);
    expect(atDefault.extractCalls).toBe(0);
  });
});

describe("the curve and τ* (bar §3 C3/C4, §4 step 5)", () => {
  /** A pair at a chosen alignment — the curve needs only `key` + `alignment`. */
  const at = (key: string, alignment: number): CalibrationPair => ({
    key,
    aId: key.split("|")[0]!,
    bId: key.split("|")[1]!,
    distance: null,
    alignment,
  });

  test("precision and yield per τ, and τ* is the lowest τ clearing both", () => {
    // Six confirmed pairs; five are reviewer-good. All clear 0.35, so yield ≥ 5 everywhere in range.
    const pairs = [
      at("a|b", 0.9),
      at("a|c", 0.8),
      at("a|d", 0.7),
      at("a|e", 0.6),
      at("a|f", 0.5),
      at("a|g", 0.4),
    ];
    const confirmed = new Set(pairs.map((pair) => pair.key));
    const good = new Set(["a|b", "a|c", "a|d", "a|e", "a|f"]); // a|g is the one rejection

    const curve = perTauCurve(pairs, confirmed, good);
    expect(curve.map((point) => point.tau)).toEqual([...W9_TAUS]);
    // Low τ surfaces the rejected pair: 5/6 = 83% — still clears 80%, so nothing is dropped yet.
    const low = curve.find((point) => point.tau === 0.4)!;
    expect(low).toMatchObject({ surfaced: 6, good: 5, meetsPrecision: true, meetsYield: true });
    expect(low.precision).toBeCloseTo(5 / 6, 5);
    expect(selectTau(curve)).toBe(0.35);
  });

  test("an extra rejection at a low τ pushes precision under 80% and moves τ* up", () => {
    const pairs = [
      at("a|b", 0.9),
      at("a|c", 0.8),
      at("a|d", 0.7),
      at("a|e", 0.6),
      at("a|f", 0.5),
      at("a|g", 0.4),
      at("a|h", 0.35),
    ];
    const confirmed = new Set(pairs.map((pair) => pair.key));
    const good = new Set(["a|b", "a|c", "a|d", "a|e", "a|f"]); // two rejections at 0.4 and 0.35

    const curve = perTauCurve(pairs, confirmed, good);
    expect(curve.find((point) => point.tau === 0.35)).toMatchObject({
      surfaced: 7,
      good: 5,
      meetsPrecision: false,
    });
    // At 0.4 the 0.35 rejection drops out: 5/6 = 83%, yield 5 ⇒ τ* = 0.4 (the lowest clearing τ).
    expect(curve.find((point) => point.tau === 0.4)).toMatchObject({
      surfaced: 6,
      good: 5,
      passes: true,
    });
    expect(selectTau(curve)).toBe(0.4);
  });

  test("no τ clears ⇒ τ* is null (the bar §4 step 6 FAIL is a result, not an error)", () => {
    const pairs = [at("a|b", 0.9), at("a|c", 0.8)];
    const confirmed = new Set(pairs.map((pair) => pair.key));
    const good = new Set(["a|b"]); // yield 1 < 5 at every τ

    const curve = perTauCurve(pairs, confirmed, good);
    expect(curve.every((point) => point.passes === false)).toBe(true);
    expect(selectTau(curve)).toBeNull();
  });

  test("an empty surfaced set reports `precision: null`, never 1", () => {
    const curve = perTauCurve([at("a|b", 0.9)], new Set(["a|b"]), new Set());
    const point = curve.find((p) => p.tau === 0.65)!;
    // Confirmed but not good at 0.65? It is confirmed and aligned ⇒ surfaced = 1, good = 0.
    expect(point).toMatchObject({ surfaced: 1, good: 0 });
    expect(point.precision).toBe(0);
    // With nothing confirmed at all, precision is explicitly undefined rather than vacuously 1.
    expect(perTauCurve([at("a|b", 0.9)], new Set(), new Set())[0]!.precision).toBeNull();
  });
});

describe("C2 — no same-cluster pair can surface (bar §3 C2)", () => {
  test("the fixture's surface never contains a distance-0 pair", async () => {
    const db = newDb();
    seedVault(db, loadVault());
    const { extractor } = countExtractor(uniformDescriptor);
    const run = createCalibrationRun(db, {
      extractor,
      adjudicator: noAdjudicator,
      model: "deepseek/deepseek-v4-flash",
    });

    const matrix = await run.matrix();
    const surface = new Set((await run.union()).map((pair) => pair.key));
    expect(sameClusterSurfaced(matrix, surface)).toEqual([]);
    expect(matrix.every((pair) => pair.distance !== 0)).toBe(true);
  });
});
