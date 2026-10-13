# API Contract: Astrolab (MVP v1.0)

> **Status:** Frozen for the MVP build — issue **F4** (frozen v6 issue set, 2026-10-13).
> **Scope:** The request/response contract for every endpoint in `docs/ARCHITECTURE.md` §6, plus
> `/healthz`. This is the interface the client lane builds against, and the shape the API skeleton
> (F4) and the resource endpoints (F1–F4, V*, O*, K*) must honour.
> **Source of record:** `ARCHITECTURE.md` §6 (surfaces) · §2 (data model) · §4 (async / degradation) ·
> §8 (export) · §9 (stack & security); `FLOW.md` §2.2 / §4.3 (decision semantics) · §4.1 (E0–E4) ·
> §5.4 (undo) · §5.6 (degradation); `PRD.md` §2 (idea anatomy) · §5 (metrics).
> **Precedence:** where this doc and `ARCHITECTURE.md` §6 disagree, **ARCHITECTURE wins** and this doc
> is the defect — file it. This doc adds no product opinion of its own; every rule below is a citation.
> **Vocabulary:** the engine is **the Spark**; its outputs are **sparks**. *(Never "collision.")*

---

## 0. Scope & non-goals

- HTTP/JSON over HTTPS, bearer-authenticated. One error envelope. No scores, distances, alignments,
  or "related ideas" anywhere in any response (`PRD.md` §3.3 item 4; `DESIGN.md` §7; `VISION.md` §8 item 4).
- The **server** enforces the invariants (domain-mandatory, single-parent lineage, provenance ≠
  lineage, one live offer per pair, mandatory-field validation). The client never encodes them
  (`ARCHITECTURE.md` §6 last line).
- **No vault path calls the AI boundary** (`ARCHITECTURE.md` §3.2, §4, ADR-0004). Every endpoint
  here except the worker's own run trigger is provider-free.
- Not here: pagination, bulk ops, sharing/visibility scopes, tenancy — all deferred (`PRD.md` §6).

---

## 1. Conventions

| Item | Value |
| :--- | :--- |
| Base path | `/v1` (except `/healthz`) |
| Media type | `application/json; charset=utf-8` (SSE: `text/event-stream`) |
| Timestamps | ISO-8601 UTC, e.g. `2026-10-13T05:14:05Z` |
| IDs | opaque strings (uuid). Never parse them client-side |
| Auth | `Authorization: Bearer <token>` on every `/v1` route, where `<token>` is the **value** of the env var **`API_TOKEN`**; `/healthz` is unauthenticated |
| Secret source | env vars **`API_TOKEN`** (bearer) and `AI_PROVIDER` / `AI_MODEL` come from the environment only, never the repo (`ARCHITECTURE.md` §9). `API_TOKEN` is the **env var name**, not the token value |
| Unknown query param | ignored |
| Unknown enum value | `422 validation_failed` |

**`decision_id` (client-generated).** For **every** resolving action — deck **ACCEPT**, deck
**DISMISS**, and a **committed seeded save** — the client generates `decision_id`, persists it, and
**reuses the same value on retry** (`FLOW.md` §2.2 / N4). The server keys idempotency on it. A
regenerated id turns a retry into a second decision; the client must not regenerate it.

---

## 2. Error envelope (one shape, for every failure)

```json
{ "error": { "code": "validation_failed", "message": "hypothesis exceeds 280 characters", "details": null } }
```

| `code` | HTTP | When |
| :--- | :--- | :--- |
| `unauthorized` | 401 | missing, blank, or invalid bearer token |
| `not_found` | 404 | unknown `{id}`, `{decision_id}`, or spark |
| `validation_failed` | 422 | a mandatory field missing/empty; `hypothesis` > 280; `domain_tags` empty; `mutation_delta` empty |
| `conflict` | 409 | same-domain fork (offers Iterate, T25); undo not reversible (§5.4) |
| `internal_error` | 500 | unexpected |

- `message` is human-readable and non-normative; **clients branch on `code`, never on `message`.**
- Success is `2xx` with the resource body. Failures are **only** this envelope — never a bare string,
  never HTML, never a stack trace (`ARCHITECTURE.md` §9; issue F4).

---

## 3. Resources

### 3.1 `Idea`
```json
{
  "id": "9f1c…",
  "hypothesis": "A single sentence, ≤ 280 chars",
  "problem": "…",
  "monetization": "…",
  "domain_tags": ["fintech", "logistics"],
  "lineage_kind": "ROOT",
  "lineage_parent_id": null,
  "status": "ACTIVE",
  "visibility": "PRIVATE",
  "current_version": 2,
  "created_at": "2026-10-13T05:14:05Z",
  "updated_at": "2026-10-13T05:14:05Z"
}
```
Enums: `lineage_kind` ∈ `ROOT | ITERATION | FORK`; `status` ∈ `ACTIVE | NEEDS_COMPLETION`;
`visibility` = `PRIVATE` (MVP only). `lineage_parent_id` is set **only** for `FORK` and always refers
to **one** parent (`PRD.md` §2; `ARCHITECTURE.md` §2.1). `NEEDS_COMPLETION` = a spark-derived idea
whose mandatory fields could not be fully prefilled; it is **excluded from candidate selection** until
complete (`FLOW.md` §4.3 step 4 / T27).

### 3.2 `VaultSummary` — deterministic, **no provider call** (`ARCHITECTURE.md` §3.2)
```json
{ "resolved_domains": 2, "provisional_domains": 1, "target": 3, "floor": 2, "eligible": true }
```
- `resolved_domains` — distinct clusters covered by tags present in the shipped seed `domain_map`.
- `provisional_domains` — distinct unmapped tags, each its own cluster.
- `floor` = 2, `target` = 3 (fixed constants). `eligible = resolved_domains >= 2`.
- **The client computes the S0→S1 gate from `eligible`/`resolved_domains` only** — never from
  `provisional_domains` (R1). This is the **same quantity** the engine's E0 check reads, so a pass
  cannot collapse after a run. `resolved` is monotone non-decreasing: worker normalisation can only
  collapse a provisional tag into a cluster, never split one.

### 3.3 `Spark` (deck card — `ARCHITECTURE.md` §6, S1)
```json
{ "id": "1a2b…", "direction": "the proposed idea (headline)", "claim": "one–two lines, why it matters",
  "domain_tags": ["audio-dsp"], "created_at": "2026-10-13T05:14:05Z" }
```
No `mechanism`, no `domain_distance`, no `structural_alignment`, no source idea ids — selection
internals never surface (`PRD.md` §3.3 items 2–4; `ARCHITECTURE.md` §2.3).

### 3.4 `SparkDetail` (S1b — `ARCHITECTURE.md` §6)
`Spark` plus:
```json
{ "what_it_takes": "…", "first_step": "…" }
```

### 3.5 `Decision`
```json
{ "decision_id": "c7d…", "spark_id": "1a2b…", "kind": "ACCEPT", "result_idea_id": "9f1c…",
  "spark_status": "RESOLVED-ACCEPTED", "decided_at": "2026-10-13T05:14:05Z", "undoable": true }
```
`kind` ∈ `ACCEPT | DISMISS | INSPIRED`. `spark_status` is terminal and is `FLOW.md` §3's verbatim:
`RESOLVED-ACCEPTED | RESOLVED-DISMISSED | RESOLVED-INSPIRED` (never a bare `ACCEPTED`). `result_idea_id`
is the ROOT created by `ACCEPT` or by a committed seeded save; `null` for `DISMISS`. `undoable`
reflects server-side reversibility (§5.4) at response time.

### 3.6 `EngineState` (`FLOW.md` §4.1)
```json
{ "state": "E1", "unreviewed": 0,
  "run": { "id": "r-42", "status": "RUNNING", "vault_revision": 42 } }
```
- `state` ∈ `E0 Cold | E1 Computing | E2 Ready | E3 Exhausted | E4 Unavailable`.
- `unreviewed` = `n` for `E2 Ready(n)`; the count the deck/list needs.
- Precedence, server-computed: **`E0` dominates all**; then **`E4 > E3`**; **`E1` may coexist with
  `E2`** (the `state` field reports the dominant one; `unreviewed` stays truthful so the deck can
  still render offered cards during a run).
- `run` is `null` when nothing is in flight.

---

## 4. Endpoints

Every row cites `ARCHITECTURE.md` §6. `/healthz` is added by issue F4.

### 4.1 `GET /healthz` — liveness, **unauthenticated**
`200` → `{ "status": "ok" }`. No auth, no vault access, no provider call.

### 4.2 `POST /v1/ideas` — Capture (S0, S2), blank **or seeded**
Request:
```json
{ "hypothesis": "…", "problem": "…", "monetization": "…", "domain_tags": ["…"],
  "origin_spark_id": null, "decision_id": null }
```
- **Blank capture:** both `origin_spark_id` and `decision_id` absent/`null` → creates a plain **ROOT**
  idea.
- **Seeded capture (S2 from INSPIRE):** both present → **one transaction** writes the ROOT idea,
  its **provenance** edges to the spark's two sources, and a `decision` row (`kind = INSPIRED`,
  `id = decision_id`); the source spark → `RESOLVED-INSPIRED` (`FLOW.md` §4.3 / T16; `ARCHITECTURE.md`
  §6 D). **Idempotent on `decision_id`:** a repeated call returns the first result and writes nothing.
- **Validation (server-enforced):** `hypothesis` ≤ 280 and all of `hypothesis`, `problem`,
  `monetization`, and ≥ 1 `domain_tags` non-empty → else `422`. Domain is mandatory — an idea without
  a domain cannot take part in a spark (`PRD.md` §2; `FLOW.md` T02).
- S0 domain input is a pick from the shipped taxonomy **plus an `Other → free text` escape**; a picked
  tag resolves deterministically (no AI); a typed lane is provisional (`ARCHITECTURE.md` §3.2, §6;
  `FLOW.md` r3.3).

Response `201` → `Idea`. A seeded save's `Decision` is retrievable at `{decision_id}` via the undo
route (§4.15).

### 4.3 `GET /v1/vault/summary` — S0 progress / spread gate
`200` → `VaultSummary` (§3.2). Deterministic; **never** blocks on the provider.

### 4.4 `GET /v1/ideas?domain=&lineage=&status=` — Vault list (S3)
Filters: `domain` (exact tag match), `lineage` ∈ `ROOT|ITERATION|FORK`, `status` ∈
`ACTIVE|NEEDS_COMPLETION`. Absent filter = no restriction.
`200` → `{ "ideas": [Idea, …] }`.

### 4.5 `GET /v1/ideas/{id}` — Idea detail (S4)
`200` →
```json
{ "idea": Idea,
  "versions": [ { "version": 1, "hypothesis": "…", "problem": "…", "monetization": "…",
                  "domain_tags": ["…"], "created_at": "…" } ],
  "lineage": [ Idea, … ],
  "provenance": [ { "source_idea_id": "…", "spark_id": "…" } ],
  "referenced_by": { "forks": ["…"], "derived": ["…"] } }
```
- `versions` = history under the same node (`PRD.md` §3.2 item 1). `lineage` = the single-parent ancestor
  chain. `provenance` = **muted** metadata, never merged into `lineage` (`FLOW.md` §2.3).
- `referenced_by` supplies the T26 delete warning: `forks` = ideas whose `lineage_parent_id` is this
  idea; `derived` = ideas that reference this idea as a provenance source. Empty arrays when none.

### 4.6 `POST /v1/ideas/{id}/iterate` — S6 Iterate
Request: the mandatory fields (`hypothesis`, `problem`, `monetization`, `domain_tags`).
`200` → `Idea` with `current_version` bumped. Writes a new `idea_version`; creates **no** lineage edge
(`FLOW.md` §2.3 / L1; T23). Validation as §4.2.

### 4.7 `POST /v1/ideas/{id}/fork` — S5 Fork
Request: `{ "mutation_delta": "…", "domain_tags": ["…"] }`.
Guard: `mutation_delta` non-empty **and** the fork's domain set differs from the parent's
(`PRD.md` §1.2; `FLOW.md` T25). Empty delta → `422`. Domain **equal** to the parent's → `409 conflict`
(the client offers **Iterate** instead).
`201` → new `Idea` with `lineage_kind = FORK`, `lineage_parent_id = {id}`. Single parent, forever.

### 4.8 `DELETE /v1/ideas/{id}` — delete, orphan-with-warning
`200` → `{ "deleted": true, "id": "…" }`. Semantics (`FLOW.md` T26 / M3):
- a fork **child** keeps its `lineage_parent_id` (dangling parent ref, tolerated);
- an idea referenced as a **provenance source** leaves that ref dangling (tolerated) — the derived
  idea is **not** deleted and its spark stays `RESOLVED-*`.
The warning shown before delete is read from `referenced_by` in §4.5; the client is responsible for
surfacing it, the server does not block.

### 4.9 `GET /v1/sparks?state=offered` — deck read (S1)
`200` → `{ "sparks": [Spark, …] }` in **server order** (deck order = server order).
`state=offered` returns live offers only (`status = OFFERED`).

### 4.10 `GET /v1/sparks/state` — engine state (S1)
`200` → `EngineState` (§3.6). Provider-free.

### 4.11 `GET /v1/sparks/events` — run progress stream (SSE)
`200`, `Content-Type: text/event-stream`. Events:
```
event: state
data: {EngineState}

event: offer
data: {Spark}
```
- `state` fires on every engine-state change; `offer` fires when a new spark enters the deck — new
  offers surface **on the event, not a timer** (`ARCHITECTURE.md` §4 / N, F).
- **Polling fallback** (part of NFR-P1's bound, not polish): when SSE is unavailable the client polls
  `GET /v1/sparks/state` + `GET /v1/sparks?state=offered` with **bounded backoff, only while
  `state = E1`**.

### 4.12 `GET /v1/sparks/{id}` — spark detail (S1b)
`200` → `SparkDetail` (§3.4). No scores, no similarity readout (`ARCHITECTURE.md` §6).

### 4.13 `POST /v1/sparks/{id}/decision` — ACCEPT / DISMISS
Request: `{ "decision_id": "…", "kind": "ACCEPT" | "DISMISS" }`.
- **Idempotent on `decision_id`.** A raced swipe + button tap, or a retry after an interrupted commit,
  resolve to **one** decision (`FLOW.md` §2.2, §4.3 / H4).
- `ACCEPT`: in **one transaction** — create the ROOT idea from the spark's proposed direction, write
  its **provenance** edges to the two sources, set the spark `RESOLVED-ACCEPTED`. Where the spark
  supplies the mandatory fields, prefill them; where it cannot, the idea enters `NEEDS_COMPLETION`
  (saved, flagged, excluded from selection, and the user is prompted to polish) (`FLOW.md` §4.3 step 4
  / T27).
- `DISMISS`: set the spark `RESOLVED-DISMISSED`; retain the pairing as negative signal; create **no**
  vault node (`FLOW.md` §4.3).
- **Both are vault operations and must succeed with the AI down** (`FLOW.md` §4.3; NFR-A1).

`200` → `Decision` (§3.5). A repeated `(spark_id, decision_id)` returns the first `Decision` unchanged.

### 4.14 `POST /v1/sparks/{id}/inspire` — open seeded capture
`200` → the seed payload to prefill Capture:
```json
{ "spark_id": "…", "direction": "…", "claim": "…", "what_it_takes": "…", "first_step": "…",
  "domain_tags": ["…"] }
```
**INSPIRE is not a resolution.** It writes **no** `decision` and the spark stays `OFFERED`; the spark
resolves only when a seeded save commits (`FLOW.md` §4.3 / B). Abandoning Capture leaves the spark
`OFFERED`.

### 4.15 `POST /v1/decisions/{decision_id}/undo` — one step
Covers all three resolving paths: deck **ACCEPT**, deck **DISMISS**, and a **committed seeded save**
(`FLOW.md` §5.4 / T12, N3).
- ACCEPT / seeded save: retract the derived idea **only if still unedited**, clear its provenance,
  clear the resolution, return the spark to `OFFERED`.
- DISMISS: clear the negative signal, return the spark to `OFFERED`.
- **Permanent** once the window closes or the derived idea has been opened/edited — deleting a derived
  idea later does **not** un-resolve its spark (`FLOW.md` §5.4 / M3).

`200` → `{ "undone": true, "spark_id": "…", "spark_status": "OFFERED", "retracted_idea_id": "…" }`
(`retracted_idea_id` is `null` for a DISMISS undo). Not reversible → **`409 conflict`** envelope. The
undo window is server-side policy (`FLOW.md` §5.4 leaves its duration unspecified); the response's
`undoable` (§3.5) is the client's signal for whether to show the affordance.

### 4.16 `POST /v1/sparks/run` — enqueue a run (Recompute)
`202` → `{ "run_id": "…", "vault_revision": 42 }`. Enqueues an async run (→ `E1`); the request never
waits on the engine (NFR-P1). Runs are **idempotent per revision** and a stale run is **discarded, not
queued** (`ARCHITECTURE.md` §4 / I).

### 4.17 `GET /v1/export` — open, complete export (NFR-D1)
`200` → a single self-describing JSON document (`ARCHITECTURE.md` §8):
```json
{ "schema_version": "1",
  "exported_at": "2026-10-13T05:14:05Z",
  "ideas": [ … ], "idea_versions": [ … ], "lineage_edges": [ … ],
  "provenance_edges": [ … ], "decisions": [ … ], "domain_tags": [ … ] }
```
`domain_tags[]` is part of the contract and is the field most easily dropped — it is required. Every
committed idea is present; no vendor format, no proprietary ids needed to read it.

---

## 5. Invariants the server enforces (not the client)

1. **Domain-mandatory** capture — no domain ⇒ no idea (`PRD.md` §2).
2. **Single-parent lineage** — a fork has exactly one parent (`PRD.md` §2).
3. **Provenance ≠ lineage** — an idea bearing provenance edges has **no** lineage parent
   (`ARCHITECTURE.md` §2.2; closes decision D1).
4. **At most one live offer per pair** — the partial unique index on `spark(pair_key) WHERE status =
   'OFFERED'` (`ARCHITECTURE.md` §2.3, §3.5).
5. **Mandatory-field validation on every write** (`PRD.md` §2; `ARCHITECTURE.md` §6).
6. **No path to scores/similarity** — no response carries a distance, alignment, or "related" readout
   (`PRD.md` §3.3 item 4).

---

## 6. Contract decisions to confirm (flagged, not silently invented)

Two shapes below are not spelled out in `ARCHITECTURE.md` §6 and are this doc's proposal. Confirm or
correct before the client lane relies on them:

- **`referenced_by` on Idea detail (§4.5)** — the T26 delete warning ("names the affected forks / the
  derived ideas") needs *reverse* references; the contract exposes them on detail rather than inventing
  a dry-run delete.
- **`undoable` + the 409 rule (§3.5, §4.15)** — `FLOW.md` §5.4 leaves the undo window unspecified;
  the contract treats it as server policy and exposes only the resulting `undoable` flag.

---

*Frozen — Ari (AstroLab agent), 2026-10-13, issue **F4** (`#11`), branch `feat/f4-api-contract`.*
