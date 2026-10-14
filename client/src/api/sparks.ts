import { apiRequest } from "./client.ts";
import type { RunAccepted } from "./types.ts";

/**
 * `POST /v1/sparks/run` (`docs/API.md` §4.16) — enqueue a run (the cold-start trigger, O5 `#25`).
 *
 * **No body, and none is sent.** §4.16 reads none and a body is ignored, not validated — so the request
 * carries only the bearer/envelope path `apiRequest` already owns. The call is **fire-and-forget** from
 * the caller's side (NFR-P1): it resolves to the accepted run, but nobody waits on the engine to leave
 * S0 — `202` means *enqueued*, not *done* (`→ E1`). Governance (idempotency per revision, stale-run
 * discard) is the server's; the client states no invariant of its own (`docs/API.md` §0).
 */
export function enqueueRun(): Promise<RunAccepted> {
  return apiRequest<RunAccepted>("/v1/sparks/run", { method: "POST" });
}
