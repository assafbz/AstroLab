import type { DatabaseSync } from "node:sqlite";

import { readGateConfig, type GateConfig } from "@astrolab/store";

import type { MechanismDescriptor } from "../provider/index.js";
import type { VaultCut } from "../queue.js";
import { descriptorSimilarity } from "./alignment.js";
import type { DomainDistance } from "./domain.js";
import type { MechanismCache } from "./mechanism.js";

/**
 * The gate — Axis 2's cheap, local filter (`ARCHITECTURE.md` §3.1, §3.3 step 2). For a `VaultCut` it
 * materialises each idea's descriptor **once** and each idea's tag-set **once**, then runs the **pure**
 * pairwise loop comparing every pair against **both** thresholds. A pair is *offered* only when it
 * clears both. Nothing is written, nothing is adjudicated (W6), nothing is suppressed (W7).
 *
 * ## The seam
 *
 * This is a **socket**: W6's adjudicator consumes `gatedPairs`, W8's run body calls this. Like W3's
 * cache and W4's distance, it ships unwired — `worker/src/queue.ts`'s default body stays `stubRunBody`
 * — so no unruled surface reaches `main`.
 *
 * ## What a "pair" is (D6)
 *
 * `key = [aId, bId].sort().join("|")` — the same canonical key `spark` / `suppressed_pair` use
 * (§2.3), so W8 stores it without re-deriving it and a re-run at one revision yields a byte-identical
 * list. The result is **sorted by `key`**; the pairwise loop's order is irrelevant to it.
 *
 * ## The comparator is W4's pinned predicate (D2)
 *
 * `distance === null || distance >= minDomainDistance` for the distance axis, `alignment >=
 * minAlignment` for the alignment axis, and a pair is gated iff **both** hold. `null` (W4: *"no path
 * among the shipped hops"*) reads as **farthest**, never `Number(distance)`: coercing `null → 0` would
 * read an unconnected pair as same-domain → cliché → silently dropped.
 *
 * ## Cost posture (§3.1, D4)
 *
 * Extraction is O(N) and is **not** the scan. The pairwise loop calls neither the extractor, the
 * adjudicator, nor (once a tag has been seen) the normaliser — the scan makes **no AI calls**. The one
 * AI touch inside `between` is W4's, paid once per **distinct tag**, outside the comparison. `gate.test.ts`
 * asserts the count in call-count terms, independently of pair count.
 *
 * ## Two deliberate properties
 *
 * - **The distance axis runs on clusters post-normalisation (Q2, accepted).** By gate time W4 has
 *   already normalised any provisional tag, so `between` sees clusters, not raw tags. That is intended
 *   behaviour, not an artifact: the distance axis measures *domain*, and a raw tag has none until
 *   resolved.
 * - **No write.** The gate reads `idea` (as `cutVault` does) and writes nothing — no `spark`, no
 *   `suppressed_pair`, no revision bump. Recording an outcome is W7/W8.
 */

/** One offered pair, with the evidence that cleared it — W6 adjudicates, W8 stores. */
export interface GatedPair {
  /** `[aId, bId].sort().join("|")` (D6). */
  key: string;
  aId: string;
  bId: string;
  a: MechanismDescriptor;
  b: MechanismDescriptor;
  /** W4's `between()`; `null` = no listed path (far), which the comparator reads as distant. */
  distance: number | null;
  /** `descriptorSimilarity()`, `[0,1]`. */
  alignment: number;
}

export interface Gate {
  /** Deterministic, `pair_key`-sorted, AI-free over the pairwise loop (D4/D6). */
  gatedPairs(cut: VaultCut): Promise<GatedPair[]>;
}

/**
 * The candidate set, in the cut's `id ASC` order: `ACTIVE` ideas carrying at least one domain tag
 * (§3.5 excludes `NEEDS_COMPLETION` and domain-less ideas from candidate generation). One `SELECT`.
 */
function candidates(db: DatabaseSync, cut: VaultCut): Array<{ id: string; tags: string[] }> {
  if (cut.ideaIds.length === 0) return [];
  const placeholders = cut.ideaIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, domain_tags FROM idea
       WHERE id IN (${placeholders}) AND status = 'ACTIVE'
       ORDER BY id ASC`,
    )
    .all(...cut.ideaIds) as Array<{ id: string; domain_tags: string }>;
  return rows
    .map((row) => ({ id: row.id, tags: JSON.parse(row.domain_tags) as unknown }))
    .filter(
      (row): row is { id: string; tags: string[] } => Array.isArray(row.tags) && row.tags.length > 0,
    );
}

export function createGate(
  db: DatabaseSync,
  mechanisms: MechanismCache,
  distance: DomainDistance,
  config?: GateConfig,
): Gate {
  return {
    async gatedPairs(cut) {
      const limits = config ?? readGateConfig(db);

      // Stage 1, materialised once per candidate — O(N), and not part of the scan (§3.1).
      const materialised: Array<{ id: string; descriptor: MechanismDescriptor; tags: string[] }> = [];
      for (const candidate of candidates(db, cut)) {
        const descriptor = await mechanisms.descriptorFor(candidate.id);
        if (descriptor === null) continue; // deleted between the cut and now
        materialised.push({ id: candidate.id, descriptor, tags: candidate.tags });
      }

      const pairs: GatedPair[] = [];
      for (let i = 0; i < materialised.length; i++) {
        for (let j = i + 1; j < materialised.length; j++) {
          const a = materialised[i];
          const b = materialised[j];
          const gap = await distance.between(a.tags, b.tags);
          const alignment = descriptorSimilarity(a.descriptor, b.descriptor);
          // D2: `null` is farthest, never 0; both axes must clear.
          const passesDistance = gap === null || gap >= limits.minDomainDistance;
          if (!passesDistance || alignment < limits.minAlignment) continue;
          const [first, second] = [a.id, b.id].sort();
          pairs.push({
            key: `${first}|${second}`,
            aId: a.id,
            bId: b.id,
            a: a.descriptor,
            b: b.descriptor,
            distance: gap,
            alignment,
          });
        }
      }

      return pairs.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    },
  };
}
