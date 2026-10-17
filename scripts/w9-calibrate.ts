/**
 * W9 calibration harness — the runnable entry point (issue #34; bar `docs/W9_CALIBRATION.md`).
 *
 * **Run it:**
 *
 * ```sh
 * npx tsx scripts/w9-calibrate.ts post
 * ```
 *
 * **No build step** (L3 · #166). The driver imported `@astrolab/store` bare, whose runtime entry was
 * `dist/index.js`, so a fresh checkout needed `npm run build -w store` first (David, 2026-10-14).
 * It now imports `../core/src/…` by path — the same shape the W9 scripts always used for the
 * worker's modules — so `tsx` compiles the source and there is nothing to build first.
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
 * | `report [--floor <f>]` | **0** | the union size `M` and the alignment distribution |
 * | `widen [--floor <f>]` | **0** | the below-0.35 posting: floor, `M_wide`, the τ list, cost, the full matrix |
 * | `p2 --confirm <M> [--floor <f>]` | **M** | adjudicate the union at the floor; one call per pair, ≤ **3** attempts each — hard cap `3 × M` |
 *
 * `--floor` defaults to `W9_UNION_TAU` (`0.35`, the bar's ratified floor). The widened phase (bar §4
 * step 6.4 — *"extending below 0.35 is a NEW posted phase"*) passes a lower floor, captures the posting
 * with `widen`, and fires `p2 --floor <f> --confirm <M_wide>` only after David ratifies. `widen` is
 * deliberately **0 calls**: it re-reads the cached descriptors and prints the numbers before anything
 * spends.
 *
 * ## `p2`'s artifact — the record the thread carries (David/Max, #34)
 *
 * `p2-actuals.json` is the artifact of record. Beyond the four counts and `confirmed`/`rejected` (key
 * arrays, unchanged), it carries **`confirmedSparks`** — each confirmed key's `draft` (the field set
 * G3/G4/G5 score, dropped in-process before this change) plus **both source ideas**, so the blind
 * scoring sheet is a pure `jq` transform of the attached bytes — **`descriptors`** (the 28 cached rows,
 * with `source_hash`) and **`perFieldJaccard`** (the 67×4 terms behind each union pair's `alignment`).
 * The last two are what make step 4 re-runnable **from the artifact alone**, rather than from the
 * gitignored `data/` cache the descriptors actually lived in.
 *
 * ## The retry — why `p2` is no longer all-or-nothing (David's ruling A, #34)
 *
 * `p2` fires one adjudication call per gated pair in one pass, and this file writes the artifact only
 * *after* the loop returns. But the schema **permits** a reply the parser rejects — five props are all
 * `["string","null"]` and all `required`, so a **half-null** object is legal output that
 * `parseAdjudication` fails, and `engine/adjudicate.ts` D3 lets the `InvalidOutputError` propagate. One
 * bad reply in 67 therefore used to discard every call already made, and the ratified envelope with it —
 * the phase's completeness depended on a single call. The live adapter is now wrapped at **this** seam
 * (after `requireConfirm`/`requireLive`) with a bounded retry — **`InvalidOutputError` only**, ≤3
 * attempts per pair — so the phase no longer aborts on one bad reply: a pair that exhausts its attempts
 * is recorded **`failed`**, a third class beside `confirmed` and `rejected`, and the artifact lands on
 * every fire that starts spending. `attempts` is additive; `adjudicateCalls` keeps its `=== union`
 * meaning; the cap is **structural** (`3 × M`), so bar §5's *"stops rather than spending past the cap"*
 * now holds by construction. Re-ratified 2026-10-14: 67 pairs · expected 68–70 attempts · cap 201 ·
 * ceiling ≈$0.0137.
 *
 * ## Why this lives in `scripts/` and not in `core/src/`
 *
 * It reads a file and writes `idea`, and `core/src/provider/boundary.test.ts` forbids both inside a
 * package's `src/` (`ARCHITECTURE.md` §7; `PRD.md` §3.4 item 3). A calibration fixture is neither of
 * those things, but the guards are path-based, and widening them with a carve-out is where a check
 * starts lying — so the harness lives where the repo keeps its tools, and both guards stand as
 * authored. The guards scan paths containing a `src` segment; `scripts/` is not one (David's ruling,
 * option A, 2026-10-14).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SqliteConnection } from "../core/src/store/connection.js";

import { readDescriptors, vaultMutation } from "../core/src/store/index.js";

import { bootVault } from "../core/src/boot.js";
import { openNodeStore } from "../core/src/store/connection.node.js";
import { descriptorSimilarity } from "../core/src/engine/alignment.js";
import {
  coverageViolations,
  createCalibrationRun,
  ideaTextOf,
  parseVault,
  p1Posting,
  W9_UNION_TAU,
  W9_VAULT_PATH,
  W9_WIDE_TAUS,
  type CalibrationPair,
  type CalibrationRun,
  type W9Idea,
} from "../core/src/engine/calibration/w9-run.js";
import {
  ADJUDICATION_SYSTEM,
  adjudicationUser,
  createFetchTransport,
  createOpenRouterAdapter,
  DEFAULT_MODEL,
  InvalidOutputError,
  type IdeaText,
  type KeyStore,
  type MechanismDescriptor,
  type MechanismPair,
  type Provider,
  type SparkDraft,
} from "../core/src/provider/index.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ARTIFACTS = join(ROOT, "artifacts", "w9");

/** The fixture's db. File-backed, so P1's cache survives into the separately-ratified P2. Gitignored. */
const DB_PATH = process.env.DB_PATH ?? join(ROOT, "data", "w9-calibration.sqlite");

/** The committed fixture — the input of record. Read here, never in `src/` (see the module note). */
function loadVault(): W9Idea[] {
  return parseVault(readFileSync(W9_VAULT_PATH, "utf8"), W9_VAULT_PATH);
}

/** Upsert the vault into `idea`, through `vaultMutation` (§4's trigger). Idempotent: a re-run updates. */
function seedVault(db: SqliteConnection, ideas: readonly W9Idea[]): void {
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
function cachedCount(db: SqliteConnection, ideas: readonly W9Idea[]): number {
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

/** `--floor <f>` — the union floor the widened phase (bar §4 step 6.4) adjudicates at. Default `0.35`. */
function readFloor(argv: readonly string[]): number {
  const index = argv.indexOf("--floor");
  if (index === -1) return W9_UNION_TAU;
  const raw = argv[index + 1];
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`--floor must be a number in [0, 1]; got ${JSON.stringify(raw ?? null)}`);
  }
  return value;
}

/** Firing takes a second, deliberate key: `W9_LIVE=1`. A matching `--confirm` alone is not "post then fire". */
/**
 * The live adapter, built through the key port (L3 · #166). The app supplies a secure-store `KeyStore`;
 * an operator running the calibration has the key in their environment, and this is the whole of the
 * difference. **Refuses before spending**: a missing key is an error here, not a failed first call —
 * the harness's rule is that nothing spends without the ratified number *and* a usable key.
 */
function liveAdapter(): Provider {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (key === undefined || key === "") {
    throw new Error("OPENROUTER_API_KEY is not set — refusing to build the live adapter");
  }
  const keyStore: KeyStore = {
    get: async () => key,
    set: async () => {},
    clear: async () => {},
  };
  return createOpenRouterAdapter({
    model: process.env.AI_MODEL?.trim() || DEFAULT_MODEL,
    transport: createFetchTransport({ keyStore }),
  });
}

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

/**
 * The run, wired with either the real adapter or the throwing stub, so each command's spend is explicit.
 * `floor` is threaded to the driver's single union floor — the dry pass this harness caps against and
 * the live pass it spends on therefore filter the identical set (never two filters kept in sync).
 */
function runFor(
  db: SqliteConnection,
  provider: Provider,
  floor: number = W9_UNION_TAU,
): CalibrationRun {
  return createCalibrationRun(db, {
    extractor: provider,
    adjudicator: provider,
    // `AI_MODEL` unset ⇒ the pinned `deepseek/deepseek-v4-flash`; the same value the adapter uses.
    model: process.env.AI_MODEL?.trim() || "deepseek/deepseek-v4-flash",
    unionTau: floor,
  });
}

/**
 * How many attempts one pair gets: the first reply plus two retries. The hard cap is therefore
 * **structural** — `3 × union`, and no path in the loop below can exceed it.
 */
const ADJUDICATION_ATTEMPTS = 3;

/** What the decorator saw for one pair — the three-way outcome, recorded at the seam. */
type AdjudicationClass = "draft" | "refusal" | "exhausted";

/**
 * The decorator's per-pair record — the **authority** on which pairs exhausted their attempts. The engine
 * cannot tell a refusal from an exhausted pair: `null` is the only keep-alive return at the provider seam
 * (a throw aborts the phase, D3), and `engine/adjudicate.ts` classifies every `null` as `rejected`. So the
 * harness re-classifies `rejected` from here, and the partition check below proves it did.
 */
interface AdjudicationJournal {
  /** Provider calls made, retries included: `union ≤ attempts ≤ 3 × union`. */
  readonly attempts: number;
  /** Keys that took more than one attempt, with how many — `attempts − union` extra calls in total. */
  readonly retried: readonly { key: string; attempts: number }[];
  /** Keys that exhausted every attempt: the third class, never a refusal. */
  readonly exhausted: readonly string[];
  /** Keys the provider answered with a real refusal (all-null) — one attempt, never re-sampled. */
  readonly refusals: readonly string[];
  /** Keys the provider answered with a complete draft. */
  readonly drafts: readonly string[];
}

/**
 * Wrap the live adapter with a bounded per-pair retry (David's ruling **A**, #34). The decorator sits
 * **here**, at the harness seam, after `requireConfirm`/`requireLive` have both passed — so a re-sampled
 * pair can never move the spend in front of either key check — and the engine stays untouched: it still
 * makes exactly one `adjudicate` call per pair, and `adjudicateCalls` is bumped *outside* this wrapper.
 *
 * - **`InvalidOutputError` only** (i). `buildRequest` pins no temperature and no seed, so a retry inherits
 *   the provider default and is an independent draw **only** while that default is non-zero. The retry is
 *   therefore **best-effort**, and `failed` — not the retry — is the guarantee: if the default is `0` the
 *   attempts are byte-identical no-ops, the pair still lands in `failed`, and the artifact still lands.
 * - **`ProviderError` fails closed.** A timeout, an HTTP error or a non-JSON body propagates unchanged —
 *   the phase aborts and the artifact is not touched (today's behaviour; §4's run-level Retry is its
 *   recovery). Re-sampling a 429/5xx per pair would triple spend on a *failing* path.
 * - **A half-null is never a rejection** (iv). An exhausted pair has no return shape here but `null`, so it
 *   enters the engine's `rejected` once and `adjudicationClasses` **moves it out** into `failed` — a
 *   dropped field must not become a silent suppression (`schema.ts`).
 */
function withAdjudicationRetry(
  provider: Provider,
  keyFor: (ideaA: IdeaText, ideaB: IdeaText) => string,
): { provider: Provider; journal: AdjudicationJournal } {
  const outcome = new Map<string, AdjudicationClass>();
  const callsByKey = new Map<string, number>();
  let attempts = 0;

  const keysOf = (kind: AdjudicationClass): string[] =>
    [...outcome.entries()]
      .filter(([, value]) => value === kind)
      .map(([key]) => key)
      .sort();

  return {
    provider: {
      ...provider,
      // One pair, one `adjudicate` — the loop below re-samples the *reply*, never the pair.
      async adjudicate(
        ideaA: IdeaText,
        ideaB: IdeaText,
        mechanisms: MechanismPair,
      ): Promise<SparkDraft | null> {
        const key = keyFor(ideaA, ideaB);
        for (let attempt = 1; attempt <= ADJUDICATION_ATTEMPTS; attempt += 1) {
          attempts += 1;
          callsByKey.set(key, (callsByKey.get(key) ?? 0) + 1);
          try {
            const draft = await provider.adjudicate(ideaA, ideaB, mechanisms);
            outcome.set(key, draft === null ? "refusal" : "draft");
            return draft;
          } catch (error) {
            // (i): only invalid *output* is re-sampled — a transport/provider failure fails closed.
            if (!(error instanceof InvalidOutputError)) throw error;
            if (attempt === ADJUDICATION_ATTEMPTS) {
              outcome.set(key, "exhausted");
              // The only keep-alive return at this seam: the engine iterates on, and
              // `adjudicationClasses` re-classifies this key out of `rejected` — with the partition check
              // failing the write if it does not.
              return null;
            }
          }
        }
        /* c8 ignore next — the loop above returns on every path; this only satisfies control flow. */
        throw new Error(`p2: unreachable retry state for pair ${key}`);
      },
    },
    journal: {
      get attempts() {
        return attempts;
      },
      get retried() {
        return [...callsByKey.entries()]
          .filter(([, calls]) => calls > 1)
          .map(([key, calls]) => ({ key, attempts: calls }))
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      },
      get exhausted() {
        return keysOf("exhausted");
      },
      get refusals() {
        return keysOf("refusal");
      },
      get drafts() {
        return keysOf("draft");
      },
    },
  };
}

/**
 * `IdeaText → idea id`, so the decorator can name the pair it is re-sampling: at the `SparkAdjudicator`
 * seam the provider sees **only** the operation's payload (§5 — no ids, no vault listing), so a pair is
 * named by the text it was called with. `engine/mechanism.ts` `readIdeaText` reads exactly
 * `hypothesis`/`problem`/`monetization`, and `main` seeds the db from this same vault before any pass
 * runs, so the lookup is exact. Two ideas carrying identical text **fail closed** rather than let a
 * `failed` key point at the wrong pair.
 */
function ideaIdByText(ideas: readonly W9Idea[]): (text: IdeaText) => string {
  const idByText = new Map<string, string>();
  for (const idea of ideas) {
    const text = JSON.stringify(ideaTextOf(idea));
    const held = idByText.get(text);
    if (held !== undefined) {
      throw new Error(
        `p2: ideas ${held} and ${idea.id} carry identical text — a pair key would be ambiguous`,
      );
    }
    idByText.set(text, idea.id);
  }
  return (text) => {
    const id = idByText.get(JSON.stringify(text));
    if (id === undefined) {
      throw new Error(
        "p2: an adjudicated pair's idea text is not in the vault — the pair cannot be named",
      );
    }
    return id;
  };
}

/** The engine's canonical pair key (`gate.ts` D6): `[aId, bId].sort().join("|")`. */
function pairKeyOf(idA: string, idB: string): string {
  return [idA, idB].sort().join("|");
}

/**
 * The artifact's three classes, derived from the decorator's journal and **checked against the engine's
 * own output** before anything is written (David/Max, #34). `rejected` loses every exhausted key — the
 * engine had to classify them as `null` to stay alive — and the checks make the third class *verifiable*
 * rather than merely present:
 *
 * - **(1)** `union ≤ attempts ≤ 3 × union` — cheap backstop; ≥1 and ≤3 calls per pair hold by construction,
 *   so it is close to vacuous. Do not read it as evidence.
 * - **(2)** `|confirmed| + |rejected| + |failed| = union` — the only guard here that catches a D4 skip
 *   (a pair whose idea row vanished gets no call, no output, and the sum drops below the union).
 * - **(3)** every class ⊆ the union and pairwise disjoint, so no key is counted twice.
 * - **(3a) the load-bearing check: the engine's own output must agree with the journal** (`E` = the
 *   journal's exhausted keys). `failed` is *derived* from `E`, so `set(failed) == set(E)` holds by
 *   construction and proves nothing on its own —
 *   the discrimination is the join: `engineRejected == E ∪ refusals`, `engineConfirmed == drafts`, and the
 *   artifact's `rejected == refusals`. **Set equality, not disjointness**: disjointness alone still passes
 *   when an exhausted pair is silently absorbed as a suppression (leaving `failed` empty), which is
 *   exactly what the third class exists to expose. Planted-violation evidence, both caught: leaving
 *   `rejected` un-filtered, and skipping the re-classification entirely.
 * - **(3b)** the corollary: no failed key survives in `rejected` or in `confirmed`.
 */
function adjudicationClasses(input: {
  union: readonly CalibrationPair[];
  engineConfirmed: readonly string[];
  engineRejected: readonly string[];
  journal: AdjudicationJournal;
}): { confirmed: readonly string[]; rejected: string[]; failed: string[] } {
  const unionKeys = new Set(input.union.map((pair) => pair.key));
  const exhausted = new Set(input.journal.exhausted);
  const refusals = new Set(input.journal.refusals);
  const drafts = new Set(input.journal.drafts);
  const engineConfirmed = new Set(input.engineConfirmed);
  const engineRejected = new Set(input.engineRejected);
  const failed = [...exhausted].sort();
  const rejected = input.engineRejected.filter((key) => !exhausted.has(key));

  const problems: string[] = [];
  const expect = (holds: boolean, message: string): void => {
    if (!holds) problems.push(message);
  };

  const { attempts } = input.journal;
  expect(
    attempts >= input.union.length && attempts <= ADJUDICATION_ATTEMPTS * input.union.length,
    `(1) attempts ${attempts} outside [${input.union.length}, ${ADJUDICATION_ATTEMPTS * input.union.length}]`,
  );

  const classes = [...exhausted, ...refusals, ...drafts];
  expect(
    exhausted.size + refusals.size + drafts.size === classes.length,
    "(3) a pair is in two classes",
  );
  for (const key of classes)
    expect(unionKeys.has(key), `(3) ${key} is classified but is not in the union`);
  for (const key of exhausted) {
    expect(engineRejected.has(key), `(3a) exhausted ${key} never reached the engine's rejected`);
    expect(!engineConfirmed.has(key), `(3b) exhausted ${key} is in the engine's confirmed`);
  }
  for (const key of refusals)
    expect(engineRejected.has(key), `(3a) refusing ${key} is absent from rejected`);
  for (const key of drafts)
    expect(engineConfirmed.has(key), `(3a) drafting ${key} is absent from confirmed`);
  expect(
    engineRejected.size === exhausted.size + refusals.size,
    "(3a) engine rejected ≠ exhausted ∪ refusals",
  );
  expect(engineConfirmed.size === drafts.size, "(3a) engine confirmed ≠ drafts");
  expect(new Set(rejected).size === rejected.length, "(3a) a key appears twice in rejected");
  // (3a), the half that pins *which*: `rejected` must be exactly the pairs the decorator saw refuse. A
  // bare disjointness check passes when an exhausted pair is silently left in `rejected` — and when
  // `failed` is never populated at all — so that absorption is checked here, never inferred.
  expect(
    rejected.length === refusals.size && rejected.every((key) => refusals.has(key)),
    "(3a) rejected ≠ the pairs the decorator saw refuse — an exhausted pair was absorbed as a suppression",
  );
  expect(
    input.engineConfirmed.length + rejected.length + failed.length === input.union.length,
    `(2) confirmed ${input.engineConfirmed.length} + rejected ${rejected.length} + failed ${failed.length}` +
      ` ≠ union ${input.union.length}`,
  );

  if (problems.length > 0) {
    throw new Error(
      `p2: the adjudication partition is not sound — ${problems.join("; ")}. Refusing to write it.`,
    );
  }
  return { confirmed: input.engineConfirmed, rejected, failed };
}

/** The pinned model's published price, read from OpenRouter `/models` (2026-10-14): $ per 1M tokens. */
const PRICE_PER_M_PROMPT = 0.091;
const PRICE_PER_M_COMPLETION = 0.182;
/** Token estimate: chars ÷ 4 — DeepSeek's tokenizer is not local, so the posting labels this an estimate. */
const CHARS_PER_TOKEN = 4;
/** A per-call completion ceiling for the five-field adjudication schema. An upper bound, not a measurement. */
const COMPLETION_TOKENS_PER_CALL = 200;

/** One P2 call's prompt, exactly as the adapter builds it: `ADJUDICATION_SYSTEM` + `adjudicationUser`. */
function p2PromptChars(
  ideaA: IdeaText,
  ideaB: IdeaText,
  a: MechanismDescriptor,
  b: MechanismDescriptor,
): number {
  return ADJUDICATION_SYSTEM.length + adjudicationUser(ideaA, ideaB, { a, b }).length;
}

/**
 * The below-0.35 posting's cost basis (bar §5): the measured prompt size over the union pairs, the
 * completion ceiling under the hard cap `M_wide`, and the two multiplied by the pinned model's price.
 * `0` calls — it reads the vault and the cached descriptors, nothing more.
 */
function adjudicationCost(
  db: SqliteConnection,
  ideas: readonly W9Idea[],
  union: readonly CalibrationPair[],
) {
  const textById = new Map(ideas.map((idea) => [idea.id, ideaTextOf(idea)]));
  const descriptorById = new Map(
    readDescriptors(
      db,
      ideas.map((idea) => idea.id),
    ).map((row) => [row.idea_id, JSON.parse(row.descriptor) as MechanismDescriptor]),
  );

  let promptChars = 0;
  for (const pair of union) {
    const a = textById.get(pair.aId);
    const b = textById.get(pair.bId);
    const ma = descriptorById.get(pair.aId);
    const mb = descriptorById.get(pair.bId);
    if (a === undefined || b === undefined || ma === undefined || mb === undefined) {
      throw new Error(`widen: missing text or descriptor for pair ${pair.key}`);
    }
    promptChars += p2PromptChars(a, b, ma, mb);
  }

  const promptTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
  const completionCeilingTokens = union.length * COMPLETION_TOKENS_PER_CALL;
  const promptCost = (promptTokens * PRICE_PER_M_PROMPT) / 1_000_000;
  const completionCeiling = (completionCeilingTokens * PRICE_PER_M_COMPLETION) / 1_000_000;
  return {
    pricePerMTokens: { prompt: PRICE_PER_M_PROMPT, completion: PRICE_PER_M_COMPLETION },
    charsPerToken: CHARS_PER_TOKEN,
    completionTokensPerCallCeiling: COMPLETION_TOKENS_PER_CALL,
    promptChars,
    meanPromptChars: union.length === 0 ? 0 : promptChars / union.length,
    promptTokens,
    completionCeilingTokens,
    promptCost,
    completionCeiling,
    ceiling: promptCost + completionCeiling,
  };
}

/** §3.3 step 2's four descriptor fields — `alignment.ts`'s own list, named once here. */
const DESCRIPTOR_FIELDS = ["verb", "object_class", "constraint", "transferable_structure"] as const;

/** One descriptor with three fields blanked, so `descriptorSimilarity` leaves a single per-field term. */
function maskedField(
  descriptor: MechanismDescriptor,
  field: (typeof DESCRIPTOR_FIELDS)[number],
): MechanismDescriptor {
  return {
    verb: field === "verb" ? descriptor.verb : "",
    object_class: field === "object_class" ? descriptor.object_class : "",
    constraint: field === "constraint" ? descriptor.constraint : "",
    transferable_structure:
      field === "transferable_structure" ? descriptor.transferable_structure : "",
  };
}

/**
 * The 28 descriptors, raw (David/Max, #34): step 4's arithmetic was validated against the *summary*
 * (the posted per-field table), not the source, because the descriptors lived only in the gitignored
 * `data/` cache. These are the rows `matrix()` reads — plus `source_hash`, which ties each to the
 * vault text — so the alignment column is recomputable from the artifact alone.
 */
function descriptorRows(db: SqliteConnection, ideas: readonly W9Idea[]) {
  return readDescriptors(
    db,
    ideas.map((idea) => idea.id),
  ).map((row) => ({
    ideaId: row.idea_id,
    sourceHash: row.source_hash,
    descriptor: JSON.parse(row.descriptor) as MechanismDescriptor,
  }));
}

/**
 * The four per-field Jaccard terms behind each union pair's `alignment`, read through the engine's own
 * public `descriptorSimilarity` — so this file ships **no second copy of the metric**. That function is
 * the uniform mean of the four terms, and a blank field tokenises to the empty set with `both-empty ⇒ 0`
 * (`engine/alignment.ts`), so masking three fields leaves one: `sim(mask_F(a), mask_F(b)) = jac(F) / 4`.
 * The four terms must then mean back to the recorded `alignment` exactly; a drift fails the write rather
 * than shipping a second opinion about the metric (W5 D1).
 */
function perFieldTable(
  union: readonly CalibrationPair[],
  descriptorOf: ReadonlyMap<string, MechanismDescriptor>,
) {
  return union.map((pair) => {
    const a = descriptorOf.get(pair.aId);
    const b = descriptorOf.get(pair.bId);
    if (a === undefined || b === undefined) {
      throw new Error(
        `p2: no descriptor for pair ${pair.key} — the step-4 evidence cannot be built`,
      );
    }
    const perField = Object.fromEntries(
      DESCRIPTOR_FIELDS.map((field) => [
        field,
        4 * descriptorSimilarity(maskedField(a, field), maskedField(b, field)),
      ]),
    ) as Record<(typeof DESCRIPTOR_FIELDS)[number], number>;
    const mean =
      DESCRIPTOR_FIELDS.reduce((total, field) => total + perField[field], 0) /
      DESCRIPTOR_FIELDS.length;
    if (Math.abs(mean - pair.alignment) > 1e-12) {
      throw new Error(
        `p2: per-field mean ${mean} ≠ recorded alignment ${pair.alignment} for ${pair.key} — the metric ` +
          "moved out from under this table; refusing to write a second opinion (W5 D1)",
      );
    }
    return { key: pair.key, alignment: pair.alignment, ...perField };
  });
}

/**
 * One confirmed pair's two vault ideas — the sources G4's *"traceable to both sources"* is read against.
 * They ride in the artifact so the blind scoring sheet is a pure `jq` transform of the attached bytes
 * (David, #34 step 3) — a sheet the reviewer can build without this workspace or the gitignored cache.
 */
function sourcesOf(
  byId: ReadonlyMap<string, W9Idea>,
  spark: { aId: string; bId: string },
): { a: W9Idea; b: W9Idea } {
  const a = byId.get(spark.aId);
  const b = byId.get(spark.bId);
  if (a === undefined || b === undefined) {
    throw new Error(`p2: spark ${spark.aId}|${spark.bId} names an idea that is not in the vault`);
  }
  return { a, b };
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  const ideas = loadVault();
  const db = openNodeStore(DB_PATH);
  bootVault(db);
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
    const floor = readFloor(argv);
    const cached = cachedCount(db, ideas);
    if (cached < ideas.length) {
      throw new Error(
        `report: ${cached}/${ideas.length} descriptors cached — refusing, because the matrix would ` +
          "extract on a cold cache (28 calls). Run `p1` first.",
      );
    }
    const run = runFor(db, noProvider, floor);
    const pairs = await run.union();
    const artifact = {
      floor,
      union: pairs.length,
      pairs,
      extractCalls: run.extractCalls,
      adjudicateCalls: run.adjudicateCalls,
    };
    writeArtifact("union.json", artifact);
    process.stdout.write(
      `${JSON.stringify({ floor, union: pairs.length, extractCalls: run.extractCalls }, null, 2)}\n`,
    );
    return;
  }

  if (command === "widen") {
    const floor = readFloor(argv);
    const cached = cachedCount(db, ideas);
    if (cached < ideas.length) {
      throw new Error(
        `widen: ${cached}/${ideas.length} descriptors cached — refusing, because the matrix would ` +
          `extract on a cold cache (${ideas.length} calls). Run \`p1\` first.`,
      );
    }
    // 0 calls: the full matrix and the union are the gate's local read over cached descriptors.
    const run = runFor(db, noProvider, floor);
    const matrix = await run.matrix();
    const union = await run.union();
    const artifact = {
      floor,
      mWide: union.length,
      taus: [...W9_WIDE_TAUS],
      // Free per-τ counts — the sweep is a pure filter over the (already computed) matrix.
      perTau: W9_WIDE_TAUS.map((tau) => ({
        tau,
        pairsAtOrAbove: matrix.filter((pair) => pair.alignment >= tau).length,
      })),
      matrix,
      extractCalls: run.extractCalls,
      adjudicateCalls: run.adjudicateCalls,
      cost: adjudicationCost(db, ideas, union),
    };
    writeArtifact("widen-posting.json", artifact);
    process.stdout.write(
      `${JSON.stringify(
        {
          floor: artifact.floor,
          mWide: artifact.mWide,
          taus: artifact.taus,
          perTau: artifact.perTau,
          extractCalls: artifact.extractCalls,
          cost: artifact.cost,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (command === "p1") {
    const posting = p1Posting(ideas);
    requireConfirm("p1", readConfirm(argv), posting.promptChars);
    requireLive("p1");
    const run = runFor(db, liveAdapter());
    await run.extract();
    const artifact = { posting, extractCalls: run.extractCalls };
    writeArtifact("p1-actuals.json", artifact);
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
    return;
  }

  if (command === "p2") {
    const floor = readFloor(argv);
    const cached = cachedCount(db, ideas);
    if (cached < ideas.length) {
      throw new Error(`p2: ${cached}/${ideas.length} descriptors cached — run \`p1\` first.`);
    }
    // The union is deterministic from the descriptors and must be provably **0 calls**, so it runs on
    // the throwing stub — never the live adapter. A row whose `source_hash` no longer matches (vault
    // text, `EXTRACTOR_VERSION`, or `AI_MODEL` moved since P1) then fails closed *here*, before either
    // key is checked, instead of firing a live extraction per stale idea: `cachedCount` counts rows, not
    // valid rows, so it cannot stand in for this (Max, #102).
    const dry = runFor(db, noProvider, floor);
    const union = await dry.union().catch((error: unknown): never => {
      throw new Error(
        "p2: refusing — the descriptor cache is not warm (a stale row would extract on the live " +
          `adapter). Re-run \`p1\`. [${error instanceof Error ? error.message : String(error)}]`,
      );
    });

    requireConfirm("p2", readConfirm(argv), union.length);
    requireLive("p2");

    // Only the ratified spend gets the adapter, and only after both keys passed. The union pass above
    // proved every descriptor is cached, so this pass fires adjudication calls — and no extraction.
    // The retry decorator wraps the live adapter *here*, after both key checks (David's ruling A; #34).
    const idOfText = ideaIdByText(ideas);
    const retry = withAdjudicationRetry(liveAdapter(), (ideaA, ideaB) =>
      pairKeyOf(idOfText(ideaA), idOfText(ideaB)),
    );
    const run = runFor(db, retry.provider, floor);
    const adjudication = await run.adjudicate();
    if (run.extractCalls !== 0) {
      throw new Error(`p2: ${run.extractCalls} extraction calls during adjudication — expected 0`);
    }
    // Equality, not `>`: `createAdjudicator` fires exactly one call per gated pair (`engine/adjudicate.ts`),
    // so the live spend must *equal* the dry union — and `!==` catches the silent under-spend (`union: 67`
    // over `adjudicateCalls: 0`) that `>` cannot. Exact *here* for a stated reason: every pair's two idea
    // rows are live across `extract → matrix → union → adjudicate` in one process, so D4's `continue` (no
    // call when an idea row is gone) is unreachable. A fixture that could leave a pair with a missing row
    // needs `<= union.length` plus a recorded expected count, **not** blind equality (Max/David, #34).
    if (run.adjudicateCalls !== union.length) {
      const direction =
        run.adjudicateCalls > union.length
          ? "over-spend: the cap was exceeded"
          : "under-spend: the floor likely reached only the dry pass";
      throw new Error(
        `p2: ${run.adjudicateCalls} adjudication calls for a union of ${union.length} — expected exactly ` +
          `${union.length}, one per gated pair (${direction}).`,
      );
    }
    // The third class (David's ruling A; #34): `rejected` loses every key the decorator exhausted, and the
    // partition is checked against the engine's own output — a failed key can never survive as a
    // suppression, and the write fails if the re-classification did not actually happen.
    const classes = adjudicationClasses({
      union,
      engineConfirmed: adjudication.confirmed.map((spark) => spark.key),
      engineRejected: adjudication.rejected.map((pair) => pair.key),
      journal: retry.journal,
    });
    // Additive (David/Max, #34): the four counts and the two key arrays above are unchanged — `rejected`
    // now excludes the `failed` keys; the draft the run used to drop into a local variable, the raw
    // descriptors, and the per-field terms now travel with the artifact. `confirmedSparks` is the input
    // G3/G4/G5 need (the sources ride along so the blind sheet is a pure `jq` transform of these bytes);
    // `descriptors` + `perFieldJaccard` make step 4 re-runnable from the artifact alone, not from the
    // gitignored `data/` cache. `failed`/`attempts`/`retried` are the retry lane: the count that proves
    // the repair worked, the calls it took, and which pairs were re-sampled.
    const descriptors = descriptorRows(db, ideas);
    const descriptorOf = new Map(descriptors.map((row) => [row.ideaId, row.descriptor]));
    const ideasById = new Map(ideas.map((idea) => [idea.id, idea]));
    const artifact = {
      floor,
      union: union.length,
      // The dry pass's extraction count — the P2 posting cites this, and it must read 0 (Max/David, #102).
      unionExtractCalls: dry.extractCalls,
      adjudicateCalls: run.adjudicateCalls,
      extractCalls: run.extractCalls,
      confirmed: classes.confirmed,
      rejected: classes.rejected,
      failed: classes.failed,
      attempts: retry.journal.attempts,
      retried: retry.journal.retried,
      confirmedSparks: adjudication.confirmed.map((spark) => ({
        key: spark.key,
        aId: spark.aId,
        bId: spark.bId,
        distance: spark.distance,
        alignment: spark.alignment,
        draft: spark.draft,
        sources: sourcesOf(ideasById, spark),
      })),
      descriptors,
      perFieldJaccard: perFieldTable(union, descriptorOf),
    };
    writeArtifact("p2-actuals.json", artifact);
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
    return;
  }

  throw new Error(
    `unknown command ${JSON.stringify(command ?? "")} — expected post | p1 | p2 | report | widen`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
