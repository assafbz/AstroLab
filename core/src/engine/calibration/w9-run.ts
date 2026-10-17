import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { currentVaultRevision, readClusters } from "@astrolab/store";
import { parse as parseYaml } from "yaml";

import {
  EXTRACTION_SYSTEM,
  extractionUser,
  type IdeaText,
  type MechanismExtractor,
  type SparkAdjudicator,
} from "../../provider/index.js";
import { createAdjudicator, type Adjudication } from "../adjudicate.js";
import { createDomainDistance, type DomainDistance } from "../domain.js";
import { createGate, type GatedPair } from "../gate.js";
import { createMechanismCache, EXTRACTOR_VERSION } from "../mechanism.js";
import { cutVault } from "../../queue.js";

/**
 * The W9 calibration driver (issue #34; the bar is `docs/W9_CALIBRATION.md` on `main`).
 *
 * W9's job is to pick a **documented** `min_alignment` over a representative vault and to confirm the
 * mechanism-descriptor field set (ARCH §12 item 2). The vault is **28 ideas, one per shipped cluster**,
 * and the run is scored against the frozen bar. This module is the whole mechanical spine — it does not
 * decide anything; every number the bar names is *derived* here from the committed vault and the merged
 * stages, so the run's report and the fixture cannot drift from the code.
 *
 * ## The fixture is the input of record, and the prompt size is derived from it (S1)
 *
 * `w9-vault.yaml` sits beside this module. P1's posting is a function of the committed text:
 * `p1Posting` re-measures the prompt from `EXTRACTION_SYSTEM` + `extractionUser`, so **editing a vault
 * line moves the number** — which is exactly the ratified spend rule (*a superseded number is not fired
 * on*; the run never spends "to find out"). The calibration test reads the committed file and pins the
 * shipped figure, so a quiet text edit fails the suite instead of shipping a stale posting.
 *
 * ## The stage boundaries are the plan's slice boundaries (D1)
 *
 * The six helpers map one-to-one onto the ratified slice order, and each is the unit a phase is posted
 * against:
 *
 * | step | method | calls | ratified as |
 * | :-- | :-- | :-- | :-- |
 * | extract (P1) | `extract()` | `28` | slice 2 — one call per idea, cached in `idea_mechanism` |
 * | the alignment matrix | `matrix()` | `0` (warm) | slice 2 — the local, AI-free pairwise read |
 * | the adjudicated union | `union()` | `M = \|alignment ≥ 0.35\|` | slice 3 — deterministic from descriptors |
 * | adjudicate (P2) | `adjudicate()` | `M` | slice 3 — one call per union pair, once |
 *
 * `matrix()` delegates to the merged `createGate` rather than re-implementing the pairwise loop, so the
 * driver cannot disagree with the engine about distance, ordering or candidate selection. It runs the
 * gate at `minAlignment = 0`: on a one-idea-per-cluster vault every pair is cross-cluster, so the gate
 * returns **every** pair with its `distance` and `alignment`, and the τ sweep is then a pure filter over
 * that one paid-for read (bar §4 step 3: *the union is adjudicated once*).
 *
 * ## Tag normalisation is 0 calls, and that is *checked*, not assumed (D2)
 *
 * Every vault tag is a shipped cluster key, so `domain_map` resolves all 28 with no AI call. The driver
 * hands `createDomainDistance` a normaliser that **throws** — so "0 normalisation calls" is an invariant
 * the run breaks loudly on, rather than a silent 28-call cost the posting never accounted for.
 *
 * ## What this module is not (D3)
 *
 * No provider is constructed and no network call is made: the caller injects the extractor and the
 * adjudicator (the environment adapter in a real run; a script in a test). It ships **unwired** —
 * nothing in `worker/src/index.ts` names it — exactly like the stages it drives, so the calibration
 * surface never reaches the worker's run loop. The pure scoring (`perTauCurve`, `selectTau`) takes the
 * reviewer's blind verdicts as input and computes nothing the bar does not define.
 *
 * ## Why this module reads no file and writes no `idea` (D4)
 *
 * Two checked invariants in this repo forbid the obvious shortcut, and both are right to:
 * `worker/src/provider/boundary.test.ts` fails if any `src/` outside `api/` writes `idea` /
 * `idea_version` (`ARCHITECTURE.md` §7: *"neither the engine nor the API generates ideas on the user's
 * behalf"*), and fails if any workspace `src/` reads a file other than the shipped taxonomy (*"no note
 * import"*, `PRD.md` §3.4 item 3). A calibration fixture is neither of those things, but a path-based
 * guard cannot tell — so the fixture's **seeding and file read live with the harness**, never here:
 * `parseVault` takes text, `p1Posting`/`coverageViolations` take parsed ideas, and the driver takes an
 * already-seeded db. This module stays pure enough to sit in `src/`.
 */

/** One vault idea: the three fields the extractor sees, plus the single cluster tag it carries. */
export interface W9Idea {
  id: string;
  cluster: string;
  hypothesis: string;
  problem: string;
  monetization: string;
}

/** The committed fixture (slice 1). A text edit to it is what moves P1's prompt size (`p1Posting`). */
export const W9_VAULT_PATH = fileURLToPath(new URL("./w9-vault.yaml", import.meta.url));

/** The swept range (bar §4 step 3). A τ above it is the free upward re-score (bar §4 step 6). */
export const W9_TAUS = [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65] as const;

/**
 * The **widened** sweep (bar §4 step 6.4 — the pre-authorized "extend below 0.35" phase). `W9_TAUS`
 * was chosen to bracket the *then-provisional* default (`store/src/config.ts`, `min_alignment = 0.5`
 * before 2026-10-15), not the metric: `descriptorSimilarity` is a uniform mean of per-field Jaccard,
 * and cross-domain ideas share a mechanism *concept*, not lexemes, so alignment sits well below
 * `0.35`. This list spans the metric's range and then carries `W9_TAUS` unchanged for continuity; its
 * floor, `0.02`, **is** the value W9 now seeds as τ\* — below the ratified range, not at its edge. It
 * is passed at **runtime** — `W9_TAUS` is not touched, so `selectTau`'s tests still assert `0.35`.
 */
export const W9_WIDE_TAUS = [
  0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.1, 0.11, 0.12, 0.13, 0.15, 0.2, 0.25, 0.3, 0.35,
  0.4, 0.45, 0.5, 0.55, 0.6, 0.65,
] as const;

/** The union floor — P2 adjudicates every pair at or above it, once (bar §4 step 3; slice 3). */
export const W9_UNION_TAU = 0.35;

/** Bar §3 C3: precision ≥ 80% across the surfaced set. */
export const W9_PRECISION_FLOOR = 0.8;

/** Bar §3 C4: ≥ 5 good sparks surface. */
export const W9_YIELD_FLOOR = 5;

function fail(message: string): never {
  throw new Error(`W9 vault: ${message}`);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${where} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function asText(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "")
    fail(`${where}.${key} must be a non-blank string`);
  return value;
}

/** The extractor's payload for one vault idea — the same three fields `readIdeaText` returns. */
export function ideaTextOf(
  idea: Pick<W9Idea, "hypothesis" | "problem" | "monetization">,
): IdeaText {
  return { hypothesis: idea.hypothesis, problem: idea.problem, monetization: idea.monetization };
}

/**
 * Parse and validate the vault: a non-empty list, non-blank text, unique ids, and **one idea per
 * cluster** (bar §3 C1 — the property that makes every pair cross-cluster). Validating the *file* is
 * deliberately separate from validating it against the *shipped taxonomy* (`coverageViolations`): a
 * loader that hard-coded "28" could not describe a different vault, and the calibration is written for
 * the general shape.
 */
export function parseVault(text: string, source: string): W9Idea[] {
  const doc = parseYaml(text);
  if (!Array.isArray(doc)) fail(`${source} must be a YAML list of ideas`);
  if (doc.length === 0) fail(`${source} has no ideas`);

  const ideas = doc.map((raw, i): W9Idea => {
    const where = `${source}[${i}]`;
    const entry = asRecord(raw, where);
    return {
      id: asText(entry, "id", where),
      cluster: asText(entry, "cluster", where),
      hypothesis: asText(entry, "hypothesis", where),
      problem: asText(entry, "problem", where),
      monetization: asText(entry, "monetization", where),
    };
  });

  const ids = new Set<string>();
  const clusters = new Set<string>();
  for (const idea of ideas) {
    if (ids.has(idea.id)) fail(`duplicate idea id: ${idea.id}`);
    if (clusters.has(idea.cluster))
      fail(`cluster ${idea.cluster} carries two ideas (C1 is one per cluster)`);
    ids.add(idea.id);
    clusters.add(idea.cluster);
  }
  return ideas;
}

/**
 * C1 against the **live** taxonomy: the vault must cover exactly the shipped clusters — no missing, no
 * extra. Returning the violations rather than throwing keeps this usable as a report line *and* as a
 * test assertion. The cluster set comes from `domain_cluster` (seeded at boot), so a vault can never
 * claim coverage of a cluster the engine cannot normalise to.
 */
export function coverageViolations(db: DatabaseSync, ideas: readonly W9Idea[]): string[] {
  const shipped = new Set(readClusters(db).map((cluster) => cluster.id));
  const present = new Set(ideas.map((idea) => idea.cluster));
  const missing = [...shipped].filter((id) => !present.has(id)).sort();
  const extra = [...present].filter((id) => !shipped.has(id)).sort();
  const violations: string[] = [];
  if (missing.length > 0) violations.push(`clusters with no idea: ${missing.join(", ")}`);
  if (extra.length > 0) violations.push(`ideas in an unshipped cluster: ${extra.join(", ")}`);
  return violations;
}

/** P1's posting (bar §5): the count and the prompt size, derived from the committed text. */
export interface P1Posting {
  /** One call per idea (§3.1) — deterministic once the vault is fixed. */
  calls: number;
  /** `EXTRACTION_SYSTEM.length`, the same on every call. */
  systemCharsPerCall: number;
  /** `extractionUser(idea).length` summed over the vault. */
  userChars: number;
  /** `systemCharsPerCall * calls + userChars` — the measured prompt, in characters. */
  promptChars: number;
  meanCharsPerCall: number;
}

/**
 * The ratified P1 numbers, **re-measured** from the committed vault and the shipped prompt. Character
 * counts are exact; the token count is not derivable locally (DeepSeek's tokenizer is not available),
 * so this stays in characters and the posting labels its ~4-chars/token estimate as one.
 */
export function p1Posting(ideas: readonly W9Idea[]): P1Posting {
  const userChars = ideas.reduce(
    (total, idea) => total + extractionUser(ideaTextOf(idea)).length,
    0,
  );
  const promptChars = EXTRACTION_SYSTEM.length * ideas.length + userChars;
  return {
    calls: ideas.length,
    systemCharsPerCall: EXTRACTION_SYSTEM.length,
    userChars,
    promptChars,
    meanCharsPerCall: ideas.length === 0 ? 0 : promptChars / ideas.length,
  };
}

/** One pair as the matrix and the curve read it — the gate's evidence, minus the descriptors. */
export interface CalibrationPair {
  /** `[aId, bId].sort().join("|")` — W5's canonical key (D6), so a pair is named the same everywhere. */
  key: string;
  aId: string;
  bId: string;
  /** W4's `between()`: `0 | 1 | 2 | null`. The vault is one-idea-per-cluster, so `0` cannot occur. */
  distance: number | null;
  /** `descriptorSimilarity()`, `[0,1]` (§3.3 step 2). */
  alignment: number;
}

/** The lean shape the curve and the artifacts carry — the descriptors themselves are not in scope. */
function toPair(pair: GatedPair): CalibrationPair {
  return {
    key: pair.key,
    aId: pair.aId,
    bId: pair.bId,
    distance: pair.distance,
    alignment: pair.alignment,
  };
}

/** The driver's injected AI, plus the model whose identity enters P1's cache key (`mechanism.ts`). */
export interface CalibrationRunOptions {
  extractor: MechanismExtractor;
  adjudicator: SparkAdjudicator;
  /** The pinned model (`AI_MODEL` unset ⇒ `deepseek/deepseek-v4-flash`) — construction data, not re-derived. */
  model: string;
  /**
   * The union floor `union()` **and** `adjudicate()` both filter at — resolved **once** so the harness's
   * cap input (the dry `union().length`) cannot diverge from the live spend. Omitted ⇒ `W9_UNION_TAU`
   * (`0.35`, the bar's ratified floor). The below-`0.35` widening (bar §4 step 6.4) passes a lower value
   * at runtime, so `W9_UNION_TAU` — read by `selectTau`'s tests — stays untouched.
   */
  unionTau?: number;
}

export interface CalibrationRun {
  /** The cut this run drives: the vault's ids, ASC. */
  readonly cut: { revision: number; ideaIds: string[] };
  /** P1 requests made so far — `28` on a cold cache, `0` on a warm one. The posting's evidence. */
  readonly extractCalls: number;
  /** P2 requests made so far — `|union|` at the run's floor, and never more (bar §5's hard cap). */
  readonly adjudicateCalls: number;
  /** P1 (slice 2): extract and cache a descriptor per idea. Reaches the provider once per *miss*. */
  extract(): Promise<{ calls: number }>;
  /** The alignment matrix (slice 2): every cross-cluster pair, `pair_key`-sorted, AI-free once warm. */
  matrix(): Promise<CalibrationPair[]>;
  /** The paid union (slice 3): the matrix's pairs at the run's floor (`W9_UNION_TAU`, or widened — §4 step 6.4). Deterministic; no calls. */
  union(): Promise<CalibrationPair[]>;
  /** P2 (slice 3): one adjudication call per union pair, in one pass. */
  adjudicate(): Promise<Adjudication>;
}

/**
 * Build the driver over an already-seeded vault db. The merge `createGate`/`createAdjudicator` are
 * reused (D1), so the driver carries no engine logic of its own — only the wiring and the counts.
 */
export function createCalibrationRun(
  db: DatabaseSync,
  options: CalibrationRunOptions,
): CalibrationRun {
  let extractCalls = 0;
  let adjudicateCalls = 0;
  // One floor, consumed by both `union()` and `adjudicate()`: the dry pass the harness caps against and
  // the live pass it spends on filter the identical set by construction, never by two filters kept in sync
  // by hand. `w9-run.test.ts` pins that equality at a non-default floor.
  const unionTau = options.unionTau ?? W9_UNION_TAU;

  const extractor: MechanismExtractor = {
    async extract(text) {
      extractCalls += 1;
      return options.extractor.extract(text);
    },
  };
  const adjudicator: SparkAdjudicator = {
    async adjudicate(a, b, mechanisms) {
      adjudicateCalls += 1;
      return options.adjudicator.adjudicate(a, b, mechanisms);
    },
  };

  // D2: a normaliser that throws — every vault tag is a shipped cluster key, so this is unreachable,
  // and the run fails loudly rather than spending 28 uncounted calls if that ever stops being true.
  const normalizer = {
    normalizeTag(tag: string): Promise<string> {
      return Promise.reject(
        new Error(
          `W9: tag ${JSON.stringify(tag)} should resolve in domain_map — normalisation is 0 calls`,
        ),
      );
    },
  };
  const distance: DomainDistance = createDomainDistance(db, normalizer);

  const producer = { version: EXTRACTOR_VERSION, model: options.model };
  const mechanisms = createMechanismCache(db, extractor, producer);
  // The gate at `minAlignment = 0`: on a one-idea-per-cluster vault no pair is distance-0, so this is
  // every pair — the full matrix, in the engine's own distance/ordering semantics (D1).
  const gate = createGate(db, mechanisms, distance, { minDomainDistance: 1, minAlignment: 0 });
  const adjudicate = createAdjudicator(db, adjudicator);

  const cut = cutVault(db, currentVaultRevision(db));

  async function matrix(): Promise<CalibrationPair[]> {
    const pairs = await gate.gatedPairs(cut);
    return pairs.map(toPair);
  }

  async function union(): Promise<CalibrationPair[]> {
    return (await matrix()).filter((pair) => pair.alignment >= unionTau);
  }

  return {
    cut,
    get extractCalls() {
      return extractCalls;
    },
    get adjudicateCalls() {
      return adjudicateCalls;
    },

    async extract() {
      for (const id of cut.ideaIds) await mechanisms.descriptorFor(id);
      return { calls: extractCalls };
    },

    matrix,

    union,

    async adjudicate() {
      // One gate pass, then the union filter — the `GatedPair` payloads (descriptors included) the
      // adjudicator compares travel straight through; no second materialisation.
      const gated = (await gate.gatedPairs(cut)).filter((pair) => pair.alignment >= unionTau);
      return adjudicate.adjudicate(gated);
    },
  };
}

/** One point of the precision/yield curve (bar §4 step 5). */
export interface TauPoint {
  tau: number;
  /** Adjudicator-confirmed pairs at `alignment ≥ tau`. */
  surfaced: number;
  /** Of the surfaced, the reviewer's blind **good**. */
  good: number;
  /** `good / surfaced`, or `null` when nothing surfaced (C4's silent failure, made explicit). */
  precision: number | null;
  meetsPrecision: boolean;
  meetsYield: boolean;
  /** Both C3 and C4 hold at this τ — the pass condition, τ\*'s definition. */
  passes: boolean;
}

/**
 * The curve per τ (bar §4 step 5): for each swept τ, the surfaced set (confirmed ∧ `alignment ≥ τ`)
 * with its precision and yield. `confirmed` is P2's confirmed keys; `good` is the reviewer's blind
 * verdicts (a subset of `confirmed`). Both are inputs — the driver does not score anything itself.
 */
export function perTauCurve(
  pairs: readonly CalibrationPair[],
  confirmed: ReadonlySet<string>,
  good: ReadonlySet<string>,
  taus: readonly number[] = W9_TAUS,
): TauPoint[] {
  return taus.map((tau) => {
    const surfaced = pairs.filter((pair) => confirmed.has(pair.key) && pair.alignment >= tau);
    const goodCount = surfaced.filter((pair) => good.has(pair.key)).length;
    const precision = surfaced.length === 0 ? null : goodCount / surfaced.length;
    const meetsPrecision = precision !== null && precision >= W9_PRECISION_FLOOR;
    const meetsYield = goodCount >= W9_YIELD_FLOOR;
    return {
      tau,
      surfaced: surfaced.length,
      good: goodCount,
      precision,
      meetsPrecision,
      meetsYield,
      passes: meetsPrecision && meetsYield,
    };
  });
}

/**
 * τ\* = the **lowest** τ clearing both conditions — the owner-approved shape, which maximises yield
 * (bar §4 step 5). `null` when no swept τ passes: **a legitimate result**, and the failure path of bar
 * §4 step 6 (the free upward re-score first, then the descriptor/vault findings), never a silent widen.
 */
export function selectTau(curve: readonly TauPoint[]): number | null {
  const passing = curve.filter((point) => point.passes);
  if (passing.length === 0) return null;
  return Math.min(...passing.map((point) => point.tau));
}

/**
 * C2: **no same-cluster pair surfaces** (`distance === 0`). On this fixture the gate drops them before
 * adjudication, so this must always be empty — asserted rather than assumed, because a vault that ever
 * carried two ideas in one cluster would turn C1's construction into a real cliché risk.
 */
export function sameClusterSurfaced(
  pairs: readonly CalibrationPair[],
  surfaceKeys: ReadonlySet<string>,
): string[] {
  return pairs
    .filter((pair) => surfaceKeys.has(pair.key) && pair.distance === 0)
    .map((pair) => pair.key)
    .sort();
}
