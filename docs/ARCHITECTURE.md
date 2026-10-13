# Architecture: Astrolab (MVP v1.0)

> **Status:** Merged on `main`.
> **Scope:** The technical design the PRD defers to. `docs/PRD.md` §4 names **no** technologies and
> re-homes every one here: *"a separate security/architecture document and ADRs."* This is it.
> **Grounded in the merged specs:** `docs/PRD.md` v2.0.0 · `docs/VISION.md` · `docs/FLOW.md` r3.3 ·
> `DESIGN.md` (Nightfall) · `README.md`.
> **Vocabulary:** the engine is **the Spark**; its outputs are **sparks**. *(Never "collision.")*

---

## 0. How to read this document

This document **does not add product opinion**. Every requirement it satisfies already exists in the PRD,
VISION, or FLOW; every technology choice here is a free variable the PRD deliberately left open (§4). Where a
choice is load-bearing it is recorded as an **ADR** in `docs/adr/` and summarised in §10.

**Two hard constraints inherited from the docs, not reinterpreted here:**

- **No vector database / ANN index in the MVP** (`PRD.md` §3.3 item 7). Candidates are compared directly at
  personal vault scale.
- **No user-facing similarity or retrieval surface** (`VISION.md` §8 item 4; `DESIGN.md` §7). Nothing the user
  sees scores, ranks, or explains the similarity of two ideas. Any closeness machinery is *selection-
  internal* (`PRD.md` §3.3 item 2).

**MVP posture:** single-user, single-tenant, private. Everything below is sized to one creator's vault
(hundreds of ideas, not millions), and to shipping the creative loop — *Capture → Spark → Fork* — not
*Build* (`PRD.md` §1.2).

---

## 1. System context & components

```
                       ┌─────────────────────────────────────────────┐
                       │                 Client (PWA)                │
                       │  React + TS · mobile-first · Nightfall      │
                       │  deck / vault / capture / lineage (S0–S6)   │
                       └───────────────┬─────────────────────────────┘
                                       │  HTTPS JSON  (bearer token)
                       ┌───────────────▼─────────────────────────────┐
                       │              API service (Node/TS)          │
                       │  vault CRUD · decisions · undo · export     │
                       │  spark read model · run status (E0–E4)      │
                       └───────┬───────────────────────┬─────────────┘
                               │ SQL (WAL, 2 writers)  │ enqueue run
                       ┌───────▼───────────┐   ┌───────▼─────────────┐
                       │  Store (SQLite)   │   │  Spark worker (TS)  │
                       │  ideas · lineage  │◄──┤  in-process queue   │
                       │  provenance ·     │   │  2-stage engine     │
                       │  sparks · decis.  │   └───────┬─────────────┘
                       └───────────────────┘           │ HTTPS (only on
                                                       │ a run, only the
                                       ┌───────────────▼─────────────┐
                                       │  AI-provider boundary       │
                                       │  interface + adapter (§5)   │
                                       └─────────────────────────────┘
```

| Component | Responsibility | Must NOT do |
| :--- | :--- | :--- |
| **Client (PWA)** | Render S0–S6 (`FLOW.md` §2.1); capture gestures; issue decisions with a `decision_id`; show engine state E0–E4. | Compute scores; hold the only copy of an idea; reach the AI provider directly. |
| **API service** | The vault: create/read/iterate/fork/delete, decisions, undo, export, vault summary, spark read-model, run status. | Call AI on any vault path. Block a vault request on a spark run. |
| **Spark worker** | Run the two-stage engine (§3) asynchronously; extract mechanisms; write spark candidates and suppressions. | Serve user requests; mutate idea content; run inline in the request path. |
| **Store (SQLite)** | One durable home for ideas, versions, lineage edges, provenance edges, sparks, decisions, suppressions, config. | Take a write without WAL + busy-timeout + retry (§9). |
| **AI-provider boundary** | One interface the worker depends on; a swappable adapter behind it. | See idea data outside a requested run; retain or train on it. |

**Deployment shape (MVP):** one host, three units — the **API service**, the **worker**, and the **SQLite
file** — plus an **outbound-only** dependency on the AI provider. The API and worker are two processes of one
codebase; the API owns vault-table writes and the worker owns spark-table writes, but **both open the same
SQLite file**, so writes are *serialized by SQLite's file lock*, not by a single process. The store runs in
**WAL mode** with a `busy_timeout` and bounded retry (§9, ADR-0001); every write is a short transaction.
Stateless service, state on disk and in the provider — no message broker (ADR-0004).

---

## 2. Data model (concrete)

SQLite (ADR-0001). Field names are the contract; types are indicative.

### 2.1 Idea and its history

```
idea(
  id                 TEXT PK,          -- opaque id (uuid)
  hypothesis         TEXT NOT NULL,    -- ≤ 280 chars (PRD §2)
  problem            TEXT NOT NULL,
  monetization       TEXT NOT NULL,
  domain_tags        TEXT NOT NULL,    -- JSON array; ≥ 1 (PRD §2: no domain ⇒ no spark)
  lineage_kind       TEXT NOT NULL,    -- ROOT | ITERATION | FORK
  lineage_parent_id  TEXT NULL,        -- FK idea(id); set only for FORK (single parent)
  status             TEXT NOT NULL,    -- ACTIVE | NEEDS_COMPLETION
  visibility         TEXT NOT NULL,    -- PRIVATE (MVP only)
  current_version    INTEGER NOT NULL,
  created_at, updated_at  TEXT
)

idea_version(                          -- iteration history, same node (PRD §3.2 item 1)
  idea_id  TEXT FK, version INTEGER, hypothesis, problem, monetization, domain_tags, created_at,
  PRIMARY KEY(idea_id, version)
)
```

- **Iteration** writes a new `idea_version` row and bumps `idea.current_version`; it creates **no** lineage
  edge (`FLOW.md` §2.3, L1).
- **Fork** inserts a new `idea` with `lineage_kind=FORK` and `lineage_parent_id` = the source. **Lineage is
  single-parent, forever** (`PRD.md` §2, §3.2 item 2).
- `NEEDS_COMPLETION`: a spark-derived idea whose mandatory fields could not be fully prefilled (`FLOW.md`
  §4.3, T27). It is **excluded from spark candidate selection** until complete (ADR-0002).

### 2.2 Provenance — explicitly **not** lineage

```
provenance_edge(
  derived_idea_id TEXT FK idea(id),    -- the accepted / inspired idea (a ROOT)
  source_idea_id  TEXT FK idea(id),    -- one of the two source ideas
  spark_id        TEXT,                -- the spark it came from
  PRIMARY KEY(derived_idea_id, source_idea_id, spark_id)
)
```

`PRD.md` §2 adds **Provenance** as a field distinct from Lineage; `FLOW.md` §2.3 makes the two relations
concrete. An accepted spark is a **ROOT** (`lineage_parent_id IS NULL`) that carries 0..N provenance edges.
Provenance is muted metadata on Idea Detail; it is **never** traversed as ancestry, and never surfaced as a
similarity signal. This is what closes decision **D1** (no two-parent fork). *Invariant:* **an idea that
bears provenance edges has no lineage parent** — `provenance-bearing ⇒ lineage_parent_id IS NULL`. Provenance
and lineage are mutually exclusive on a node; this is the rule that makes D1 hold for *every* idea, not only a
same-spark one.

### 2.3 Sparks, runs, decisions, suppression, mechanism cache

```
spark(
  id                  TEXT PK,
  idea_a_id, idea_b_id TEXT,           -- ordered ids; both FK idea(id)
  pair_key            TEXT,            -- canonical unordered key: min(a,b) || '|' || max(a,b)
  direction           TEXT,            -- the proposed idea (headline)
  claim               TEXT,            -- one–two lines, why it matters
  what_it_takes       TEXT,            -- expanded view
  first_step          TEXT,
  mechanism           TEXT,            -- extracted shared mechanism (internal; never surfaced)
  domain_distance     REAL,            -- internal score (§3)
  structural_alignment REAL,           -- internal score (§3)
  status              TEXT,            -- OFFERED | RESOLVED-ACCEPTED | RESOLVED-DISMISSED | RESOLVED-INSPIRED
  created_at          TEXT
)
-- partial unique index: at most one live offer per pair (§3.5)
--   CREATE UNIQUE INDEX ux_spark_live ON spark(pair_key) WHERE status = 'OFFERED';

idea_mechanism(                        -- per-idea descriptor cache (§3.3 step 1; W3)
  idea_id      TEXT PK,                -- one descriptor per idea
  descriptor   TEXT,                   -- JSON {verb, object_class, constraint, transferable_structure}
  source_hash  TEXT,                   -- hash of the idea text the descriptor was extracted from
  extracted_at TEXT
)

decision(                              -- one row per RESOLVING action (FLOW.md §4.3)
  id            TEXT PK,               -- === the client-supplied decision_id (FLOW.md §2.2)
  spark_id      TEXT FK spark(id),
  kind          TEXT,                  -- ACCEPT | DISMISS | INSPIRED
  result_idea_id TEXT NULL,            -- the root created by ACCEPT or a committed seeded save
  decided_at    TEXT
)
-- idempotency key IS the primary key: (spark_id, decision_id) is unique because `id` is
-- globally unique (== decision_id). A repeated insert is a no-op returning the first row.

spark_run(id TEXT PK, vault_revision INTEGER, status TEXT, started_at, finished_at, error TEXT)
                                         -- PENDING|RUNNING|DONE|FAILED
suppressed_pair(pair_key TEXT PK, reason TEXT, updated_at TEXT)          -- CLICHE|NOISE|DISMISSED
vault_meta(revision INTEGER)            -- monotonic; bumped on every vault mutation (§4)
config(key TEXT PK, value TEXT)                                          -- thresholds (§3.4)
```

**Status vocabulary** is `FLOW.md` §3's verbatim: a spark is `OFFERED`, then terminal `RESOLVED-ACCEPTED` /
`RESOLVED-DISMISSED` / `RESOLVED-INSPIRED` (H). There is no separate `ACCEPTED`/`INSPIRED` spelling.

- **Mechanism cache** (`idea_mechanism`): one descriptor per idea, keyed by `idea_id`; `source_hash` is a
  hash of the idea's text, so extraction is re-run only when the text changes (§3.3 step 1, W3). The
  descriptor and its cache are internal and **never surfaced**.

- **`decision_id` idempotency** (`FLOW.md` §2.2, §4.3): the client generates `decision_id`, **persists and
  reuses it on retry**. The primary key on `id` (the client-supplied `decision_id`) plus an upsert makes a
  raced swipe+tap or a retry a **single** decision — the second write is a no-op returning the first result.
  *This is the mechanism that makes "commits exactly once" true.*
- **Provenance write on ACCEPT / committed INSPIRE** is transactional with the `idea` insert and the `spark`
  status change (one SQLite transaction).

### 2.4 Domain vocabulary (for distance)

```
domain_cluster(id TEXT PK, name TEXT, adjacency TEXT)   -- JSON: {other_cluster_id: hops}
domain_map(tag TEXT PK, cluster_id TEXT)                -- free-text tag → cluster
```

A small shipped taxonomy (§3.2). Not an embedding store; not queryable by similarity.

**Why SQLite:** single user, one file, relational edges (lineage, provenance, idempotency constraint),
trivial file-level backup and export (NFR-D1), and **no vector index** (PRD §3.3 item 7). Postgres is the
documented scale-out path once multi-user ships (`PRD.md` §6) — ADR-0001.

---

## 3. Spark engine

The engine turns a vault into offered sparks. It is **selection-internal**: it computes two axes, uses them to
*choose*, and never surfaces either (`PRD.md` §3.3 items 2–4). It runs entirely in the **worker**, never in the
API path (NFR-A1/P1).

### 3.1 Two-stage, ANN-free, O(N + gated) AI calls

| Stage | Where | AI? | Cost |
| :--- | :--- | :-- | :--- |
| **Extract** | once per idea, cached | **yes** (1 call) | O(N) calls, re-run only when an idea's text changes |
| **Gate** | local, deterministic | no | O(N²) comparisons — fine at personal scale |
| **Adjudicate** | once per **gated** pair | **yes** (1 call) | O(pairs that pass the gate) |

This is the key sizing decision (ADR-0002): AI cost is **O(N + gated)**, not O(N²). The O(N²) work is a
cheap local filter, which is exactly what "compares pairs directly" (`PRD.md` §3.3 item 7) permits. "Gated" is the
set that clears both thresholds — bounded well below N² by the gate, and the quantity the thresholds tune.

### 3.2 Axis 1 — domain distance (deterministic, worker-only)

**Capture never calls the boundary (A).** `POST /v1/ideas` stores each domain tag **raw**. All clustering
happens in the **worker**, during a run:

1. **Map (deterministic first):** each tag present in the shipped `domain_map` resolves to a **cluster** with
   no AI. A tag not in the map is **provisional** — it is its own cluster until the worker normalises it.
2. **Normalise (worker, AI, cached):** an unmapped tag is normalised to the nearest cluster by an AI call and
   written back to `domain_map`, so it is paid for **once per distinct tag**, never per pair and never on the
   vault path.
3. **Distance** = **taxonomy hops** between the two ideas' clusters (`domain_cluster.adjacency`); `0` for
   same-cluster. Two ideas whose every tag resolves to one cluster are **same-domain** → cliché
   (`PRD.md` §3.3 item 3).

**The `x/3` summary stays AI-free.** `GET /v1/vault/summary` returns **two** deterministic counts from
`domain_map` alone: **resolved** clusters (tags present in the shipped seed map) and **provisional** clusters
(unmapped tags, each its own). It never blocks on the provider, and the worker's later normalisation can only
*collapse* provisional tags into a cluster — never split one — so **`resolved` is monotone non-decreasing**
(A).

**The spread gate and `x/3` read `resolved` only (R1).** An unmapped tag is **provisional** and never opens
the gate: two raw tags that both normalise to one cluster (`#fintech` + `#banking`) would otherwise read as
"2 domains", open the S0→S1 exit, then collapse — onboarding the user straight into an **E0 Cold** vault, the
exact class `FLOW.md` **H2** fixed. Gating on `resolved` makes the gate and the post-run `E0` count the
**same** quantity, so a pass cannot be false.

**S0 domain input is drawn from the shipped taxonomy (R1, option a), plus an `Other → free text` escape
(owner-approved, 2026-10-13).** Onboarding capture picks each mapped domain from the shipped cluster taxonomy
(a picker), so every **picked** S0 tag is **resolved** deterministically and the gate is reachable with **no run
and no AI**; a typed `Other` lane is **provisional** — its own cluster, and it **never opens the gate** —
normalised by the worker once, on the first run. Free-text domain input remains available from **S3 onward**,
where a provisional cluster is harmless — the vault is already warm and has run once. This changes the S0 input
contract, so it is logged as `FLOW.md` spec touches in §12 (§12 item 6).

No embeddings, no ANN — a small curated table. Domain is "the axis along which distance is measured"
(`PRD.md` §2), and this measures it deterministically on the vault path.

### 3.3 Axis 2 — structural alignment (AI-extracted, locally compared)

1. **Extract** (Stage 1): one AI call per idea returns a normalised **mechanism descriptor** — a small
   structured object, e.g. `{verb, object_class, constraint, transferable_structure}` — cached in
   `idea_mechanism`. This is "identifying each idea's transferable structure" (`PRD.md` §3.3 item 6).
2. **Gate**: alignment = a deterministic similarity over the two descriptors (normalised field/token match).
   Pairs must clear **both** `min_domain_distance` and `min_alignment` (`config`).
3. **Adjudicate** (Stage 2, AI): for pairs that pass the gate, one call confirms the shared mechanism is real
   *and* yields the spark's **direction / claim / first step / what it takes** (`PRD.md` §3.3 item 4). Pairs the
   model rejects become **suppressed (noise)**.

### 3.4 Thresholds

`domain_distance` / `alignment` cut-offs live in `config`, seeded with defaults and tuned empirically
(`PRD.md` §3.3 item 3: *"tuning parameters, not fixed requirements"*). Changing a threshold never changes the
schema or the API.

### 3.5 Cliché / noise suppression and re-offer rules

- **Cliché** (high alignment, low distance) and **noise** (high distance, low alignment) are dropped by the
  gate — the two quadrants the product exists to avoid (`VISION.md` §3).
- A **dismissed** pair is written to `suppressed_pair`; it is **not re-offered unchanged**
  (`PRD.md` §3.3 item 5). A materially changed vault may surface a *different* pair (`FLOW.md` §5.3).
- An **accepted** pair is retired from the deck; only **one live offer per pair** exists (`spark` unique key).
- Ideas with `status = NEEDS_COMPLETION` or **no domain** are excluded from candidate generation
  (`PRD.md` §2).

---

## 4. Async pipeline & degradation (NFR-A1, NFR-P1)

**Trigger.** Any vault mutation that can change the candidate set (create / complete / iterate / fork /
delete) stamps `vault_meta.revision` (monotonic) and enqueues a **spark run** (§4) carrying that revision. The
mutation itself commits and returns **immediately** — it never waits on the engine (NFR-P1).

**Run lifecycle & idempotency (I).** `PENDING → RUNNING → DONE | FAILED`, each run tagged with the
`vault_revision` it was cut from. A run is **idempotent per revision**: if `vault_meta.revision` has advanced
past a run's stamp, that run is stale — its results are discarded and a newer run supersedes it, rather than
queueing behind it. Re-running the same revision reproduces the same candidates.

**Delivery & the bound (N, F).** `GET /v1/sparks/state` (E0–E4) and `GET /v1/sparks?state=offered` are the
read model; the client **subscribes** to run progress on `GET /v1/sparks/events` (SSE), with a **polling
fallback** (bounded backoff, only while state = E1). New offers therefore surface **on the event, not on a
timer**; the deck is never blocked waiting.

> **Bounded delivery (NFR-P1 target):** with a responsive provider, a run completes **p95 ≤ 60 s for a vault
> of ≤ 500 ideas**; if the provider is slow or down, the run fails per the matrix below rather than holding
> the bound. This is the number the timed test asserts.

**Degradation matrix** (`FLOW.md` §5.6):

| Failure | Vault | Deck (S1) | Recovery |
| :--- | :--- | :--- | :--- |
| AI provider down / times out | **fully available** — capture, read, iterate, fork, delete | **E4 Unavailable** (quiet + Retry); already-offered sparks stay reviewable | run marked `FAILED`; Retry re-enqueues |
| Run fails mid-way | unaffected | previous offers remain | new run supersedes |
| Network error client↔API | — | non-destructive error, **Retry** | no committed idea lost (NFR-D1) |

**The load-bearing rule (NFR-A1):** *no vault code path calls the AI boundary.* Enforced by module boundary —
the vault module has no import of the provider interface — and verified by a fault-injection test that
disables the provider and runs the vault suite (ADR-0004).

---

## 5. AI-provider boundary (NFR-PRIV1)

**One interface, one adapter.** The worker depends on an interface, not a vendor SDK:

```
interface MechanismExtractor { extract(idea): MechanismDescriptor }   // §3.3 step 1
interface SparkAdjudicator   { adjudicate(ideaA, ideaB, mechanisms): SparkDraft | null }  // §3.3 step 3
```

**Model choice.** The adapter is configured by env (`AI_PROVIDER`, `AI_MODEL`); MVP pins one hosted
frontier-class chat model behind the adapter, chosen for structured-output reliability at low volume. The
exact model is a **config value**, re-pointable without code change — the ADR records the *class* and the
contract, not a vendor lock (ADR-0003).

**Output contract.** Both calls request **structured output** (JSON) validated against a schema before storage;
invalid output = a failed call, retried per §4, never stored.

**Privacy (NFR-PRIV1).**
- **Only the operation's payload is sent:** the idea text needed for extraction, or the two ideas' text +
  descriptors for adjudication. No account identity, no vault listing, no unrelated ideas.
- **No training, no retention — enforced by routing, not assumed.** Every worker call sets
  `provider: { zdr: true }` (equivalently `data_collection: "deny"`), so OpenRouter routes only to endpoints it
  classifies as Zero Data Retention — which "are also unable to train on your data." OpenRouter itself stores
  no prompt content unless prompt logging is opted in; *Private Input & Output Logging* and *OpenRouter Use of
  Inputs/Outputs* stay off (both default off). Residuals, stated not hidden: OpenRouter's per-endpoint ZDR
  classification is **provider-attested, not independently audited**; request **metadata** (tokens, latency —
  not content) is always stored; OpenRouter is itself an intermediary that transiently sees the prompt.
  Verified by asserting `provider.zdr=true` on every call and capturing `GET /api/v1/endpoints/zdr` at build
  time.
- **No third-party transmission beyond a requested operation:** the engine runs only when a vault mutation
  requests it; there is no background telemetry or periodic upload.

---

## 6. Surface / API contract

HTTP/JSON, bearer-authenticated. Endpoints map 1:1 to `FLOW.md` surfaces; decision semantics are
`FLOW.md` §4.3.

| Surface (`FLOW.md`) | Endpoint | Notes |
| :--- | :--- | :--- |
| **S0** Onboarding | `POST /v1/ideas` · `GET /v1/vault/summary` | capture is **domain-mandatory** (T02); the S0 domain input is a **pick from the shipped taxonomy plus an `Other → free text` escape** — picked tags resolve deterministically (**no AI on this path**, §3.2); a typed lane is **provisional** and never opens the gate; summary returns `domains covered` = the **resolved** cluster count (§3.2) |
| **S0 → S1** exit | — | gate on **≥ 2 resolved domains** (T04); client computes the gate from the summary's `resolved` count only (R1) |
| **S1** Sparks deck | `GET /v1/sparks?state=offered` · `GET /v1/sparks/state` · `GET /v1/sparks/events` (SSE) | `state` = E0–E4 (§4). Deck order = server order. Events stream new offers (N) |
| **S1b** Spark detail | `GET /v1/sparks/{id}` | direction / claim / what-it-takes / first-step / tags. **No scores, no similarity readout** |
| **decision** | `POST /v1/sparks/{id}/decision` `{decision_id, kind: ACCEPT\|DISMISS}` | idempotent on `(spark_id, decision_id)`; returns the created idea id for ACCEPT |
| **INSPIRE (open seeded capture)** | `POST /v1/sparks/{id}/inspire` | **not a resolution** — writes no `decision`; returns the seed payload; the spark stays `OFFERED` until a committed seeded save (B) |
| **undo** | `POST /v1/decisions/{decision_id}/undo` | one step; within window; retracts derived idea + provenance, re-offers. Covers ACCEPT, DISMISS **and a committed seeded save** — which carries its own `decision_id` (C). `409` if not reversible (`FLOW.md` §5.4) |
| **S2** Capture | `POST /v1/ideas` (blank, or **seeded** with `{origin_spark_id, decision_id}`) | mandatory-field validation; a seeded save writes its `decision` row (kind=INSPIRED) **transactionally** and is idempotent on `decision_id` (D); 280-char counter client-side, enforced server-side |
| **S3** Vault | `GET /v1/ideas?domain=&lineage=&status=` | |
| **S4** Idea detail | `GET /v1/ideas/{id}` | fields + lineage chain + provenance (muted) |
| **S6** Iterate | `POST /v1/ideas/{id}/iterate` | new version, same node |
| **S5** Fork | `POST /v1/ideas/{id}/fork` `{mutation_delta, domain}` | rejects same-domain (offers Iterate), `FLOW.md` T25 |
| **delete** | `DELETE /v1/ideas/{id}` | orphan-with-warning; fork children keep parent ref; provenance source ⇒ dangling ref (`FLOW.md` T26) |
| **Recompute** | `POST /v1/sparks/run` | enqueues a run (E1) |
| **Export** | `GET /v1/export` | NFR-D1 (§8) |

**`decision_id` persist-and-reuse** (`FLOW.md` §2.2, N4): for **every resolving action — ACCEPT, DISMISS, and
a committed seeded save** — the client generates the id, persists it, and reuses it on retry; the server treats
a repeated `(spark_id, decision_id)` as the same decision. *(FLOW §2.2 spells out ACCEPT/DISMISS and §5.4/N3
already extends undo to the committed seeded save; this document gives that save the same client-generated
`decision_id`, written at commit. A one-line FLOW §2.2 clarification is a recommended follow-up — not a
contradiction, since FLOW §5.4 already requires the capability.)*

**Invariants the API enforces (not the client):** domain-mandatory capture; single-parent lineage; provenance
≠ lineage; at most one live offer per pair; mandatory-field validation on every write.

---

## 7. Bootstrap

- **Domain-mandatory capture** (`FLOW.md` T02; `PRD.md` §2): `POST /v1/ideas` rejects an idea with no domain.
  An idea without a domain cannot take part in a spark, so allowing one would silently defeat the bootstrap.
- **Spread gate** (`FLOW.md` T04; `PRD.md` §3.4 item 2 / NFR-U1): the onboarding exit is available at **≥ 2
  distinct *resolved* domains** (the spark floor, §3.2), with S0 domain input drawn from the shipped taxonomy
  (plus the `Other → free text` escape) so the count is deterministic and AI-free; `≥ 3` is shown as `x/3`
  **progress**, not a gate. A provisional (unmapped or typed) tag never counts toward the gate — see R1, §3.2.
- **No synthetic seeds, no note import** (`PRD.md` §3.4 item 3): neither the engine nor the API generates ideas
  on the user's behalf.

---

## 8. Portability (NFR-D1)

**Export — open, portable, complete.** `GET /v1/export` returns a single **JSON** document (UTF-8):
`{schema_version, exported_at, ideas[], idea_versions[], lineage_edges[], provenance_edges[], decisions[],
domain_tags[]}`. It is self-describing and dependency-free — no vendor format, no proprietary ids required to
read it. Every committed idea is present (`NFR-D1`).

**Backup / restore.** The store is a single SQLite file: backup = checkpoint WAL + copy the file; restore =
replace the file and run migrations forward. **No committed idea is lost** on either path.

**Verification.** A backup→wipe→restore test and an export→re-import round-trip test, both asserting idea
counts and lineage/provenance edges survive.

---

## 9. Stack & security posture

**Stack (MVP), one language across the client and server:**

| Layer | Choice | Rationale |
| :--- | :--- | :--- |
| Client | **React + TypeScript, Vite, mobile-first PWA** | `DESIGN.md` is *"shadcn-based"* (it names no framework) — React is the implementation inference (ADR-0005); a PWA ships the mobile-first deck without app-store overhead; one language with the server |
| API | **Node + TypeScript**, HTTP/JSON | same language as the client; small surface; portable contract |
| Worker | **Node + TypeScript**, in-process queue | no broker for a single user (ADR-0004) |
| Store | **SQLite**, one file, two writers (API + worker) | WAL + `busy_timeout` + bounded retry (§9); §2.4; ADR-0001 |
| AI | **hosted model behind an adapter** | §5; ADR-0003 |

**Security posture.**
- **Single-tenant by construction.** The MVP is one user (`PRD.md` §1.3), so there is no tenant boundary to
  enforce; `PRD.md` §4 deliberately removed row-level security as a non-requirement. Multi-user isolation is
  future scope (`PRD.md` §6) and is where RLS/tenancy would be introduced — not here.
- **Concurrency (E).** SQLite gives **one file-wide write lock**, so the API and worker writers serialize — they
  are *not* a single writer. The store runs in **WAL mode** (readers don't block the writer), with
  `busy_timeout` (e.g. 5 s) and **bounded retry-with-backoff** on `SQLITE_BUSY`; every write is a short
  transaction. This is the correct MVP posture for two processes on one file; if write contention ever
  appears, the fallback is to funnel all writes through one process (ADR-0001).
- **Auth.** Bearer token over HTTPS; secrets in env, never in the repo.
- **Data at rest.** Private by default (`visibility = PRIVATE`); encryption at rest is deferred
  (`PRD.md` §6), noted rather than claimed.
- **AI boundary.** Outbound-only, operation-scoped, no-training / zero-retention (§5).
- **Least data.** The provider sees the two ideas in a run, nothing else.

---

## 10. ADRs

Load-bearing decisions, one file each, in `docs/adr/`:

| ADR | Decision | Closes |
| :--- | :--- | :--- |
| **0001** | SQLite as the MVP store; Postgres as the scale-out path | §2.4, NFR-D1 |
| **0002** | Two-stage, ANN-free spark engine; AI cost O(N + gated) | §3, PRD §3.3 item 7 |
| **0003** | One AI-provider interface + swappable adapter; structured output; no-training/zero-retention | §5, NFR-PRIV1 |
| **0004** | Async in-process queue; vault code never imports the AI boundary | §4, NFR-A1/P1 |
| **0005** | Client = React/TS mobile-first PWA (one language with the server) | §9 |

---

## 11. NFR traceability

Every non-functional requirement in `PRD.md` §4 → a design element and its verification method.

| NFR | Requirement | Design element | Verification |
| :--- | :--- | :--- | :--- |
| **A1** Availability | Vault works without the Spark | Vault module has no dependency on the AI boundary (§4, §9); engine is a separate worker (§1) | **Fault injection:** disable the provider, run the vault suite — capture/read/iterate/fork/delete pass; S1 shows E4 |
| **P1** Performance | Sparks async, never block vault; bounded delivery | Mutation commits then enqueues a run (§4); client reads state/SSE, never waits. Bound: **p95 ≤ 60 s at ≤ 500 ideas** with a responsive provider (§4) | **Timed test** with injected AI delay/failure — vault request latency unchanged; sparks delivered within the bound |
| **D1** Durability/Portability | No idea lost; open export | SQLite + WAL; `GET /v1/export` JSON (§8) | **Backup→wipe→restore** + **export round-trip** tests |
| **PRIV1** Privacy | No training; no third-party transmission beyond a requested op | Operation-scoped payloads; **ZDR routing control** (`provider: { zdr: true }` on every call); no telemetry (§5) | **Data-flow audit** (grep the boundary; assert one call site per operation) + **routing control**: assert `provider.zdr=true` on every call; capture `GET /api/v1/endpoints/zdr` at build time |
| **Q1** Quality | Spark quality instrumented (acceptance proxy) | `decision` records kind + whether the accepted idea landed in a **new domain** (§3.5, §5 metrics) | **Instrumentation test** + reporting query over `decision` |
| **U1** Usability | New user onboards spanning domains | Domain-mandatory capture (S0 picks from the shipped taxonomy) + `≥ 2`-**resolved**-domain spread gate with `x/3` progress (§3.2, §7) | **Onboarding completion test** (assert ≥ 2 distinct **resolved** domains at exit; and assert `E0` is not Cold on the first run) |

---

## 12. Open questions (for the reviewer / owner)

1. ~~Hosted vs local model.~~ **Resolved — hosted (owner, 2026-10-13).** Provider: **OpenRouter**; initial model
   **`deepseek/deepseek-v4-flash`** (env-overridable: `AI_PROVIDER` / `AI_MODEL`). A local/on-device model
   remains a drop-in adapter later — it would strengthen NFR-PRIV1 at higher operational cost; **not** MVP.
   **NFR-PRIV1 sub-item — closed by routing, not a vendor term (Max's verdict 2026-10-13; numbers
   re-verified by David).** Every call pins `provider: { zdr: true }`, so OpenRouter routes only to endpoints it
   classifies Zero Data Retention; retention depends on the **routed endpoint**, not on DeepSeek's terms. The
   provider choice is unchanged and **needs no paid tier** (ZDR is a request/account setting). §5, §11 and
   ADR-0003 state the one rule; the control is **provider-attested, not independently audited** (§5).
2. **Mechanism descriptor schema.** The exact fields of the descriptor (§3.3) are a tuning artifact; the
   contract (structured, cached, locally comparable) is the decision. Confirm the field set with the first
   calibration run.
3. **Cold-start ordering.** Whether onboarding triggers the first run automatically or on "See your sparks"
   is a UX call already implied by `FLOW.md` T04; noted for completeness.
4. ~~FLOW §2.2 wording.~~ **Landed in `FLOW.md` r3.2.** The committed seeded save carries the same client-generated
   `decision_id` as a deck decision (§6) — FLOW §5.4/N3 already required the capability and the one-line FLOW
   §2.2 clarification is in the spec (r3.2).
5. ~~FLOW §4.3 / T27 — "Good" polish prompt.~~ **Landed in `FLOW.md` r3.2.** Q1 resolved (David, 2026-10-12): an
   un-prefillable Good is saved **needs-completion**, held out of candidate selection, **and** the system
   actively **prompts the user to polish** at the right moments — stated in the spec, not only the exclusion
   (§4.3 step 4, T27, §6 Q1). Owner override still open.
6. ~~FLOW §7 — S0 domain input contract (R1).~~ **Landed in `FLOW.md` r3.2 (picker) and r3.3 (escape).** The S0
   domain input is a **pick from the shipped taxonomy** — so the `≥ 2` gate counts resolved clusters
   deterministically — **plus an `Other → free text` escape**, owner-approved 2026-10-13, whose typed lane is
   **provisional** and never opens the gate; free-text domain input stays from **S3 onward**. Stated in `FLOW.md`
   T02 / §5.2 / §7; `FLOW.md` §6 Q6 is closed.

---

## 13. Revision history

- **2026-10-12 — r1.** Initial draft (11 sections + ADRs).
- **2026-10-12 — r2.** Adversarial review by Max (round 1) + David's confirmation. All 14 findings accepted:
  **A** (domain clustering moved to the worker; capture stores raw tags; `x/3` summary is deterministic —
  §3.2, §6), **B** (INSPIRE is not a decision; separate `POST /v1/sparks/{id}/inspire` — §6), **C/D** (the
  committed seeded save carries its own `decision_id`, writes its `decision` row transactionally, is
  idempotent and undoable — §2.3, §6), **E** (SQLite writer model: WAL + `busy_timeout` + retry, two writers
  — §1, §9, ADR-0001/0004), **F** (NFR-P1 bound quantified: p95 ≤ 60 s at ≤ 500 ideas — §4, §11), **G**
  (provenance invariant widened to `provenance-bearing ⇒ no lineage parent` — §2.2), **H** (status vocabulary
  = FLOW's `OFFERED` / `RESOLVED-*` — §2.3), **I** (`vault_meta.revision` + `spark_run.vault_revision` —
  §2.3, §4), **J** (O(N + gated) — §3.1), **K** (redundant unique dropped; PK is the key — §2.3), **L**
  (dangling §4.1 refs fixed), **M** (shadcn citation softened — §9, ADR-0005), **N** (SSE + polling fallback
  — §4, §6).
- **2026-10-12 — r2.1.** Residual **K** prose fix: dropped the stale `UNIQUE(spark_id, id)` phrase in §2.3 so
  the prose matches the schema (PK on `id` is the idempotency key). Logged the Q1 FLOW §4.3/T27 polish-prompt
  follow-up (§12 item 5).
- **2026-10-12 — r3.** Review round 2 residual **R1** closed (option a): **§3.2** now returns **resolved** and
  **provisional** cluster counts and the spread gate / `x/3` read **`resolved` only** — a provisional tag never
  opens the gate, so the gate and the post-run `E0` count are the same quantity and a false pass is
  impossible. **S0 domain input is a pick from the shipped taxonomy** (deterministic, AI-free; free-text from
  S3 on). Aligned **§6** (S0 row, S0→S1 exit), **§7** (spread gate) and **§11** (U1 verification: ≥ 2 distinct
  *resolved* domains, and E0 not Cold on first run). Added the `FLOW.md` §7 spec touch (§12 item 6).

- **2026-10-13 — r3.1.** Follow-up PR (docs-only, `docs/arch-escape`) recording owner decisions:

  - **§12 item 1 — resolved: hosted.** Provider **OpenRouter**, initial model **`deepseek/deepseek-v4-flash`**
    (env-overridable). **NFR-PRIV1 closed by routing, not a vendor term** (Max's verdict, re-verified by David):
    every call pins `provider: { zdr: true }` so routing is limited to ZDR-classified endpoints; the control is
    **provider-attested, not independently audited**, and no paid tier is needed (§5, §11).
  - **§5 / §11 / ADR-0003 — PRIV1 stated as one rule:** ZDR routing control (`provider: { zdr: true }`),
    verified by asserting `provider.zdr=true` on every call and capturing `GET /api/v1/endpoints/zdr` at build
    time; residuals stated (metadata stored; OpenRouter transiently sees the prompt).
  - **§3.2 / §6 / §7 — S0 `Other → free text` escape** (owner-approved 2026-10-13): a typed lane is
    **provisional** and never opens the spread gate; free-text from S3 on is unchanged.
  - **§12 reconcile** — §12 item 4 and §12 item 5 marked **landed in `FLOW.md` r3.2**; §12 item 6 marked **r3.2 (picker) +
    r3.3 (escape)**.
  - **ADR-0003** — provider pinned (OpenRouter + `deepseek/deepseek-v4-flash`); the zero-retention claim is
    stated as a **requirement under verification**, not as satisfied.
  - No schema, API, or state-machine change.

- **2026-10-13 — r3.2.** §2.3 gains the **`idea_mechanism`** table (per-idea descriptor cache: PK
  `idea_id`, JSON `descriptor`, `source_hash`, `extracted_at`). It was referenced by §3.3 step 1,
  ADR-0002 and W3 but missing from §2's table set; ruled an **omission** (not a later-stage migration),
  so it ships in the `0001_init` migration with **F3**. §2 now reads as the complete table set. No other
  schema, API, or state-machine change.

*Merged on `main` — Ari (AstroLab agent), 2026-10-12; latest revision r3.2, 2026-10-13. Review: adversarial passes by Max. Branch `docs/architecture`.*
