import type { SqliteConnection } from "../store/connection.js";

import type { IdeaText, SparkAdjudicator, SparkDraft } from "../provider/index.js";
import type { GatedPair } from "./gate.js";
import { readIdeaText } from "./mechanism.js";

/**
 * Stage 2 — adjudication (`ARCHITECTURE.md` §3.1, §3.3 step 3). The gate's `GatedPair` list in, a
 * classified `Adjudication` out: **one provider call per gated pair**, which is the whole of the stage's
 * AI cost (`O(N + gated)`, ADR-0002).
 *
 * ## The seam — this is a socket (D1)
 *
 * It **writes nothing**: no `spark`, no `suppressed_pair`, no revision bump. §3.3 step 3's *"pairs the
 * model rejects become suppressed (noise)"* names a **record**, and W7 owns that write (#32, §3.5), the
 * way W5's `gate.ts` owns none of it either. The surface reason is the W3/W4/W5 precedent — each stage
 * ships unwired behind W8's run body. The **load-bearing** reason is the run lifecycle (§4): `runOnce`
 * decides a run's disposition (claim → cut → body → currency check → finish), so an engine stage cannot
 * know whether its run is still current, and a suppression written here would sit *outside* that check —
 * a run later discarded as stale (§4/I) would have suppressed pairs it never surfaced. W8's body calls
 * this under its own currency check; W7 records.
 *
 * ## "mechanism (internal, cached)" is the draft's own field (D2)
 *
 * §3.1 marks only **Extract** cached, and §2.3's only cache table is `idea_mechanism` (Stage 1). There is
 * no adjudication cache: the shared mechanism the call confirms is `SparkDraft.mechanism`, which
 * `provider/types.ts` already defines as *"what the `spark.mechanism` column stores, so it travels with
 * the draft rather than being re-derived later"* — W8 persists it. §4/I's reproducibility is the
 * **candidate set**, which W5 already pinned; adjudication output is AI-shaped and is not claimed
 * byte-reproducible. A cache table here would be a migration, contradicting W5's ruled no-schema-change.
 *
 * ## Refusal ≠ failure (D3)
 *
 * `adjudicate` returning `null` is a **successful rejection** — the model found no shared mechanism — and
 * lands in `rejected` for W7. A `ProviderError` / `InvalidOutputError` is a **failed call**: it
 * propagates, so `runOnce` marks the run `FAILED` (§4) and nothing is stored. Conflating the two would
 * suppress a pair for the wrong reason (`provider/types.ts`). There is **no engine-level retry**: one
 * call per pair, and a retry is §4's re-enqueued run, not a loop here.
 *
 * ## Inputs the pair does not carry (D4)
 *
 * The provider compares **idea text**; a `GatedPair` carries only ids and descriptors. Text is read
 * through `mechanism.ts`'s `readIdeaText`, **once per idea** (memoised across the pairs that name it), so
 * the read stays O(N), not O(pairs). `null` means the idea was deleted after the cut — its pairs are
 * skipped: no call, no output. The delete bumped the revision, so the run is superseded anyway, and a
 * skip cannot invent a spark (`mechanism.ts` treats the same race the same way).
 *
 * ## Selection-internal (D6)
 *
 * `distance`, `alignment`, and the draft (including its `mechanism`) are internal scores §3.3 items 2–4
 * forbid surfacing; they ride along for W8 to store and are never a response. `provider/boundary.test.ts`
 * fails the suite if an `api/` or `client/` source names this module's symbols — the guard is the check,
 * this docstring is not.
 */

/** A gated pair the model confirmed — W8 stores it as an `OFFERED` spark. Scores ride along (internal). */
export interface ConfirmedSpark {
  /** === `GatedPair.key` (W5 D6): `[aId, bId].sort().join("|")`. */
  key: string;
  aId: string;
  bId: string;
  /** W5's `GatedPair.distance` — internal, never surfaced. */
  distance: number | null;
  /** W5's `GatedPair.alignment` — internal, never surfaced. */
  alignment: number;
  /** The mechanism (internal) plus `direction` / `claim` / `what_it_takes` / `first_step`. */
  draft: SparkDraft;
}

/** A gated pair the model rejected — W7 records it as `suppressed_pair` reason `NOISE`. */
export interface RejectedPair {
  key: string;
  aId: string;
  bId: string;
}

export interface Adjudication {
  confirmed: ConfirmedSpark[]; // sorted by `key`
  rejected: RejectedPair[]; // sorted by `key`
}

export interface Adjudicator {
  /** One `provider.adjudicate` call per gated pair; nothing is written (D1). */
  adjudicate(pairs: readonly GatedPair[]): Promise<Adjudication>;
}

/** W5's canonical pair order (`gate.ts`), reused so both lists sort identically. */
function byKey(a: { key: string }, b: { key: string }): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function createAdjudicator(db: SqliteConnection, provider: SparkAdjudicator): Adjudicator {
  return {
    async adjudicate(pairs) {
      const confirmed: ConfirmedSpark[] = [];
      const rejected: RejectedPair[] = [];

      // D4: the text is read once per *idea*. N gated pairs name at most 2N ids, so a memo keeps the
      // read O(ideas) instead of O(pairs); a `null` is memoised too, so a deleted idea is not re-read.
      const texts = new Map<string, IdeaText | null>();
      const textFor = (ideaId: string): IdeaText | null => {
        const memoised = texts.get(ideaId);
        if (memoised !== undefined) return memoised;
        const text = readIdeaText(db, ideaId);
        texts.set(ideaId, text);
        return text;
      };

      for (const pair of pairs) {
        const a = textFor(pair.aId);
        const b = textFor(pair.bId);
        // D4: an idea deleted between the gate and here — nothing to compare, so neither call nor output.
        if (a === null || b === null) continue;

        // Exactly one call per gated pair (D3). A throw propagates: the run is `FAILED`, nothing stored.
        const draft = await provider.adjudicate(a, b, { a: pair.a, b: pair.b });
        if (draft === null) {
          rejected.push({ key: pair.key, aId: pair.aId, bId: pair.bId });
        } else {
          confirmed.push({
            key: pair.key,
            aId: pair.aId,
            bId: pair.bId,
            distance: pair.distance,
            alignment: pair.alignment,
            draft,
          });
        }
      }

      // D5: byte-identical ordering from a byte-identical candidate set, so W7/W8 can rely on it.
      confirmed.sort(byKey);
      rejected.sort(byKey);
      return { confirmed, rejected };
    },
  };
}
