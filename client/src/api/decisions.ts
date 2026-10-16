import type { ResolutionKind } from "../domain/deck-interaction.ts";

import { apiRequest } from "./client.ts";
import type { Decision } from "./types.ts";

/**
 * `POST /v1/sparks/{id}/decision` (`docs/API.md` §4.13) — the one resolving write.
 *
 * The deck's Good / Not for me and S1b's the same reach this through **one** call; what the decision
 * *means* is the server's (`api/src/decision.ts`, K4 `#38`), and what makes the call safe to repeat is
 * the client's `decision_id` (`FLOW.md` §2.2, §4.13's idempotency), which the caller owns — this module
 * passes the id it is given and never mints one. Pure transport: no React, no state, no retry policy.
 *
 * ## The route's width (`ResolutionKind` is three, §4.13 takes two)
 *
 * `kind` is typed by the seam's own `ResolutionKind` (`domain/deck-interaction.ts`) so there is one
 * definition and a later slice cannot widen one site past the other. §4.13's body accepts only
 * `ACCEPT`/`DISMISS`, so the **narrowing** happens here, once, at the last point before the wire —
 * every caller may hand the seam's kind through unchanged and still be unable to post an `INSPIRED`.
 */

/**
 * §4.13's two kinds — `ResolutionKind` minus the one that is not a resolution. Exported so a caller can
 * name the set the route accepts without re-deriving it.
 */
export type RouteKind = Exclude<ResolutionKind, "INSPIRED">;

/**
 * Resolve one spark, or post nothing — §4.13.
 *
 * **`INSPIRED` posts nothing and resolves `null`.** It is §4.14's *seeded capture*, not a resolution:
 * it opens S2 prefilled, writes **no** `decision` row, and the spark stays `OFFERED` until a seeded
 * save commits. A POST here would be a decision the server does not model, so the arm is a no-op rather
 * than a narrowed request — and the seeded capture's client half is #119's, not this module's.
 *
 * Anything the server refuses arrives as the §2 envelope (`ApiError`, K4's check order pinned in
 * `api/src/server.test.ts`): an unknown spark is `not_found`, an already-resolved one or a
 * `decision_id` recorded for another spark is `conflict`. This module does not classify them — a retry
 * and a `409`'s "re-read instead" are the caller's (`domain/decision.ts`, S2).
 */
export function postDecision(
  sparkId: string,
  decisionId: string,
  kind: ResolutionKind,
): Promise<Decision | null> {
  if (kind === "INSPIRED") return Promise.resolve(null);
  // The id is the client's, so it is sent as given, never generated here (§2.2: *"must not regenerate
  // it"* — regenerating is the idempotency break the server's hoisted repeat exists to survive).
  return apiRequest<Decision>(`/v1/sparks/${encodeURIComponent(sparkId)}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision_id: decisionId, kind }),
  });
}
