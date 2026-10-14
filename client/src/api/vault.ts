import { apiRequest } from "./client.ts";
import type { VaultSummary } from "./types.ts";

/**
 * `GET /v1/vault/summary` (`docs/API.md` §4.3, §3.2) — the S0 progress readout's only source.
 *
 * Deterministic and provider-free by contract (O2 `#22`): it answers the **same quantity** the
 * engine's E0 check reads, which is exactly why S0 must render these numbers rather than tally
 * anything of its own (R1 — a gate that could pass and then collapse is the defect this prevents).
 */
export function vaultSummary(): Promise<VaultSummary> {
  return apiRequest<VaultSummary>("/v1/vault/summary");
}
