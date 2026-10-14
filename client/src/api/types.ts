/**
 * The response and request shapes the client consumes, as `docs/API.md` §3.1 / §4.2 / §4.5 spell
 * them. Field names are the contract's, verbatim — the client never renames or re-shapes a payload,
 * so a mismatch shows up as a type error here rather than as a silent `undefined` in a screen.
 */

/** `docs/API.md` §3.1. */
export interface Idea {
  id: string;
  hypothesis: string;
  problem: string;
  monetization: string;
  domain_tags: string[];
  lineage_kind: "ROOT" | "FORK";
  lineage_parent_id: string | null;
  status: "ACTIVE" | "NEEDS_COMPLETION";
  visibility: "PRIVATE";
  current_version: number;
  created_at: string;
  updated_at: string;
}

/** One `idea_version` row (`docs/API.md` §4.5) — history under the same node, not an ancestor. */
export interface IdeaVersion {
  version: number;
  hypothesis: string;
  problem: string;
  monetization: string;
  domain_tags: string[];
  created_at: string;
}

/** `docs/API.md` §4.5 — muted provenance metadata. Ids only; never resolved to titles (D5). */
export interface ProvenanceRef {
  source_idea_id: string;
  spark_id: string;
}

/** `docs/API.md` §4.5. */
export interface IdeaDetail {
  idea: Idea;
  versions: IdeaVersion[];
  /** Root-first, ending at the immediate parent; the node itself is `idea`. `[]` for a `ROOT`. */
  lineage: Idea[];
  provenance: ProvenanceRef[];
  /** The T26 delete warning's source (§4.5, §4.8). Empty arrays when nothing references this idea. */
  referenced_by: { forks: string[]; derived: string[] };
}

/** `docs/API.md` §4.2. The seeded pair is both-or-neither — a blank capture sends both as `null`. */
export interface CaptureInput {
  hypothesis: string;
  problem: string;
  monetization: string;
  domain_tags: string[];
  origin_spark_id?: string | null;
  decision_id?: string | null;
}

/** `docs/API.md` §4.4. `null`/absent = the contract's "no restriction"; `""` is never sent (422). */
export interface VaultFilters {
  domain?: string | null;
  lineage?: Idea["lineage_kind"] | null;
}

/**
 * `docs/API.md` §3.2 — `GET /v1/vault/summary` (O2 `#22`). The S0 progress readout and the S0→S1
 * spread gate both read **this** shape: `resolved_domains` is the count, `target` is the denominator,
 * and `eligible` is the gate the engine and the client must not disagree about.
 */
export interface VaultSummary {
  /** Distinct clusters covered by tags present in the shipped `domain_map` — the count `x/3` shows. */
  resolved_domains: number;
  /** Distinct **unmapped** tags, each its own cluster. Never part of the readout (R1). */
  provisional_domains: number;
  /** The product target (3) — the readout's denominator, read from the payload, never a literal. */
  target: number;
  /** The spark floor (2) — `eligible`'s threshold. */
  floor: number;
  /** The S0→S1 spread gate: `resolved_domains >= floor`. E0 is the *engine's* state, not this. */
  eligible: boolean;
}
