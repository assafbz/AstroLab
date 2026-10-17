import type { SqliteConnection } from "../store/connection.js";

import { sparkDetail } from "./sparks.js";

/**
 * INSPIRE — `POST /v1/sparks/{id}/inspire` (`docs/API.md` §4.14; `FLOW.md` §2.2 / §4.3; K5 `#39`).
 *
 * The S2 seed: the payload Capture prefills from when the user picks *Use as inspiration*. It is a
 * **read**, and the one thing this route must not do is resolve anything. The spark stays `OFFERED`
 * while Capture is open; it becomes `RESOLVED-INSPIRED` only when a **seeded save** commits
 * (`core/src/vault/capture.ts`, §4.2). Abandoning Capture leaves the spark `OFFERED` (`FLOW.md` §4.3 / B).
 *
 * So there is no `vaultMutation`, no stamp and no run here — exactly as at §4.9/§4.12 — and no
 * provider, so the seed answers with the engine down (NFR-A1).
 *
 * The projection is §4.12's by-id read (`sparkDetail`) under the payload's own key names: §3.4's
 * fields, minus `created_at`, with `id` presented as `spark_id` (the client keys the seed by the
 * spark it came from). It is **status-blind** for §4.12's reason and not §4.9's: the `{id}` *is* the
 * filter, so no `status` filter is needed — and no `status` is in the payload, so a spark's
 * resolution never surfaces here.
 */

/** docs/API.md §4.14 — the seed payload Capture prefills from. */
export interface InspireSeed {
  spark_id: string;
  direction: string;
  claim: string;
  /**
   * What the idea would take to build. `null` only on a legacy row — **absent, not `""`** (§3.4's
   * rule; the #115 treatment for `first_step`), so a client renders nothing rather than an empty block.
   */
  what_it_takes: string | null;
  /** The card's third element (§3.3). `null` only on a legacy row, rendered as simply absent. */
  first_step: string | null;
  /** The two source ideas' tags, pair order, deduped (§3.3) — the store read folds them exactly once. */
  domain_tags: string[];
}

/**
 * `docs/API.md` §4.14's seed payload, or `null` for an unknown id — the caller answers the `not_found`
 * envelope. Reads nothing else and writes nothing: INSPIRE is not a resolution.
 */
export function inspireSeed(db: SqliteConnection, id: string): InspireSeed | null {
  const spark = sparkDetail(db, id);
  if (spark === null) return null;
  return {
    spark_id: spark.id,
    direction: spark.direction,
    claim: spark.claim,
    what_it_takes: spark.what_it_takes,
    first_step: spark.first_step,
    domain_tags: spark.domain_tags,
  };
}
