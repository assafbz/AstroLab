import { apiRequest } from "./client.ts";
import type { CaptureInput, Idea, IdeaDetail, VaultFilters } from "./types.ts";

/**
 * The vault endpoints V8 uses (`docs/API.md` §4.2, §4.4, §4.5, §4.8). Pure request/build functions —
 * no React, no state — so the screens stay thin and this is tested directly.
 */

/**
 * The query string for the Vault list. Only non-empty filters are sent: §4.4 makes a *present* filter
 * with an empty value `422`, so an empty string must never reach the wire. Encoded with
 * `encodeURIComponent` so a tag is matched on its decoded value (§4.4's exact match).
 */
export function vaultQuery(filters: VaultFilters = {}): string {
  const parts: string[] = [];
  if (filters.domain) parts.push(`domain=${encodeURIComponent(filters.domain)}`);
  if (filters.lineage) parts.push(`lineage=${encodeURIComponent(filters.lineage)}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

/** `GET /v1/ideas` (§4.4) in server order — newest first; the client does not re-sort. */
export async function listIdeas(filters: VaultFilters = {}): Promise<Idea[]> {
  const body = await apiRequest<{ ideas: Idea[] }>(`/v1/ideas${vaultQuery(filters)}`);
  return body.ideas;
}

/** `GET /v1/ideas/{id}` (§4.5). One read snapshot: detail, versions, lineage, provenance, refs. */
export function getIdeaDetail(id: string): Promise<IdeaDetail> {
  return apiRequest<IdeaDetail>(`/v1/ideas/${encodeURIComponent(id)}`);
}

/**
 * `POST /v1/ideas` (§4.2). The seeded pair is sent explicitly as `null` on a blank capture: §4.2
 * names the seeded save by "both present", and the pair is both-or-neither (a half-present pair is
 * `422`) — so the blank case states its absence rather than relying on it.
 */
export function createIdea(input: CaptureInput): Promise<Idea> {
  return apiRequest<Idea>("/v1/ideas", {
    method: "POST",
    body: JSON.stringify({
      hypothesis: input.hypothesis,
      problem: input.problem,
      monetization: input.monetization,
      domain_tags: input.domain_tags,
      origin_spark_id: input.origin_spark_id ?? null,
      decision_id: input.decision_id ?? null,
    }),
  });
}

/** `DELETE /v1/ideas/{id}` (§4.8) — orphan-with-warning; the server does not block. */
export function deleteIdea(id: string): Promise<{ deleted: true; id: string }> {
  return apiRequest<{ deleted: true; id: string }>(`/v1/ideas/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
