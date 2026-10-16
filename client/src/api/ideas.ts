import { apiRequest } from "./client.ts";
import type {
  CaptureInput,
  ForkFields,
  Idea,
  IdeaDetail,
  IdeaFields,
  VaultFilters,
} from "./types.ts";

/**
 * The vault endpoints the client uses (`docs/API.md` §4.2, §4.4, §4.5, §4.6, §4.7, §4.8). Pure
 * request/build functions — no React, no state — so the screens stay thin and this is tested directly.
 */

/**
 * The query string for the Vault list. Only non-empty filters are sent: §4.4 makes a *present* filter
 * with an empty value `422`, so an empty string must never reach the wire. Encoded with
 * `encodeURIComponent` so a tag is matched on its decoded value (§4.4's exact match).
 *
 * `status` (K8 `#42`) is not encoded — its two values are the contract's own, and `encodeURIComponent`
 * would only spell `NEEDS_COMPLETION` back at itself.
 */
export function vaultQuery(filters: VaultFilters = {}): string {
  const parts: string[] = [];
  if (filters.domain) parts.push(`domain=${encodeURIComponent(filters.domain)}`);
  if (filters.lineage) parts.push(`lineage=${encodeURIComponent(filters.lineage)}`);
  if (filters.status) parts.push(`status=${filters.status}`);
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

/**
 * `POST /v1/ideas/{id}/iterate` (§4.6, K8 `#42`) — the same node with a new version; **`200`**, not
 * `201`, because nothing new becomes addressable (`docs/API.md` §4.6). The response is the updated
 * `Idea`, and its `status` is the re-eligibility read: §4.6 writes `status = derivedStatus(fields)`,
 * so a committed iterate on a `NEEDS_COMPLETION` idea answers `ACTIVE` (`api/src/iterate.ts`).
 *
 * The body is the four mandatory fields and nothing else — §4.6's request is `IdeaFields` verbatim,
 * and a missing/blank one is a `422` rather than a partial write.
 */
export function iterateIdea(id: string, fields: IdeaFields): Promise<Idea> {
  return apiRequest<Idea>(`/v1/ideas/${encodeURIComponent(id)}/iterate`, {
    method: "POST",
    body: JSON.stringify({
      hypothesis: fields.hypothesis,
      problem: fields.problem,
      monetization: fields.monetization,
      domain_tags: fields.domain_tags,
    }),
  });
}

/**
 * `POST /v1/ideas/{id}/fork` (§4.7) — a **new**, addressable node, so `201` and the response is the
 * fork itself (capture and fork create; iterate and delete do not — §4.6/§4.8).
 *
 * The body is the frozen two fields and nothing else: §4.7's request carries no text, and the fork
 * copies the parent's `hypothesis` / `problem` / `monetization` verbatim (V4 `#15`). A blank delta is
 * a `422`, and a `domain_tags` set **equal** to the parent's is a `409 conflict` — the client's cue
 * to offer Iterate instead (a same-domain branch is a refinement, not a fork; T25).
 */
export function forkIdea(id: string, fields: ForkFields): Promise<Idea> {
  return apiRequest<Idea>(`/v1/ideas/${encodeURIComponent(id)}/fork`, {
    method: "POST",
    body: JSON.stringify({
      mutation_delta: fields.mutation_delta,
      domain_tags: fields.domain_tags,
    }),
  });
}

/** `DELETE /v1/ideas/{id}` (§4.8) — orphan-with-warning; the server does not block. */
export function deleteIdea(id: string): Promise<{ deleted: true; id: string }> {
  return apiRequest<{ deleted: true; id: string }>(`/v1/ideas/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
