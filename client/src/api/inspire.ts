import { apiRequest } from "./client.ts";
import type { InspireSeed } from "./types.ts";

/**
 * INSPIRE — `POST /v1/sparks/{id}/inspire` (`docs/API.md` §4.14) — the S2 seed the seeded Capture
 * prefills from (T09/T16). Pure transport: the request shape and the decoding, nothing more.
 *
 * **It is a read, and the one thing it must not do is resolve anything.** §4.14 writes no `decision`
 * and the spark stays `OFFERED` while Capture is open; the spark resolves only when a seeded save
 * commits (§4.2). So this module posts no resolution — there is no `decision_id` here — and the read
 * is status-blind by id, exactly as §4.12's is: a spark the user already resolved still seeds.
 *
 * **It lives here, not in `api/sparks.ts`.** §4.9/§4.10/§4.11/§4.16 are the **engine** surface, and the
 * vault screens (S2/S3/S4) must reach no engine module — their requests never wait on a run (NFR-A1,
 * the guard in `domain/deck-interaction.test.ts`). §4.14 is not engine: it is a spark read on the
 * vault's side of the split, so a separate module keeps that boundary one-way rather than widening the
 * engine surface into S2.
 */

/**
 * The seed for one spark, or §2's `not_found` envelope for an unknown id.
 *
 * **No body.** §4.14 is a POST-shaped read (`§4.16`'s posture): the route reads none and a body is
 * ignored, not validated, so the request carries only `apiRequest`'s own headers. The path is built the
 * same way §4.12's is — the id is encoded, so an opaque id addresses exactly one route.
 */
export function inspireSeed(id: string): Promise<InspireSeed> {
  return apiRequest<InspireSeed>(`/v1/sparks/${encodeURIComponent(id)}/inspire`, {
    method: "POST",
  });
}
