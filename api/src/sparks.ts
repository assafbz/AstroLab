import type { DatabaseSync } from "node:sqlite";

import { liveOffers } from "@astrolab/store";

import { ValidationError } from "./capture.js";

/**
 * The deck read — `GET /v1/sparks?state=offered` (`docs/API.md` §4.9, §3.3; K1 `#35`).
 *
 * Two properties hold here and are tested, not assumed:
 * - **`state` is mandatory, and `offered` is its only value.** A `Spark` carries no `status` field
 *   (§3.3), so a read with "no restriction" is indistinguishable from an offers read — it would hand a
 *   caller resolved sparks with nothing marking them. §4.9 therefore departs from §4.4's *absent filter
 *   = no restriction*, and the reason is recorded there rather than left to the implementation.
 * - **Server order is deck order**, and the store read owns it: oldest offer first.
 *
 * The row itself is the store's (`liveOffers`, `store/src/sparks.ts`) because the live-offer predicate
 * is one definition there. This module adds only the query's vocabulary and §3.3's projection name —
 * the internals are never selected, so nothing here can surface them.
 */

/** docs/API.md §3.3 — the deck card. No `status`, no scores, no source idea ids. */
export interface Spark {
  id: string;
  direction: string;
  claim: string;
  domain_tags: string[];
  created_at: string;
}

/** §4.9's enum — the only value `state` may take. */
export type SparkState = "offered";

/** §4.9's query. `state` is required, so this is never "no restriction" — it is `offered`, or a `422`. */
export interface SparkQuery {
  state: SparkState;
}

/**
 * `docs/API.md` §4.9 + §1. A missing or empty `state`, or one outside the enum, is
 * `422 validation_failed`: §2's "mandatory field missing" and §1's "unknown enum value" are the same
 * status for two reasons, and the comparison is **case-sensitive** — `?state=OFFERED` is not `offered`.
 * A repeated key takes its first occurrence (§1's rule for every query parameter).
 */
export function parseSparkQuery(query: URLSearchParams): SparkQuery {
  const state = query.get("state");
  if (state === null || state === "") {
    throw new ValidationError("state is required and must be 'offered'");
  }
  if (state !== "offered") {
    throw new ValidationError("state must be 'offered'");
  }
  return { state };
}

/**
 * §4.9's `{ "sparks": [Spark, …] }`, in server order. The order and the projection are the store
 * read's; this is the contract's name for them.
 */
export function listOfferedSparks(db: DatabaseSync): Spark[] {
  return liveOffers(db);
}
