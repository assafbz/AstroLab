import type { VaultSummary } from "../types.js";

/**
 * S0's exit gate (`FLOW.md` §4.2 T04; `DESIGN.md` §9 E0) — whether S1 opens the deck or lands cold.
 *
 * **Read, not recomputed.** The gate is the server's `summary.eligible`, which
 * `api/src/vault-summary.ts` computes as `resolved_domains >= floor`. That *is* T04's "vault ≥ 2
 * distinct **resolved** domains" (the floor the payload ships): recomputing it here would make the
 * gate a second source of truth for the same boolean — the drift class #24 exists to close.
 *
 * What never enters: `provisional_domains` (a typed lane does not clear the floor until the worker
 * resolves it, `ARCHITECTURE.md` §3.2), a client-side tally (`PRD.md` §3.4 item 2's R1 identity), and
 * `target` — `≥ 3` is progress, **never** a gate (`FLOW.md` T04 / N1).
 *
 * S1's E0 landing is this same quantity negated at the screen, so the gate and the E0 composition
 * cannot disagree (R1).
 */
export function spreadGate(summary: VaultSummary): boolean {
  return summary.eligible;
}
