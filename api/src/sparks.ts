import type { DatabaseSync } from "node:sqlite";

import { liveOffers, sparkById } from "@astrolab/store";

import { ValidationError } from "./capture.js";

/**
 * The spark reads — the deck (`GET /v1/sparks?state=offered`, §4.9/§3.3; K1 `#35`) and the by-id
 * detail (`GET /v1/sparks/{id}`, §4.12/§3.4; #118).
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
  /** The card's third element (`DESIGN.md` §4/§9; #115) — `null` on a legacy row, rendered absent. */
  first_step: string | null;
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

/**
 * `docs/API.md` §3.4 — the S1b expanded view: `Spark` plus **only** `what_it_takes` (`#118`).
 *
 * `first_step` sits on `Spark` itself (§3.3, #115), so the detail's whole delta is the one field that
 * stays off the card by design. No scores, no similarity readout (`ARCHITECTURE.md` §6).
 */
export interface SparkDetail extends Spark {
  /** What the idea would take to build. `null` only on a legacy row — rendered as simply absent. */
  what_it_takes: string | null;
}

/**
 * `docs/API.md` §4.12, or `null` for an unknown id — the caller answers the `not_found` envelope.
 *
 * **Status-blind by id.** The by-id read (`sparkById`) carries no `status` filter, and must not: a
 * spark the user resolved mid-session must still answer when they tap back to it, and only an
 * *unknown* id is absent. `Spark`/`SparkDetail` carry no `status` (§3.3/§3.4), so the resolution never
 * surfaces. It is the deliberate opposite of §4.9's offered-only list: there a `Spark` has no `status`
 * to mark a resolved row, so the filter is the only thing keeping it off the deck; here the id **is**
 * the filter, so no ambiguity exists. The store read owns the projection and the join.
 */
export function sparkDetail(db: DatabaseSync, id: string): SparkDetail | null {
  return sparkById(db, id);
}
