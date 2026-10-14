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
| Auth order | checked **before** routing, for the whole `/v1` namespace: an unauthenticated request to *any* `/v1` path — a known route, an unknown one, or the bare prefix — is `401 unauthorized`. Routing runs only with a valid token, so an unauthenticated caller cannot tell which routes exist. The check **fails closed**: with `API_TOKEN` unset or empty, every `/v1` request is `401`. `/healthz` is the exception — liveness never depends on the secret, or a health check would fail exactly when it is most needed. The namespace test runs on **both the raw path and its normalised form** — percent-decoded (a malformed escape is caught, not thrown: the path is still classified), then runs of `/` collapsed — and the router matches that same normalised string, so no encoded or duplicated-slash spelling of a `/v1` path reaches a route without a token |
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
| `not_found` | 404 | unknown `{id}`, `{decision_id}`, or spark — **and any path or method that is not a defined route**: only defined routes answer, everything else is this envelope |
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
Enums: `lineage_kind` ∈ `ROOT | FORK`; `status` ∈ `ACTIVE | NEEDS_COMPLETION`;
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

Readings this doc had not pinned (settled in O2 `#22`):

- **Every `idea` row contributes** — there is no status filter. `NEEDS_COMPLETION` is excluded from
  *candidate selection* (`FLOW.md` §4.3/T27), which is the engine's business; filtering here would let
  `resolved` **drop** when an idea's status changed, for a reason the contract does not name, against
  the monotone rule.
- **The match is exact**, against `domain_map.tag` as stored: the shipped seed's keys are clean
  lower-case slugs (`store/src/domain-seed.ts` lints them) and capture stores each tag raw
  (`ARCHITECTURE.md` §3.2), so `Fintech` is **provisional** until the worker writes that exact spelling
  back. Recorded because normalising here would be a second, unstated vocabulary — and it is what makes
  `resolved` monotone under the worker's write-back.
- **`resolved_domains` is `COUNT(DISTINCT cluster_id)`** (`#fintech` + `#banking` are **one** domain —
  the collapse R1 exists to prevent) and **`provisional_domains` counts distinct tags**, each its own
  cluster, deduped across the vault.
- **The two counts are one snapshot** — a single statement, so the pair cannot be a torn read of two
  vault states. No transaction wrapper is involved, and a second statement would be the defect.
- **The response writes nothing** — it moves no `vault_meta.revision` and enqueues no run.

### 3.3 `Spark` (deck card — `ARCHITECTURE.md` §6, S1)
```json
{ "id": "1a2b…", "direction": "the proposed idea (headline)", "claim": "one–two lines, why it matters",
  "domain_tags": ["audio-dsp"], "created_at": "2026-10-13T05:14:05Z" }
```
No `mechanism`, no `domain_distance`, no `structural_alignment`, no source idea ids — selection
internals never surface (`PRD.md` §3.3 items 2–4; `ARCHITECTURE.md` §2.3).

`domain_tags` is **derived, not stored**: `spark` has no tags column (`ARCHITECTURE.md` §2.3), so
§4.9's read joins the two source ideas and returns the **deduped union in the writer's stored
`idea_a_id`→`idea_b_id` order**, which `ux_spark_live` pins to a single live row per pair — first
appearance winning. A client may rely on that determinism **per row**; it must **not** assume id order
(`pair_key = min|max` keys the pair but does not fix which id lands in `idea_a_id`). A tag may be
**provisional** — an S0 `Other → free text` lane the worker has not resolved yet
(`ARCHITECTURE.md` §3.2) — and `Spark` carries no cluster field, so the card shows the raw tag: a
client must not read chips as resolved clusters.

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
- Precedence, server-computed: **`E0` dominates all**; then **`E4 > E3`**; then **`E1` dominates
  whenever a run is in flight** (`PENDING` **or** `RUNNING`, §4.10) — `state` is `E1` even while
  offered cards exist. **`E1` may coexist with `E2`** (the `state` field reports the dominant one;
  `unreviewed` stays truthful so the deck can still render offered cards during a run).
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

Readings this doc had not pinned (settled in O2 `#22`): the route is behind the same F4 gate as every
`/v1` path, **reads no query parameter** (§1: an unknown one is ignored), and any other method is the
`not_found` envelope (§2).

### 4.4 `GET /v1/ideas?domain=&lineage=&status=` — Vault list (S3)
Filters: `domain` (exact tag match), `lineage` ∈ `ROOT|FORK`, `status` ∈
`ACTIVE|NEEDS_COMPLETION`. Absent filter = no restriction.
`200` → `{ "ideas": [Idea, …] }`.

Readings this doc had not pinned (settled in V2 `#13`):

- **Order: `created_at DESC, id DESC`.** Newest first; `id` breaks a same-second tie, which is real
  because timestamps are second-resolution (§1).
- **`domain` matches the tag exactly** — `fin` does not match `fintech` (not a prefix, not a substring).
- **A repeated query key takes its first occurrence**; an unknown parameter name is ignored (§1).
- **A filter present with an empty value is `422`**, not "no restriction" — §1's unknown-enum rule
  applied to the filters' own vocabulary; `lineage=NOPE` is the same envelope.
- **No pagination in the MVP**: `ideas` is unbounded. A stated limit, not an oversight.

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

Readings this doc had not pinned (settled in V2 `#13`):

- **`versions` is every `idea_version` row for the node, ascending, the current one included** —
  excluding it would leave the editor's own values invisible in history; the client marks the current
  row "current" (`DESIGN.md` §8).
- **`lineage` is root-first and ends at the immediate parent**; the node itself is the `idea` field and
  is **not** a member of the chain. A `ROOT` has `lineage: []`.
- **`provenance` is sorted by `(source_idea_id, spark_id)`** — `source_idea_id` alone can tie, since the
  PK is `(derived_idea_id, source_idea_id, spark_id)`, and insertion order need not survive a restore.
  `forks` and `derived` are sorted by id, for the same reason.
- **`lineage` and `provenance` are never merged.** An idea bearing provenance has **no** lineage parent
  (§5 invariant 3): the two arrays answer different questions and one never feeds the other.
- **The absent case is empty, never an error** — no provenance, no ancestors, and no reverse references
  all answer `200` with `[]`.
- **The five reads are one snapshot** — they run inside a single read transaction, so a concurrent commit
  cannot land between them and ship a `versions` list that `idea.current_version` disagrees with.

### 4.6 `POST /v1/ideas/{id}/iterate` — S6 Iterate
Request: the mandatory fields (`hypothesis`, `problem`, `monetization`, `domain_tags`).
`200` → `Idea` with `current_version` bumped. Writes a new `idea_version`; creates **no** lineage edge
(`FLOW.md` §2.3 / L1; T23). Validation as §4.2.

Readings this doc had not pinned (settled in V3 `#14`):

- **`200`, not `201`** — an iterate updates the node it names: the id is the client's, there is no
  `Location`, and nothing new becomes addressable. Capture and fork create and answer `201`; this is
  the one mutating route whose success is not a creation.
- **The version row and the node bump commit in one `vaultMutation`.** Iterate is candidate-affecting
  (`ARCHITECTURE.md` §4), so the revision stamps and a run enqueues in the same transaction — the same
  trigger §4.8 records, reached through the same `vaultMutation(db, body)` primitive (`SCHEMA.md` §1c).
- **An unknown id is `not_found` and writes nothing** — the read throws inside the transaction before
  any row is written, so no version is appended and no revision stamps (V5's rule, §4.8).
- **`status` is not touched.** A `NEEDS_COMPLETION` idea stays `NEEDS_COMPLETION`; completing it is the
  K8 `#42` path. Iterate refines content, it does not clear the flag.
- **`lineage_kind` and `lineage_parent_id` are not touched.** Iterating a `FORK` leaves it a `FORK` on
  the same parent — iteration is a version, not a branch (`FLOW.md` §2.3 / L1).
- **Only `POST` on `{id}/iterate` is a route.** `GET`/`DELETE` on `…/iterate`, a `POST` on the detail
  path, and any deeper path (`/v1/ideas/a/b`) are the `not_found` envelope (§2), by the rule the read
  path already records.

### 4.7 `POST /v1/ideas/{id}/fork` — S5 Fork
Request: `{ "mutation_delta": "…", "domain_tags": ["…"] }`.
Guard: `mutation_delta` non-empty **and** the fork's domain set differs from the parent's
(`PRD.md` §1.2; `FLOW.md` T25). Empty delta → `422`. Domain **equal** to the parent's → `409 conflict`
(the client offers **Iterate** instead).
`201` → new `Idea` with `lineage_kind = FORK`, `lineage_parent_id = {id}`. Single parent, forever.

Readings this doc had not pinned (settled in V4 `#15`):

- **The request is the frozen two fields, and the text arrives by copy.** `mutation_delta` and
  `domain_tags` are the whole request; the fork's `hypothesis` / `problem` / `monetization` are the
  **parent's, copied verbatim**. With no text in the request the parent is the only possible source, so
  the copy is the only reading — not a choice. (The S5 sketch, `stitch-prompts.md` §6, shows the same two
  inputs: parent dimmed, a delta field, a domain picker.)
- **`201`, not `200`.** A fork creates a **new**, addressable node — the id is the server's and it is a
  new resource. Capture and fork create (`201`); iterate and delete do not (§4.6, §4.8).
- **The `idea` row and its `idea_version` 1 commit in one `vaultMutation`.** A fork is
  candidate-affecting (`ARCHITECTURE.md` §4), so the revision stamps and a run enqueues in the same
  transaction — the same trigger §4.6/§4.8 record, through the same `vaultMutation(db, body)` primitive
  (`SCHEMA.md` §1c).
- **No `provenance_edge` row.** The parent is a **lineage** edge (`lineage_parent_id`), not provenance:
  provenance is a different relation (`FLOW.md` §2.3), and `provenance_edge.spark_id` is NOT NULL while a
  fork has no spark. `PRD.md` §3.2 item 2's word "provenance" for a fork's parent means the lineage edge.
- **The delta is stored on `idea.mutation_delta`** (`0005`, `SCHEMA.md` §1d) — nullable, and only a
  `FORK` may carry one (a column `CHECK`, so the rule is in the schema). It is **write-only** in the MVP:
  §3.1's `Idea` has no `mutation_delta` field, so §4.5 detail does not expose it.
- **Same-domain is set equality, order- and duplicate-insensitive.** The fork's domain set must
  **differ** from the parent's, so `F == P` is the `409`; a **superset differs** and is legal (the
  widening/flywheel case — `["health","compliance"]` forking `["health"]`). *Known gap:* the literal rule
  also admits a **subset** (`["health"]` forking `["health","compliance"]`, a narrowing); it is
  **accepted** here, and a stricter `reject iff F ⊆ P` is a recorded follow-up rather than implemented in
  this ticket.
- **Check order `422` → `404` → `409`.** The body is validated **before** the transaction opens (as at
  §4.2/§4.6); the two state checks — unknown id, then same-domain — run **inside** it, so a refused fork
  writes nothing and moves no revision.
- **Only `POST` on `{id}/fork` is a route.** `GET`/`DELETE` on `…/fork`, and any deeper path, are the
  `not_found` envelope (§2) — the rule §4.5/§4.6 record.

### 4.8 `DELETE /v1/ideas/{id}` — delete, orphan-with-warning
`200` → `{ "deleted": true, "id": "…" }`. Semantics (`FLOW.md` T26 / M3):
- a fork **child** keeps its `lineage_parent_id` (dangling parent ref, tolerated);
- an idea referenced as a **provenance source** leaves that ref dangling (tolerated) — the derived
  idea is **not** deleted and its spark stays `RESOLVED-*`.
The warning shown before delete is read from `referenced_by` in §4.5; the client is responsible for
surfacing it, the server does not block.

Readings this doc had not pinned (settled in V5 `#16`):

- **The idea's own rows go with it** — its `idea_version` rows, its descriptor-cache row, and its
  provenance edges — by `ON DELETE CASCADE` (`SCHEMA.md` §1b), so a delete is one statement and the rule is
  in the schema rather than at the call site.
- **A live `OFFERED` spark naming the idea is retracted.** A live offer is not history: it is a promise made
  from the vault's current state, and the state just changed. A **resolved** spark is history and keeps its
  (now dangling) pair. The retraction is scoped to the deleted idea's own offers.
- **Nothing is ever un-resolved** — the spark stays `RESOLVED-*` and is not re-offered, the `decision` row
  keeps its dangling `result_idea_id`, and no suppression is written (`FLOW.md` §5.4's permanence point).
- **An unknown `{id}`, and a repeat delete, are `not_found`.** Once the row is gone the id is unknown, and
  §2 answers that with `404`; the delete is not idempotent by design, because nothing needs it to be.
- **The delete is candidate-affecting** (`ARCHITECTURE.md` §4 names it), so it goes through the vault-write
  trigger: the revision stamps and a run enqueues in the same transaction. An unknown id writes nothing, so
  nothing stamps.
- **No request body is read, and only a `{id}` path is a route**: `DELETE /v1/ideas`, `/v1/ideas/`, or a
  deeper path is the `not_found` envelope (§2, as at §6 for the read path).

### 4.9 `GET /v1/sparks?state=offered` — deck read (S1)
`200` → `{ "sparks": [Spark, …] }` in **server order** (deck order = server order).
`state=offered` returns live offers only (`status = OFFERED`).

Readings this doc had not pinned (settled in K1 `#35`):

- **`state` is REQUIRED, and `offered` is its only value.** A missing or empty `state`, or any value
  outside the enum — the comparison is **case-sensitive**, so `?state=OFFERED` is not `offered` — is
  `422 validation_failed` (§2's mandatory field and §1's unknown enum are the same status for two
  reasons). This **departs from §4.4's "an absent filter means no restriction"** deliberately: `Spark`
  (§3.3) carries **no `status`**, so an unfiltered read is indistinguishable from an offers read — it
  would hand a caller resolved sparks with nothing marking them, against this endpoint's own "live
  offers only". The departure is here so it is a decision, not an accident.
- **Deck order is insertion order, oldest offer first** (`spark.rowid ASC`). This is a **departure from
  §4.4's** newest-first vault list (`created_at DESC, id DESC`): `spark.created_at` is
  second-resolution (§1), so it cannot separate two offers written in one run, and `rowid` is the same
  monotonic sequence W8's run reads use. Neither list should be "fixed" into agreement with the other.
- **The read is a read**: no engine state, no provider, and — unlike §4.10 — nothing computed. E0–E4 is
  §4.10's, in one place (`api/src/engine-state.ts`); the deck read does not re-derive it.
- **Live-only, and no cursor.** The body is bounded by what the engine has offered, not by a page: there
  is no pagination and no cursor, exactly as §4.4's list has none.

### 4.10 `GET /v1/sparks/state` — engine state (S1)
`200` → `EngineState` (§3.6). Provider-free.

Readings this doc had not pinned (settled in W8 `#33`):

- **One place, and it answers while the engine is down.** E0–E4 is computed once, here
  (`api/src/engine-state.ts`), and the readout reaches no provider — it must answer in exactly the state
  it exists to report (E4, `FLOW.md` §5.6).
- **The precedence ladder is `E0 → E4 → E1 → E2 → E3`.** E0 dominates all; E4 > E3 (the transient cause
  with Retry, never Exhausted); E1 is the reported state whenever a run is in flight, above E2.
- **E0 has two arms, and either one is "no pair is possible"**: `resolved_domains` below the floor — read
  through the same `vaultSummary` the S0 gate reads, never re-derived — **or** fewer than two ideas. The
  second arm is why this route, not the summary, owns E0: `VaultSummary` carries no idea count.
- **E1 is `PENDING` or `RUNNING`** — not `PENDING` alone, or §4.16's `202` would leave the client on
  E0/E2 until the worker claimed the run.
- **E4's signal is the most recent `spark_run` row `FAILED`, with nothing in flight.** A `DONE` row is
  informational even when its `error` carries the stale-run note (`discarded: …`), and a `RUNNING` row
  under a newer `FAILED` one still reads E1. Insertion order is the sequence — `spark_run` has no
  created-at and `started_at` is second-resolution (§1).
- **`unreviewed` is the count of `OFFERED` sparks in every state**, so a run in flight cannot blank the
  deck's count: the E1/E2 coexistence is the `state` field plus this truthful number.
- **`run` is the newest in-flight row, or `null`** — reported even where E0 dominates, since §3.6 defines
  the field by what is in flight and not by which state won.

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

Readings this doc had not pinned (settled in K1 `#35`):

- **The store is the notifier; the API is a subscriber.** The two processes share one SQLite file
  (`ARCHITECTURE.md` §1) and SQLite has no cross-process pub/sub, so the stream samples SQLite's own
  cross-connection change signal — `PRAGMA data_version` — and re-reads the deck (`liveOffers`, §4.9)
  and the state (`engineState`, §4.10) **only when that signal moves**. A commit on *any other*
  connection moves it: the worker's offer write, and the API's own `POST /v1/sparks/run` enqueue.
  A commit on the sampling connection itself does not (SQLite's documented semantics). The cadence is
  therefore a bound on **latency**, not a timer that emits: with nothing committed, no frame is sent.
- **The sampler is a second, read-only handle — never the API's `db`.** A connection is blind to its
  own commit, so a watcher on `db` would miss every change the API process itself makes — §4.16's run
  enqueue and every `vaultMutation` — and, with the worker down, "every change" would be silently
  narrower. Hence `createApp({ db, watchDb })`: `watchDb` is a second handle on the same file, used
  **only** to read `PRAGMA data_version`, and it **never writes**. (`:memory:` is a test-only path —
  a second handle there is a different database — so the sampler falls back to `db`; `api/src/index.ts`
  always passes a distinct handle.)
- **Connect primes, then states.** A subscriber's first frame is one baseline `state`, and the diff
  caches are primed from the current deck — so connecting does not replay the whole deck as `offer`
  frames. A client subscribes, then reads §4.9 for the deck; the stream carries the changes after.
- **Per-subscriber, live-only.** The sampler exists only while a client is connected: no subscriber
  means no sampling, no buffering and no replay. A `state` change with no client connected is simply
  not observed; a reconnecting client gets the baseline `state` and re-reads §4.9. Heartbeat comment
  frames (`: keepalive`) keep an intermediary from reaping an idle stream.
- **Auth is the `/v1` gate's, and it is a client constraint.** `EventSource` cannot set an
  `Authorization` header, so a client reaches this route with a `fetch`-stream, or falls back to the
  polling path above. K1 records the constraint; the client lane resolves it.

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

Readings this doc had not pinned (settled in W8 `#33`):

- **The request has no body, and none is read.** A body is ignored, not validated — there is nothing to
  validate.
- **It enqueues at the current revision and stamps nothing.** §4's stamp belongs to the *mutation* that
  changed the vault; a recompute runs at the revision it finds. A run that stamped would enqueue its own
  successor, forever (`ARCHITECTURE.md` §4 / I).
- **Idempotent per revision:** a repeat while a `PENDING` run exists at that stamp returns **the same**
  `run_id` rather than adding a second row.
- **Under the prefix, exactly two routes exist.** `/v1/sparks/state` (§4.10) and this one are the
  implemented paths; bare `/v1/sparks` (§4.9) and the unwritten §4.17 remain the `not_found` envelope.

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

The shapes below are not spelled out in `ARCHITECTURE.md` §6 — the first two are this doc's proposal
(confirm or correct before the client lane relies on them); the rest are settled and recorded here
rather than left to the implementation:

- **`referenced_by` on Idea detail (§4.5)** — the T26 delete warning ("names the affected forks / the
  derived ideas") needs *reverse* references; the contract exposes them on detail rather than inventing
  a dry-run delete.
- **`undoable` + the 409 rule (§3.5, §4.15)** — `FLOW.md` §5.4 leaves the undo window unspecified;
  the contract treats it as server policy and exposes only the resulting `undoable` flag.
- **Auth ordering, and the unknown path / method rule (settled in F4 `#11`)** — auth is checked
  **before** routing, for the whole `/v1` namespace (§1), and any path or method that is not a defined
  route is the `not_found` envelope (`404`): there is no third case. Both are observable behaviour
  `ARCHITECTURE.md` §6 does not state, so they are written down here.
- **The `/v1` namespace closes over path spelling (settled in V1 `#12`)** — the gate and the router
  share one normaliser (§1): percent-decode (failure-tolerant), then collapse runs of `/`. So
  `/v1%2Fideas` and `//v1/ideas` are `401` without a token, not `404`. The normaliser does **not**
  resolve `.`/`..`, so `/x/../v1/ideas` is gated by neither form — safe only because the router
  matches the same normalised string and no such spelling reaches a handler. Resolving dot segments
  would go in the one normaliser, or the closure reopens.
- **A pre-handler `400` is a limit, not a shape (recorded in V1 `#12`)** — a request line `llhttp`
  cannot parse (`FOO /v1/ideas`) is rejected by Node with a bare `400` *before* the handler, so it
  cannot carry the envelope. §2's shape holds for every request our code answers; making it universal
  needs a `server.on("clientError")` handler and a sixth status code §2 does not have. Recorded
  rather than papered over.
- **`POST /v1/ideas`, the seeded pair and the idempotent repeat (settled in V1 `#12`)** — §4.2 names
  a seeded save by "both present", so `origin_spark_id` and `decision_id` are **both-or-neither**:
  exactly one present is `422` (ignoring the half-present one would drop provenance silently). An
  unknown `origin_spark_id` is `404 not_found` (§2's "unknown … spark"). A repeat on `decision_id`
  writes nothing but returns the first `Idea` with the same `201` — §4.2's only named success.
- **The vault read path (settled in V2 `#13`)** — §4.4's list order, its exact-tag `domain` filter,
  first-occurrence-wins on a repeated key, and the `422` on a present-but-empty filter value, plus
  §4.5's `versions` / `lineage` / `provenance` / `referenced_by` orderings and its single-snapshot
  read, are recorded at the endpoints they belong to. Three readings belong here instead:
  - **`/v1/ideas/` and `/v1/ideas/a/b` are the `not_found` envelope.** This is F4's rule and not a new
    one — but the **client** router resolves `#/vault/` happily, so it is written down: the two must
    not be "fixed" into agreement.
  - **The list has no pagination in the MVP.** `{ "ideas": [ … ] }` is unbounded, so the client lane
    must not build a pager against a contract with no cursor.
  - **The normalised path is the router's input, so the encoded spellings route.** Once V2 implements
    `GET /v1/ideas`, `//v1/ideas` and `/v1%2Fideas` **reach it** with a token rather than falling
    through to the envelope. V1's note above is about the *gate* (they are `401` without one); routing
    matches the same normalised string, which is the point of having one.
- **The vault summary (settled in O2 `#22`)** — §3.2's readings (every `idea` row, the exact match, the
  distinct-cluster and distinct-tag counts, one snapshot, no write) and §4.3's (no query parameter, the
  ordinary gate and envelope) are recorded at the endpoints they belong to. One reading belongs here
  instead:
  - **`eligible` is the S0→S1 spread gate, and it is not E0.** E0 (`FLOW.md` §4.1) is the *engine's*
    state — `"fewer than 2 distinct resolved domains (or < 2 ideas)"` — computed in one place for the
    engine state readout, and T05/T06 have the client *evaluate* it. `VaultSummary` deliberately carries
    **no idea count**, so the S1 entry decision and the deck must read E0 from the engine state and
    **never from `eligible`**. A vault holding one idea with two clusters is `eligible: true` and still
    E0; recorded rather than papered over. *(Carried to `#24`.)*
- **The vault delete path (settled in V5 `#16`)** — §4.8's readings (what cascades, what dangles, the
  live-offer retraction, the `404` on an unknown or repeated id, the vault-write trigger) are recorded at
  the endpoint. Two readings belong here instead:
  - **The eight `REFERENCES idea(id)` are part of this contract's meaning**, and
    `SCHEMA.md` §1b restates them. A bare reference is *immediate* with `foreign_keys = ON`, so before
    `0003_reference_actions` the delete endpoint's semantics were not merely unstated — they were
    **unreachable**: no idea that had ever been captured could be deleted.
  - **A dangling ref is not a violation.** `PRAGMA foreign_key_check` is clean on every state §4.8
    produces; the refs that dangle are exactly the ones the schema no longer enforces.
- **`lineage_kind` has no `ITERATION` (settled in V3 `#14`)** — iteration writes a new `idea_version`
  row on the same node and creates no lineage edge (`FLOW.md` §2.3 L1), and the schema's FORK-parent
  `CHECK` already forbade the only parent-bearing form an `ITERATION` row could have had. `0004`
  narrowed the `CHECK` to `ROOT | FORK` and §3.1/§4.4 drop the value, so **`?lineage=ITERATION` is the
  `422 validation_failed` envelope** — an out-of-vocabulary filter value (§1), not a filter that
  matches nothing.
- **The iterate ordering (settled in V3 `#14`)** — **body validation precedes the id lookup**, so a
  malformed body on an unknown id is the `422 validation_failed` envelope, not `404 not_found`. The
  body contract is checked before any row is consulted — the same ordering as capture (§4.2) — and
  the alternative (id first) would make one malformed request *sometimes* `422` and *sometimes* `404`,
  decided by whether the id happened to exist. §4.6 records the endpoint's other readings. Pinned in
  `api/src/server.test.ts` — the malformed/unknown pair, so the ordering cannot silently flip.
- **The fork ordering, and the same-domain rule (settled in V4 `#15`)** — the check order is
  **`422` (body) → `404` (unknown id) → `409` (same domain)**: the body contract is checked first (the
  same ordering as §4.2/§4.6), and both state checks run **inside** the transaction, so a refused fork
  writes nothing. Same-domain is **set equality** (`F == P` → `409`, order- and duplicate-insensitive); a
  **superset** differs and is legal, and the **subset** the literal rule admits is a recorded **known gap**
  (a `reject iff F ⊆ P` follow-up), not implemented here. §4.7 records the endpoint's other readings.
  Pinned in `api/src/server.test.ts`.

- **The engine state read and the run surface (settled in W8 `#33`)** — §4.10 and §4.16 are implemented,
  and their readings live at the endpoints. One belongs here instead:
  - **`eligible` is the S0→S1 spread gate; E0 is the engine state.** §4.10's E0 reads the same
    `resolved_domains` through the same function, but it is **not** the same quantity: E0 adds the
    *"< 2 ideas"* arm, which `VaultSummary` deliberately cannot carry. A vault holding **one idea with two
    clusters** is `eligible: true` and still E0, so the client reads E0 from §4.10 and never derives it
    from the summary. *(Recorded from O2 `#22`; implemented in W8 `#33`.)*

- **The deck read (settled in K1 `#35`)** — §4.9's readings live at the endpoint, and two of them are
  deliberate **departures from this doc's own §4.4 precedent**: `state` is **mandatory** and
  `offered`-only (a `Spark` carries no `status`, so an unfiltered read cannot be told apart from an
  offers read), and the deck is **insertion-ordered, oldest first**, where §4.4's vault list is
  newest-first. §3.3 carries the derived-`domain_tags` reading. The endpoint answers **no** engine
  state: E0–E4 stays §4.10's, computed in one place, so the deck read cannot grow a second ladder.

---

*Frozen — Ari (AstroLab agent), 2026-10-13, issue **F4** (`#11`), branch `feat/f4-api-contract`;
carried and extended by **V1** (`#12`), branch `feat/v1-capture-api`; by **V2** (`#13`),
branch `feat/v2-vault-read-api`; by **O2** (`#22`), branch `feat/o2-vault-summary`; by **V5**
(`#16`), branch `feat/v5-delete-api`; by **V3** (`#14`), branch `feat/v3-iterate-api`; by **W8**
(`#33`), branch `feat/w8-run-surface`; and by the **#94 docs pass**, branch
`docs/94-e0-definition-scope`.*
