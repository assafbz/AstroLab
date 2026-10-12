# Architecture: Astrolab (MVP v1.0)

> **Status:** Draft for review — not yet merged.
> **Scope:** The technical design the PRD defers to. `docs/PRD.md` §4 names **no** technologies and
> re-homes every one here: *"a separate security/architecture document and ADRs."* This is it.
> **Grounded in the merged specs:** `docs/PRD.md` v2.0.0 · `docs/VISION.md` · `docs/FLOW.md` r3.1 ·
> `DESIGN.md` (Nightfall) · `README.md`.
> **Vocabulary:** the engine is **the Spark**; its outputs are **sparks**. *(Never "collision.")*

---

## 0. How to read this document

This document **does not add product opinion**. Every requirement it satisfies already exists in the PRD,
VISION, or FLOW; every technology choice here is a free variable the PRD deliberately left open (§4). Where a
choice is load-bearing it is recorded as an **ADR** in `docs/adr/` and summarised in §10.

**Two hard constraints inherited from the docs, not reinterpreted here:**

- **No vector database / ANN index in the MVP** (`PRD.md` §3.3.7). Candidates are compared directly at
  personal vault scale.
- **No user-facing similarity or retrieval surface** (`VISION.md` §8.4; `DESIGN.md` §7). Nothing the user
  sees scores, ranks, or explains the similarity of two ideas. Any closeness machinery is *selection-
  internal* (`PRD.md` §3.3.2).

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
                               │ SQL (one writer)      │ enqueue run
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
| **Store (SQLite)** | One durable home for ideas, versions, lineage edges, provenance edges, sparks, decisions, suppressions, config. | Be shared across processes for writes (single writer, §9). |
| **AI-provider boundary** | One interface the worker depends on; a swappable adapter behind it. | See idea data outside a requested run; retain or train on it. |

**Deployment shape (MVP):** one host, three units — the **API service**, the **worker**, and the **SQLite
file** — plus an **outbound-only** dependency on the AI provider. The API and worker are two processes of one
codebase sharing the store (single writer = the worker owns writes to spark tables; the API owns vault
writes). Stateless service, state on disk and in the provider — no message broker (ADR-0004).

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

idea_version(                          -- iteration history, same node (PRD §3.2.1)
  idea_id  TEXT FK, version INTEGER, hypothesis, problem, monetization, domain_tags, created_at,
  PRIMARY KEY(idea_id, version)
)
```

- **Iteration** writes a new `idea_version` row and bumps `idea.current_version`; it creates **no** lineage
  edge (`FLOW.md` §2.3, L1).
- **Fork** inserts a new `idea` with `lineage_kind=FORK` and `lineage_parent_id` = the source. **Lineage is
  single-parent, forever** (`PRD.md` §2, §3.2.2).
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
similarity signal. This is what closes decision **D1** (no two-parent fork). *Invariant:* no `idea` row may
have both a `lineage_parent_id` and provenance edges from the same spark.

### 2.3 Sparks, runs, decisions, suppression

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
  status              TEXT,            -- OFFERED | ACCEPTED | DISMISSED | INSPIRED
  created_at          TEXT
)
-- partial unique index: at most one live offer per pair (§3.5)
--   CREATE UNIQUE INDEX ux_spark_live ON spark(pair_key) WHERE status = 'OFFERED';

decision(
  id            TEXT PK,               -- === the client-supplied decision_id (FLOW.md §2.2)
  spark_id      TEXT FK spark(id),
  kind          TEXT,                  -- ACCEPT | DISMISS
  result_idea_id TEXT NULL,            -- the root created by ACCEPT
  decided_at    TEXT,
  UNIQUE(spark_id, id)                 -- the idempotency key
)

spark_run(id TEXT PK, status TEXT, started_at, finished_at, error TEXT)  -- PENDING|RUNNING|DONE|FAILED
suppressed_pair(pair_key TEXT PK, reason TEXT, updated_at TEXT)          -- CLICHE|NOISE|DISMISSED
config(key TEXT PK, value TEXT)                                          -- thresholds (§3.4)
```

- **`decision_id` idempotency** (`FLOW.md` §2.2, §4.3): the client generates `decision_id`, **persists and
  reuses it on retry**. The `UNIQUE(spark_id, id)` constraint plus an upsert makes a raced swipe+tap or a
  retry a **single** decision — the second write is a no-op returning the first result. *This is the mechanism
  that makes "commits exactly once" true.*
- **Provenance write on ACCEPT / committed INSPIRE** is transactional with the `idea` insert and the `spark`
  status change (one SQLite transaction).

### 2.4 Domain vocabulary (for distance)

```
domain_cluster(id TEXT PK, name TEXT, adjacency TEXT)   -- JSON: {other_cluster_id: hops}
domain_map(tag TEXT PK, cluster_id TEXT)                -- free-text tag → cluster
```

A small shipped taxonomy (§3.2). Not an embedding store; not queryable by similarity.

**Why SQLite:** single user, single writer, relational edges (lineage, provenance, idempotency constraint),
trivial file-level backup and export (NFR-D1), and **no vector index** (PRD §3.3.7). Postgres is the
documented scale-out path once multi-user ships (`PRD.md` §6) — ADR-0001.

---

## 3. Spark engine

The engine turns a vault into offered sparks. It is **selection-internal**: it computes two axes, uses them to
*choose*, and never surfaces either (`PRD.md` §3.3.2–3.3.4). It runs entirely in the **worker**, never in the
API path (NFR-A1/P1).

### 3.1 Two-stage, ANN-free, O(N) AI calls

| Stage | Where | AI? | Cost |
| :--- | :--- | :-- | :--- |
| **Extract** | once per idea, cached | **yes** (1 call) | O(N) calls, re-run only when an idea's text changes |
| **Gate** | local, deterministic | no | O(N²) comparisons — fine at personal scale |
| **Adjudicate** | once per gated pair | **yes** (1 call) | O(candidates passed by the gate) |

This is the key sizing decision (ADR-0002): AI cost is **O(N + surfaced)**, not O(N²). The O(N²) work is a
cheap local filter, which is exactly what "compares pairs directly" (`PRD.md` §3.3.7) permits.

### 3.2 Axis 1 — domain distance (deterministic)

1. At capture, each free-text domain tag is mapped to a **domain cluster** via `domain_map`; unknown tags are
   normalised to the nearest cluster (an AI call, cached — never per pair).
2. Distance = **taxonomy hops** between the two ideas' clusters (`domain_cluster.adjacency`); `0` for
   same-cluster. Two ideas whose every tag is in one cluster are **same-domain** and land in the cliché
   quadrant (`PRD.md` §3.3.3).

No embeddings, no ANN — a small curated table. Domain is "the axis along which distance is measured"
(`PRD.md` §2), and this measures it deterministically.

### 3.3 Axis 2 — structural alignment (AI-extracted, locally compared)

1. **Extract** (Stage 1): one AI call per idea returns a normalised **mechanism descriptor** — a small
   structured object, e.g. `{verb, object_class, constraint, transferable_structure}` — cached in
   `idea_mechanism`. This is "identifying each idea's transferable structure" (`PRD.md` §3.3.6).
2. **Gate**: alignment = a deterministic similarity over the two descriptors (normalised field/token match).
   Pairs must clear **both** `min_domain_distance` and `min_alignment` (`config`).
3. **Adjudicate** (Stage 2, AI): for pairs that pass the gate, one call confirms the shared mechanism is real
   *and* yields the spark's **direction / claim / first step / what it takes** (`PRD.md` §3.3.4). Pairs the
   model rejects become **suppressed (noise)**.

### 3.4 Thresholds

`domain_distance` / `alignment` cut-offs live in `config`, seeded with defaults and tuned empirically
(`PRD.md` §3.3.3: *"tuning parameters, not fixed requirements"*). Changing a threshold never changes the
schema or the API.

### 3.5 Cliché / noise suppression and re-offer rules

- **Cliché** (high alignment, low distance) and **noise** (high distance, low alignment) are dropped by the
  gate — the two quadrants the product exists to avoid (`VISION.md` §3).
- A **dismissed** pair is written to `suppressed_pair`; it is **not re-offered unchanged**
  (`PRD.md` §3.3.5). A materially changed vault may surface a *different* pair (`FLOW.md` §5.3).
- An **accepted** pair is retired from the deck; only **one live offer per pair** exists (`spark` unique key).
- Ideas with `status = NEEDS_COMPLETION` or **no domain** are excluded from candidate generation
  (`PRD.md` §2).

---

## 4. Async pipeline & degradation (NFR-A1, NFR-P1)

**Trigger.** Any vault mutation that can change the candidate set (create / complete / iterate / fork /
delete) enqueues a **spark run** (§4.1). The mutation itself commits and returns **immediately** — it never
waits on the engine (NFR-P1).

**Run lifecycle.** `PENDING → RUNNING → DONE | FAILED`. A run is idempotent per vault revision: a newer
mutation supersedes an in-flight run rather than queueing behind it.

**Delivery.** The client reads `GET /v1/sparks/state` (E0–E4) and `GET /v1/sparks?state=offered`. Offered
sparks appear as they are produced; the deck is never blocked waiting (NFR-P1).

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
- **No training, no retention:** the provider is used under a zero-retention / no-training term; the adapter
  asserts this in configuration and the claim is audited (NFR-PRIV1 verification).
- **No third-party transmission beyond a requested operation:** the engine runs only when a vault mutation
  requests it; there is no background telemetry or periodic upload.

---

## 6. Surface / API contract

HTTP/JSON, bearer-authenticated. Endpoints map 1:1 to `FLOW.md` surfaces; decision semantics are
`FLOW.md` §4.3.

| Surface (`FLOW.md`) | Endpoint | Notes |
| :--- | :--- | :--- |
| **S0** Onboarding | `POST /v1/ideas` · `GET /v1/vault/summary` | capture is **domain-mandatory** (T02); summary returns `domains covered` for the `x/3` readout |
| **S0 → S1** exit | — | gate on **≥ 2 domains** (T04); client computes the gate from the summary |
| **S1** Sparks deck | `GET /v1/sparks?state=offered` · `GET /v1/sparks/state` | `state` = E0–E4 (§4). Deck order = server order |
| **S1b** Spark detail | `GET /v1/sparks/{id}` | direction / claim / what-it-takes / first-step / tags. **No scores, no similarity readout** |
| **decision** | `POST /v1/sparks/{id}/decision` `{decision_id, kind: ACCEPT\|DISMISS}` | idempotent on `(spark_id, decision_id)`; returns the created idea id for ACCEPT |
| **INSPIRE** | `POST /v1/sparks/{id}/decision` `{decision_id, kind: INSPIRE}` | opens S2 seeded; spark stays OFFERED until a committed seeded save (T16) |
| **undo** | `POST /v1/decisions/{decision_id}/undo` | one step; within window; retracts derived idea + provenance, re-offers. `409` if not reversible (`FLOW.md` §5.4) |
| **S2** Capture | `POST /v1/ideas` (seeded or blank) | mandatory-field validation; 280-char counter client-side, enforced server-side |
| **S3** Vault | `GET /v1/ideas?domain=&lineage=&status=` | |
| **S4** Idea detail | `GET /v1/ideas/{id}` | fields + lineage chain + provenance (muted) |
| **S6** Iterate | `POST /v1/ideas/{id}/iterate` | new version, same node |
| **S5** Fork | `POST /v1/ideas/{id}/fork` `{mutation_delta, domain}` | rejects same-domain (offers Iterate), `FLOW.md` T25 |
| **delete** | `DELETE /v1/ideas/{id}` | orphan-with-warning; fork children keep parent ref; provenance source ⇒ dangling ref (`FLOW.md` T26) |
| **Recompute** | `POST /v1/sparks/run` | enqueues a run (E1) |
| **Export** | `GET /v1/export` | NFR-D1 (§8) |

**`decision_id` persist-and-reuse** (`FLOW.md` §2.2, N4): the client MUST persist the id before sending and
reuse it on retry; the server treats a repeated `(spark_id, decision_id)` as the same decision.

**Invariants the API enforces (not the client):** domain-mandatory capture; single-parent lineage; provenance
≠ lineage; at most one live offer per pair; mandatory-field validation on every write.

---

## 7. Bootstrap

- **Domain-mandatory capture** (`FLOW.md` T02; `PRD.md` §2): `POST /v1/ideas` rejects an idea with no domain.
  An idea without a domain cannot take part in a spark, so allowing one would silently defeat the bootstrap.
- **Spread gate** (`FLOW.md` T04; `PRD.md` §3.4.2 / NFR-U1): the onboarding exit is available at **≥ 2
  distinct domains** (the spark floor, §3.2); `≥ 3` is shown as `x/3` **progress**, not a gate.
- **No synthetic seeds, no note import** (`PRD.md` §3.4.3): neither the engine nor the API generates ideas
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
| Client | **React + TypeScript, Vite, mobile-first PWA** | `DESIGN.md` is shadcn/ui (React); a PWA ships the mobile-first deck without app-store overhead; one language with the server (ADR-0005) |
| API | **Node + TypeScript**, HTTP/JSON | same language as the client; small surface; portable contract |
| Worker | **Node + TypeScript**, in-process queue | no broker for a single user (ADR-0004) |
| Store | **SQLite** (WAL), single writer | §2.4; ADR-0001 |
| AI | **hosted model behind an adapter** | §5; ADR-0003 |

**Security posture.**
- **Single-tenant by construction.** The MVP is one user (`PRD.md` §1.3), so there is no tenant boundary to
  enforce; `PRD.md` §4 deliberately removed row-level security as a non-requirement. Multi-user isolation is
  future scope (`PRD.md` §6) and is where RLS/tenancy would be introduced — not here.
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
| **0002** | Two-stage, ANN-free spark engine; AI cost O(N + surfaced) | §3, PRD §3.3.7 |
| **0003** | One AI-provider interface + swappable adapter; structured output; no-training/zero-retention | §5, NFR-PRIV1 |
| **0004** | Async in-process queue; vault code never imports the AI boundary | §4, NFR-A1/P1 |
| **0005** | Client = React/TS mobile-first PWA (one language with the server) | §9 |

---

## 11. NFR traceability

Every non-functional requirement in `PRD.md` §4 → a design element and its verification method.

| NFR | Requirement | Design element | Verification |
| :--- | :--- | :--- | :--- |
| **A1** Availability | Vault works without the Spark | Vault module has no dependency on the AI boundary (§4, §9); engine is a separate worker (§1) | **Fault injection:** disable the provider, run the vault suite — capture/read/iterate/fork/delete pass; S1 shows E4 |
| **P1** Performance | Sparks async, never block vault; bounded delivery | Mutation commits then enqueues a run (§4.1); client reads state, never waits | **Timed test** with injected AI delay/failure — vault request latency unchanged; sparks delivered within the bound |
| **D1** Durability/Portability | No idea lost; open export | SQLite + WAL; `GET /v1/export` JSON (§8) | **Backup→wipe→restore** + **export round-trip** tests |
| **PRIV1** Privacy | No training; no third-party transmission beyond a requested op | Operation-scoped payloads; zero-retention/no-training adapter config; no telemetry (§5) | **Data-flow audit** (grep the boundary; assert one call site per operation) + **vendor-contract audit** |
| **Q1** Quality | Spark quality instrumented (acceptance proxy) | `decision` records kind + whether the accepted idea landed in a **new domain** (§3.5, §5 metrics) | **Instrumentation test** + reporting query over `decision` |
| **U1** Usability | New user onboards spanning domains | Domain-mandatory capture + `≥ 2`-domain spread gate with `x/3` progress (§7) | **Onboarding completion test** (assert ≥ 2 distinct domains at exit) |

---

## 12. Open questions (for the reviewer / owner)

1. **Hosted vs local model.** This design assumes a *hosted* provider for MVP simplicity. A local/on-device
   model would strengthen NFR-PRIV1 but raise the engine's operational cost. Owner call; the adapter makes it
   a swap, not a rewrite.
2. **Mechanism descriptor schema.** The exact fields of the descriptor (§3.3) are a tuning artifact; the
   contract (structured, cached, locally comparable) is the decision. Confirm the field set with the first
   calibration run.
3. **Cold-start ordering.** Whether onboarding triggers the first run automatically or on "See your sparks"
   is a UX call already implied by `FLOW.md` T04; noted for completeness.

---

*Draft — Ari (AstroLab agent), 2026-10-12. Review: adversarial pass by Max. Branch `docs/architecture`.*
