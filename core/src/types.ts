import type { RunFailureCause } from "./failure.js";

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

/**
 * `docs/API.md` §4.2 / §4.6 — the four mandatory fields (`PRD.md` §2), spelled **once**.
 *
 * Both the blank capture (§4.2) and the iterate (§4.6) carry exactly this set, and §4.6's clear of
 * `NEEDS_COMPLETION` is decided from it (`derivedStatus`, `core/src/vault/decision.ts`). Two spellings of
 * "the mandatory four" would be two places for the set to drift.
 */
export interface IdeaFields {
  hypothesis: string;
  problem: string;
  monetization: string;
  domain_tags: string[];
}

/** `docs/API.md` §4.2. The seeded pair is both-or-neither — a blank capture sends both as `null`. */
export interface CaptureInput extends IdeaFields {
  origin_spark_id?: string | null;
  decision_id?: string | null;
}

/**
 * `docs/API.md` §4.7 — the fork's request, the **frozen two fields**, spelled once.
 *
 * Deliberately *not* a widening of `IdeaFields`: §4.7 carries no text, and the fork's
 * `hypothesis` / `problem` / `monetization` are the **parent's, copied verbatim**. With no text in the
 * request the parent is the only possible source, so the copy is the only reading, not a choice (V4
 * `#15`). `domain_tags` here is the *fork's own* set — §4.7 requires it to differ from the parent's.
 */
export interface ForkFields {
  mutation_delta: string;
  domain_tags: string[];
}

/** `docs/API.md` §4.4. `null`/absent = the contract's "no restriction"; `""` is never sent (422). */
export interface VaultFilters {
  domain?: string | null;
  lineage?: Idea["lineage_kind"] | null;
  /** K8 `#42` — the deck's and the Vault's *needs completion* prompt reads this slice. */
  status?: Idea["status"] | null;
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

/**
 * `docs/API.md` §3.3 — one deck card, the `Spark` projection (K1 `#35`, `first_step` #115). The six
 * fields the card draws, and nothing else: no score, no distance, no similarity, and no source idea ids
 * — selection internals never surface (`ARCHITECTURE.md` §2.3). `domain_tags` is the derived, deduped
 * union, first appearance winning; a tag may be **provisional**, so the card must not read a chip as a
 * resolved cluster (§3.3).
 */
export interface Spark {
  id: string;
  /** The proposed idea — the card's headline. */
  direction: string;
  /** One–two lines, why it matters. */
  claim: string;
  /**
   * The smallest next move — the card's third element (`docs/stitch-prompts.md` §1; `DESIGN.md` §4/§9).
   * `null` only on a **legacy row**: `parseAdjudication` accepts an all-non-empty draft or an all-null
   * refusal, so an offered spark carries real content and a `null` is rendered as simply absent (§3.3).
   */
  first_step: string | null;
  domain_tags: string[];
  created_at: string;
}

/**
 * `docs/API.md` §3.4 — the S1b expanded view: `Spark` plus **only** `what_it_takes`.
 *
 * `first_step` sits on `Spark` itself (§3.3, #115), so the detail's whole delta is the one field that
 * stays off the card by design — `what_it_takes` belongs to the expanded view (`PRD.md` §3.3 item 4),
 * and it is in neither §4.9's read nor §4.11's `offer` frame, which is why S1b reads its **own**
 * endpoint rather than composing itself from the card it was reached through.
 */
export interface SparkDetail extends Spark {
  /**
   * What the idea would take to build. `null` only on a **legacy row** — the same rule `first_step`
   * carries (§3.3): rendered as simply absent, never a label over nothing.
   */
  what_it_takes: string | null;
}

/**
 * `docs/API.md` §4.14 — the seed payload `POST /v1/sparks/{id}/inspire` returns to prefill S2.
 *
 * It is §3.4's exact projection under the payload's own key names: `Spark` plus `what_it_takes`, minus
 * `created_at`, with `id` presented as `spark_id` (the client keys the seed by the spark it came from).
 * §3.3's six fields are therefore all here, and the screen maps **four** of them onto Capture's fields
 * (`seedToDraft`): a spark carries no `monetization`, and `what_it_takes`/`first_step` have no Capture
 * field to land in, so they are read and not seeded (recorded in #119). `domain_tags` is the two source
 * ideas' deduped union, folded server-side (§3.3) — the client takes it as given.
 */
export interface InspireSeed {
  spark_id: string;
  /** The proposed idea — the "Core Hypothesis" the seeded capture prefills. */
  direction: string;
  /** Why it matters — the "Problem Solved" the seeded capture prefills. */
  claim: string;
  /** What the idea would take to build. `null` only on a legacy row — absent, not `""` (§3.4). */
  what_it_takes: string | null;
  /** The card's third element (§3.3). `null` only on a legacy row, rendered as simply absent. */
  first_step: string | null;
  /** The two source ideas' tags, pair order, deduped (§3.3) — carried as given, never re-derived. */
  domain_tags: string[];
}

/**
 * `docs/API.md` §3.5 — one resolution, as the server recorded it.
 *
 * `kind` is the contract's **three** — a *response* may name `INSPIRED` even though §4.13's request
 * accepts only `ACCEPT`/`DISMISS` (the widening the response needs, the request does not; the request's
 * narrowing is `api/decisions.ts`'s). The three are spelled here rather than aliased to the seam's
 * `ResolutionKind` (`domain/deck-interaction.ts`) **on purpose**: aliasing would bind the *interaction*
 * vocabulary to §3.5's *response*, so a response kind added later would force the seam to widen to a
 * gesture the card cannot make. Same three today, deliberately two names (#129, Max's #41 review).
 * `spark_status` is `FLOW.md` §3's **verbatim** terminal status —
 * never a bare `ACCEPTED` — and `result_idea_id` is the ROOT that `ACCEPT` derived, `null` for a
 * `DISMISS`. `undoable` reports §5.4's server-side window at response time; the client computes none
 * of it.
 */
export interface Decision {
  decision_id: string;
  spark_id: string;
  kind: "ACCEPT" | "DISMISS" | "INSPIRED";
  result_idea_id: string | null;
  spark_status: "RESOLVED-ACCEPTED" | "RESOLVED-DISMISSED" | "RESOLVED-INSPIRED";
  decided_at: string;
  undoable: boolean;
}

/** `docs/API.md` §3.6 / `FLOW.md` §4.1 — the five engine states, verbatim. */
export type EngineStateName = "E0" | "E1" | "E2" | "E3" | "E4";

/** `spark_run.status` (`docs/SCHEMA.md`) — `PENDING` / `RUNNING` are "in flight" (§4.10). */
export type RunStatus = "PENDING" | "RUNNING" | "DONE" | "FAILED";

/** §3.6's `run` — the newest in-flight row, or `null` when nothing is in flight. */
export interface EngineRun {
  id: string;
  status: RunStatus;
  vault_revision: number;
}

/**
 * `docs/API.md` §3.6 / §4.10 — `GET /v1/sparks/state`. **The deck's only state input.**
 *
 * `state` is the precedence-resolved ladder (`E0 → E4 → E1 → E2 → E3`, computed once in
 * `core/src/vault/engine-state.ts`) and `unreviewed` is the count of `OFFERED` sparks **in every state** —
 * so `E1` coexists with a renderable deck without the count going missing. The client composes around
 * this; it never re-derives it (§4.9: *"the deck read does not re-derive it"*).
 */
export interface EngineState {
  state: EngineStateName;
  unreviewed: number;
  run: EngineRun | null;
  /**
   * `FLOW.md` §4.1 / §4.3 — **why** the engine is Exhausted, when it is: E4's arms are the copy the
   * deck shows (`core/src/failure.ts` owns the vocabulary, `core/src/vault/engine-state.ts` reads it off
   * the failed row). `null` in every other state, and for an E4 whose row carries no tag.
   */
  cause: RunFailureCause | null;
}

/**
 * `docs/API.md` §4.16 — the `202` from `POST /v1/sparks/run`, the cold-start run trigger (O5 `#25`).
 *
 * `run_id` is the enqueued row and `vault_revision` the revision it runs at. Both are the server's; the
 * client only anchors the POST off them (§3.6's `run` shape carries the same pair). The trigger is
 * fire-and-forget (NFR-P1) — this payload is not awaited to decide anything on S0.
 */
export interface RunAccepted {
  run_id: string;
  vault_revision: number;
}
