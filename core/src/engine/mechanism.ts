import { createHash } from "node:crypto";
import type { SqliteConnection } from "../store/connection.js";

import { readDescriptors, upsertDescriptor } from "../store/index.js";

import { DESCRIPTOR_SCHEMA, EXTRACTION_SYSTEM } from "../provider/index.js";
import type { IdeaText, MechanismDescriptor, MechanismExtractor } from "../provider/index.js";

/**
 * Stage 1 of the engine — mechanism extraction and its cache (`ARCHITECTURE.md` §3.3 step 1; §2.3
 * `idea_mechanism`; `ADR-0002`).
 *
 * One descriptor per idea, keyed by `idea_id`. Extraction is the **one AI call per idea** (§3.1) and
 * it is re-run **only when the descriptor's inputs change** — the idea's text, the extraction contract,
 * or the model: `source_hash` is a hash of exactly those, so a hit serves the cache and a miss
 * extracts (§2.3). The descriptor is **selection-internal**, never surfaced (§3.3 items 2–4);
 * `provider/boundary.test.ts` fails the suite if an `api/` or `client/` source names it.
 *
 * ## What the cache key covers (and why each part)
 *
 * `hashIdeaText` covers `[EXTRACTOR_VERSION, model, hypothesis, problem, monetization]`:
 *
 * - the **text** — all three fields, joined unambiguously (a JSON array, not a bare concat), so a
 *   `problem`- or `monetization`-only edit re-extracts rather than serving a stale descriptor;
 * - **`EXTRACTOR_VERSION`**, **derived** from the prompt and the descriptor field set — a W9 tuning
 *   artifact (§12 item 2) — so a change to either invalidates every cached descriptor *by
 *   construction*, not by a remembered bump;
 * - the **model** — `ADR-0003` makes the model a config value re-pointable *without a code change*, so
 *   a constant cannot track it. It is **construction data** here, resolved once at the call site that
 *   also builds the adapter (the same value handed to `createOpenRouterAdapter`), never re-derived.
 *
 * The producer is a parameter, not a default: a silently defaulted model is exactly the stale-cache
 * failure this key exists to prevent.
 *
 * ## The write path
 *
 * The persistence is `core/src/store/mechanism.ts` (`upsertDescriptor`/`readDescriptors`), not raw SQL
 * here: the API's delete path (V5 #16) must reach the same rows, and moving it into `store` is what
 * keeps that reachable without a new `api → worker` dependency. That module carries the *named
 * exception* to `vaultMutation` and its reason. A cache write that still fails **propagates** — the
 * run body throws and the run is `FAILED` (§4) — never a descriptor served uncached.
 */

/**
 * The extraction contract's identity: the prompt (`provider/prompts.ts`) and the descriptor field set
 * (`provider/schema.ts`), hashed. **Derived, never remembered** — a W9 edit (§12 item 2) to either
 * changes this value, so every cached descriptor re-extracts (§2.3 `source_hash`). A hand-bumped number
 * could not track the content that defines it: change the prompt and the only step to green would be
 * editing the version by hand (#28 review).
 */
export const EXTRACTOR_VERSION: string = createHash("sha256")
  .update(`${EXTRACTION_SYSTEM}\u0000${JSON.stringify(DESCRIPTOR_SCHEMA)}`, "utf8")
  .digest("hex");

/** What produced a descriptor: the extraction contract's identity, and the model it came from. */
export interface MechanismProducer {
  version: string;
  model: string;
}

/** Stage 1's cache, as its consumers see it (`§3.3` step 1). */
export interface MechanismCache {
  /**
   * The descriptor for an idea: the cached one when nothing in the key changed, else a fresh
   * extraction that is then cached. `null` when the idea does not exist — the run cut is a snapshot,
   * so an idea can be deleted between the cut and this call (`idea_mechanism.idea_id` is an FK to
   * `idea(id)`).
   */
  descriptorFor(ideaId: string): Promise<MechanismDescriptor | null>;
}

/**
 * The idea text the extractor sees — and the only text the cache hashes (§3.3 step 1; the payload
 * `worker/src/provider/types.ts` defines). `domain_tags` is absent: extraction is about structure, not
 * classification, so a tag edit must not invalidate the descriptor.
 */
export function readIdeaText(db: SqliteConnection, ideaId: string): IdeaText | null {
  const row = db
    .prepare("SELECT hypothesis, problem, monetization FROM idea WHERE id = ?")
    .get(ideaId) as { hypothesis: string; problem: string; monetization: string } | undefined;
  if (row === undefined) return null;
  return { hypothesis: row.hypothesis, problem: row.problem, monetization: row.monetization };
}

/** `source_hash` (`§2.3`): the descriptor's inputs, joined unambiguously — see the module docstring. */
export function hashIdeaText(text: IdeaText, producer: MechanismProducer): string {
  const payload = JSON.stringify([
    producer.version,
    producer.model,
    text.hypothesis,
    text.problem,
    text.monetization,
  ]);
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function createMechanismCache(
  db: SqliteConnection,
  extractor: MechanismExtractor,
  producer: MechanismProducer,
): MechanismCache {
  return {
    async descriptorFor(ideaId) {
      // One read, one field set: the hash and the payload sent to `extract` are the same values, so a
      // later refactor cannot hash one field set and send another.
      const text = readIdeaText(db, ideaId);
      if (text === null) return null;
      const hash = hashIdeaText(text, producer);

      const [cached] = readDescriptors(db, [ideaId]);
      // Trusted as written — the boundary validated it against the schema before it was stored, so a
      // read does not re-validate, the way `core/src/store/runs.ts` reads rows.
      if (cached !== undefined && cached.source_hash === hash) {
        return JSON.parse(cached.descriptor) as MechanismDescriptor;
      }

      const descriptor = await extractor.extract(text);
      upsertDescriptor(db, { ideaId, descriptor: JSON.stringify(descriptor), sourceHash: hash });
      return descriptor;
    },
  };
}
