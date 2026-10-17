# Architecture: Astrolab (MVP) — the local-only rebuild

> **Status:** **v2** — the local-only rebuild (2026-10-17). **Supersedes v1's server design** (`docs/ARCHITECTURE.md`
> on `main` before this revision: one host, an API service, a worker process, SQLite-on-host, an AWS deploy).
> The product intent is unchanged; the deployment shape is gone.
> **Scope:** the technical design the PRD defers to. `docs/PRD.md` §4 names **no** technologies and re-homes every
> one here. This is it.
> **Grounded in the merged specs:** `docs/PRD.md` v2.0.0 · `docs/VISION.md` · `docs/FLOW.md` r3.8 ·
> `DESIGN.md` (Nightfall) · `README.md` · `docs/SCHEMA.md` · `docs/adr/`.
> **The increment that produced it:** the owner's in-channel call (`d178c664`), 2026-10-17 — *store app · all data
> on device · AI kept on the user's own API key · server tier + AWS deploy cancelled · rebuild, not reuse* — and
> David's re-triage (`0a14a749`).
> **Vocabulary:** the engine is **the Spark**; its outputs are **sparks**. *(Never "collision.")*

---

## 0. How to read this document

This document **does not add product opinion**. Every requirement it satisfies already exists in the PRD, VISION,
or FLOW; every technology choice here is a free variable those documents deliberately left open. Where a choice is
load-bearing it is recorded as an **ADR** in `docs/adr/` and summarised in §10. What survives from v1, and what is
deleted, is **§13's carry-over table** — the deliverable of this revision.

**Two hard constraints inherited from the docs, not reinterpreted here** — both unchanged by the rebuild:

- **No vector database / ANN index in the MVP** (`PRD.md` §3.3 item 7). Candidates are compared directly at
  personal vault scale.
- **No user-facing similarity or retrieval surface** (`VISION.md` §8 item 4; `DESIGN.md` §7). Nothing the user sees
  scores, ranks, or explains the similarity of two ideas. Any closeness machinery is *selection-internal*
  (`PRD.md` §3.3 item 2).

**MVP posture.** Single-user, single-tenant, private, **and now single-device**: everything below is sized to one
creator's vault (hundreds of ideas, not millions) running **inside one mobile app**, and to shipping the creative
loop — *Capture → Spark → Fork* — not *Build* (`PRD.md` §1.2).

---

## 1. System context & components

```
   ┌──────────────────────────────────────────────────────────────────────────┐
   │                        The app — one device, one process                  │
   │                                                                          │
   │   ┌────────────────────────────┐        ┌──────────────────────────────┐  │
   │   │  app/  (Expo · React Native)│        │  core/  (portable TS)        │  │
   │   │  S0–S6 screens · deck       │ calls  │  domain/   rules (pure)      │  │
   │   │  gestures · nav · tokens    │───────►│  vault/    use-cases         │  │
   │   │  export/import UI           │        │  store/    12-table SQLite   │  │
   │   │  secure store (key)         │        │  engine/   the Spark          │  │
   │   └───────────┬────────────────┘        │  provider/ the ONE AI boundary│  │
   │               │ injects                 └───────┬──────────┬───────────┘  │
   │               │ SqliteConnection (port)         │ SQL      │ HTTPS (only  │
   │   ┌───────────▼────────────┐        ┌────────────▼──────┐   │ on a run,   │
   │   │ expo-sqlite (device)   │        │ SQLite file       │   │ only the    │
   │   │ node:sqlite (tests/CI) │        │ (app sandbox)     │   │ run payload)│
   │   └────────────────────────┘        └───────────────────┘   │             │
   │                                                             │             │
   └─────────────────────────────────────────────────────────────┼─────────────┘
                                                                 ▼
                                          ┌───────────────────────────────────┐
                                          │  AI provider (OpenRouter)         │
                                          │  user's own key · provider.zdr=true│
                                          └───────────────────────────────────┘
```

**One process, one writer, no host.** The app owns the vault, the engine, and the provider call. There is no API
server, no worker process, no message broker, and no remote store. The only egress is the AI call, and only while
a run executes (§3, §5).

| Component | Responsibility | Must NOT do |
| :--- | :--- | :--- |
| **`app/`** (Expo · React Native) | Render S0–S6 (`FLOW.md` §2.1); capture gestures (swipe **and** 44px buttons); hold the bottom nav; render engine state E0–E4; host the export/import UI; hold the API key in the platform secure store. | Compute scores; reach the provider directly (it calls the engine, never the adapter); persist the key anywhere but the secure store. |
| **`core/domain/`** | Pure rules — capture validation, completion, lineage, spread gate, onboarding, deck state, run trigger. No IO, no framework. | Import `react`, `expo-*`, or the provider boundary. |
| **`core/vault/`** | The use-cases: create / read / iterate / fork / delete, decisions, undo, vault summary, spark read-model, export. | Call AI on any vault path; block a vault request on a spark run. |
| **`core/store/`** | The 12-table SQLite schema, migrations, and the writers. Opened through the `SqliteConnection` port. | Take a write outside a transaction; assume a second process. |
| **`core/engine/`** | Run the two-stage engine (§3) asynchronously; extract mechanisms; write candidates and suppressions. | Serve user requests; mutate idea content; run inline in a vault request. |
| **`core/provider/`** | The one AI boundary (§5): the interface, the OpenRouter adapter, the prompts, the schemas. | See idea data outside a requested run; retain or train on it. |

**The store connection is a port, and that is what keeps the suite.** `core/store` opens SQLite through a
`SqliteConnection` port with **two** adapters: `expo-sqlite` (the device) and `node:sqlite` (tests and CI). The
v1 `store`/`api` vitest suites run against the `node:sqlite` adapter **unchanged in substance**, which is what
makes L1 a *move*, not a rewrite (§13, row `store/src/**`).

**What retired** (the v1 deployment shape — detail and evidence in §13):

| Retired | Why |
| :--- | :--- |
| `api/` (HTTP service, bearer auth, error envelope, SSE) | no server, no transport; the route handlers become `core/vault/` calls (§6) |
| `worker/` (a process with an in-process queue) | the engine runs in the app process (§4); it is a module now, not a service |
| `store/`-on-host, `deploy/`, the CI deploy job, AWS | no host, no deploy |
| the two-writer concurrency model (WAL + `busy_timeout` + retry-for-`SQLITE_BUSY`) | one process writes the file; ADR-0001 is **amended**, not superseded (§10) |
| `client/` (Vite PWA) | the client is re-authored as Expo/RN; only its portable half survives, into `core/` (§13) |

---

## 2. Data model (concrete)

**Unchanged in substance.** SQLite, the same **twelve tables** of v1 §2.1–§2.4 plus `idea_mechanism`
(`docs/SCHEMA.md` is the schema of record and tracks them: `0001_init` … `0006_idea_new_domain`). Field names
remain the contract; `docs/SCHEMA.md` wins if it and this section disagree. The rebuild changes **where the file
lives and how it is opened**, not its shape:

- **One writer.** v1's file had two writer processes (the API owned vault tables, the worker owned spark tables)
  and leant on WAL + `busy_timeout` + retry to make that workable. The app is one process, so the writers are
  serialized by construction. The `SqliteConnection` port keeps `foreign_keys = ON` and a short-transaction write
  shape; the retry-with-backoff stays only as a harmless guard, and WAL is kept as a normal on-device setting
  (§9). *This is the whole of ADR-0001's amendment.*
- **The file lives in the app sandbox** — the platform's protected data directory — and is **excluded from
  platform backup** (§8). It is the vault's only copy.
- **Delete semantics (T26) are unchanged**: the row's owner cascades (`idea_version`, `idea_mechanism`,
  `provenance_edge`'s derived side), historical refs dangle (`lineage_parent_id`, the provenance *source* side, a
  spark's pair, `decision.result_idea_id`), and a live `OFFERED` spark named by the deleted idea is **retracted**.
- **The taxonomy** (`domain_cluster` + `domain_map`, §2.4 of v1) still ships as a curated table, seeded from
  `store/seed/domain-taxonomy.yaml`. Under the rebuild the seed and its consumer live in the **same** package
  (`core/`), which is what finally lets the S0 picker's mirror stop being a *mirror* (§13, the taxonomy rows).

The rest of v1 §2 — `idea` and its history, the lineage/provenance split and the **D1 invariant**
(`provenance-bearing ⇒ lineage_parent_id IS NULL`), sparks/runs/decisions/suppression, the
`ux_spark_live` partial unique index, the `decision_id` idempotency key — **carries forward verbatim.** Read v1
§2 or `docs/SCHEMA.md` for the DDL.

---

## 3. Spark engine

**Unchanged in substance** (ADR-0002 **stands**). The engine turns a vault into offered sparks. It is
**selection-internal**: it computes two axes, uses them to *choose*, and never surfaces either (`PRD.md` §3.3
items 2–4). What changes is **where it runs** and **whose meter it runs on**.

### 3.1 Two-stage, ANN-free, O(N + gated) AI calls

| Stage | Where | AI? | Cost |
| :--- | :--- | :-- | :--- |
| **Extract** | once per idea, cached in `idea_mechanism` | **yes** (1 call) | O(N) calls, re-run only when an idea's text changes |
| **Gate** | local, deterministic | no | O(N²) comparisons — fine at personal scale |
| **Adjudicate** | once per **gated** pair | **yes** (1 call) | O(pairs that pass the gate) |

AI cost is **O(N + gated)**, not O(N²); the O(N²) work is a cheap local filter (`PRD.md` §3.3 item 7). "Gated" is
the set that clears both thresholds.

### 3.2 Axis 1 — domain distance (deterministic, engine-only)

Unchanged from v1 §3.2: tags are stored **raw** on capture; clustering happens **in the engine, during a run**
(map deterministically from the shipped `domain_map`; a new tag is **provisional** — its own cluster — and is
normalised to a cluster by an AI call **once per distinct tag**, written back to `domain_map`); distance =
taxonomy hops, `0` for same-cluster.

The two v1 invariants carry forward: the `x/3` summary stays **AI-free** and reads `resolved` clusters only, and
**the spread gate and `x/3` read `resolved` only** (R1) — a provisional tag never opens the gate, so the gate and
the post-run `E0` count are the same quantity and a false pass is impossible. **S0 domain input is the shipped
taxonomy picker plus an `Other → free text` escape** (owner-approved 2026-10-13); a typed lane is provisional and
never opens the gate.

### 3.3 Axis 2 — structural alignment (AI-extracted, locally compared)

Unchanged from v1 §3.3: **Extract** → a normalised mechanism descriptor
`{verb, object_class, constraint, transferable_structure}` cached in `idea_mechanism`; **Gate** → a deterministic
similarity over the two descriptors, pairs must clear **both** `min_domain_distance` and `min_alignment`;
**Adjudicate** → one call per gated pair confirms the shared mechanism and yields the spark's
direction/claim/first-step/what-it-takes; a refusal is **suppressed noise**, not an error.

### 3.4 Thresholds

Unchanged. `domain_distance` / `alignment` cut-offs live in `config`, seeded insert-only. **`min_alignment` — W9
τ\* = `0.02`** (2026-10-15), the widened sweep's floor, seeded for coverage with precision **uncertified**; the
field set stays **CONFIRMED**. Basis on record: `W9_CALIBRATION.md` §6; v1 §3.4 carries the full argument and it is
not restated here. **One rebuild delta:** the seed now ships **in the app bundle** and is applied at first launch
(insert-only, so an existing install keeps its tuned value). And because `core/` holds both the seed **and** its
reader, the S0 picker reads the **seeded `domain_cluster` rows** rather than a mirror — `core/domain/taxonomy.ts`
keeps its types and the curated cluster ordering, and loses only the copied constant that existed to dodge a
cross-package import (§13.3).

### 3.5 Cliché / noise suppression and re-offer rules

Unchanged from v1 §3.5, including the **lineage exclusion** (`#141`): a pair whose two ideas are lineage-related
is excluded from candidate generation, because a fork copies its parent's mechanism verbatim while refusing a
same-domain fork, so the pair would clear both thresholds by construction.

---

## 4. Run lifecycle & degradation

The engine is asynchronous and **never blocks a vault write** (NFR-P1), and the vault works **with the provider
down and with no network at all** (NFR-A1).

### 4.1 Trigger and lifecycle

**Trigger.** Any vault mutation that can change the candidate set (create / complete / iterate / fork / delete)
stamps `vault_meta.revision` (monotonic) and enqueues a **spark run** carrying that revision. The mutation commits
and returns immediately.

**Enqueueing is a table write, not a call.** The mutation writes a durable `PENDING` `spark_run` row **inside its
own transaction** — it does **not** call into `core/engine`, which the NFR-A1 boundary forbids (§4.3). Recompute
(§6) takes the same shape. The app's engine driver *observes the table* and picks up the work. This is v1's own
mechanism (the one named exception to the API/worker split), and it is what makes the boundary guard satisfiable
rather than merely aspirational.

**The body may warm the extract cache; only the commit writes results.** The run body is side-effect-free *with
respect to the vault* — it writes no offer and no suppression. One deliberate exception, because it is not a
result: the **mechanism-extraction cache** (`idea_mechanism`) is keyed by `source_hash`, so it is a memo of a pure
function of the idea text and its write is valid at any revision. The body may persist it **incrementally, in its
own short transaction**, as each extract completes — otherwise a suspension mid-run would throw away every O(N)
extract call and the next foreground would re-pay all of them (P1). A stale run's cache writes are therefore
harmless; its *results* still never land (§4.1). What resume re-does is bounded to the **uncached extracts and the
adjudications**.

**Lifecycle.** `PENDING → RUNNING → DONE | FAILED`, each run tagged with the `vault_revision` it was cut from. A
run is **idempotent per revision**: if `vault_meta.revision` has advanced past a run's stamp, the run is **stale**
— its results are discarded and a newer run supersedes it. This is v1's model, unchanged, and it is the reason the
run's **body/commit split** carries forward verbatim: the body (gate → suppression → adjudicate) computes *what*
to write and **writes nothing**; the commit performs the writes **only when the run is current**. A stale run
therefore writes nothing at all.

**New to the rebuild — the run is resumable and foreground-bound.** v1's run lived in a long-lived worker process.
The app is suspended or killed by the OS at will, so:

- **Durable run state.** `spark_run` (status + `vault_revision`) is the resume point. A run interrupted by a
  suspension is re-entered on the next foreground; a `RUNNING` run that outlived its process is re-run, not
  resumed mid-call — the body is side-effect-free, so a re-run is safe.
- **Foreground only.** Mobile platforms do not grant sustained background execution. A run advances **only while
  the app is foregrounded**; a vault mutation with the app closed is picked up the next time the app opens. This
  is a **stated product constraint**, not a defect — it bounds NFR-P1 (§11).
- **Single-flight.** The press-scoped single-flight guard (`domain/run-trigger.ts`, O5) is unchanged: *See your
  sparks* runs; *Skip* does not; the S0→S1 exit never auto-runs.

### 4.2 Delivery

v1 delivered run progress over **SSE** (`GET /v1/sparks/events`) with a polling fallback. **Both retire** — there
is no server to poll and no second process to stream from. In their place, the engine emits **in-process events**
to the app (a plain subscriber callback): "run started / run finished / offers changed". The client renders E0–E4
exactly as before; E1 (Computing) is now driven by the in-process event rather than a stream. New offers surface
**on the event, not on a timer**, and the deck is never blocked waiting.

### 4.3 Degradation matrix

| Failure | Vault | Deck (S1) | Recovery |
| :--- | :--- | :--- | :--- |
| **No API key set / key invalid** *(new)* | fully available | **E4 Unavailable**, with copy that names the cause: *"Add your AI key to see sparks."* | user sets a key (secure store) → Retry |
| **Offline / provider unreachable** | fully available | **E4 Unavailable** (quiet + Retry); already-offered sparks stay reviewable | Retry re-enqueues on reconnect |
| **Provider down / times out / rate-limited (429)** | fully available | **E4 Unavailable** | run marked `FAILED`; Retry re-enqueues |
| **Provider blocked by browser CORS** *(web only)* | fully available | **E4 Unavailable** with a provider-specific reason, never a silent failure | L3's per-provider header map, or a native-only provider (§5) |
| **Run fails mid-way / app suspended** | unaffected | previous offers remain | next foreground re-runs; a stale run supersedes |
| **Local persistence error** | — | non-destructive error, **Retry** | no committed idea lost (NFR-D1, §8) |

**The load-bearing rule (NFR-A1):** *no vault code path calls the AI boundary.* Enforced by module boundary —
`core/vault/**` may not import `core/provider/**` — and verified by a fault-injection test that disables the
provider and runs the vault suite. **This is v1's guard, re-homed** (the v1 form guarded `api/` and `store/`
against `worker/src/provider`); see §13, row NFR-A1.

---

## 5. AI-provider boundary (NFR-PRIV1)

**One interface, one adapter** (ADR-0003, **amended** — same contract, now in the app, on the user's key). The
engine depends on an interface, not a vendor SDK:

```
interface MechanismExtractor { extract(idea): MechanismDescriptor }                        // §3.3 step 1
interface SparkAdjudicator   { adjudicate(ideaA, ideaB, mechanisms): SparkDraft | null }  // §3.3 step 3
interface TagNormalizer      { normalizeTag(tag, clusters): string }                      // §3.2 step 2
```

**Provider and model.** MVP pins **OpenRouter** (`AI_PROVIDER=openrouter`) and one hosted frontier-class chat
model (`AI_MODEL`), chosen for structured-output reliability at low volume; the model is a **config value**,
re-pointable without code change. The adapter is otherwise unchanged from v1 — the **request shape, the privacy
pin, and output validation** stay exactly as shipped.

**The one real change: the key is the user's, held on the device.** There is no server to hold a token, so the
app reads the key from the **platform secure store** and signs the device→provider call itself.

- **Key hygiene (a guard, not a promise).** The key must never reach the vault, the export, or a log. It is read
  from the secure store at call time and passed only into the transport. This is asserted structurally in L3:
  no module outside the provider adapter imports the key accessor, and the export codec is checked to be
  key-free. *(The v1 analogue — "the adapter has no DB access", asserted in prose and never checked — is the
  failure this guard exists to avoid.)*
- **Web has no secure store** *(verified, not assumed — Ari, 2026-10-17: `expo-secure-store` lists
  `android · ios · tvos · expo-go` and **no web**; `expo-sqlite` lists `web`)*. On web the key is therefore held
  **session-only, in memory**, and never persisted to `localStorage`/`IndexedDB`. The consequence is stated
  plainly: on a served origin the web build cannot promise a secret at rest; the user re-enters the key per
  session. **Native-first** — the store builds (iOS/Android) are the primary target; web is a constrained second
  target from the same codebase (§9).
- **Device→provider direct is a web-only fork, per provider** *(verified — Ari, 2026-10-17: an OpenAI preflight
  returns `access-control-allow-origin`; an Anthropic preflight does not, and needs
  `anthropic-dangerous-direct-browser-access: true`)*. Native RN has no CORS, so the pinned provider works there
  with plain `fetch`. On web, L3 carries a **per-provider header map**, and a provider with no web path is
  **native-only** with a stated reason — never a silent E4.

**Output contract.** Every call requests **structured output** (JSON) validated against a schema before storage;
invalid output = a failed call, retried per §4, never stored. Unchanged.

**Privacy (NFR-PRIV1).** Strengthened by the rebuild — no server ever sees the data — and unchanged in its
mechanism:

- **Only the operation's payload is sent** (the idea text for extraction; the two ideas' text + descriptors for
  adjudication; the one free-text tag and the offered cluster list for normalisation). No account identity, no
  vault listing, no unrelated ideas.
- **No training, no retention — enforced by routing, not assumed.** Every call pins `provider: { zdr: true }`, so
  OpenRouter routes only to endpoints it classifies Zero Data Retention. Residuals, stated not hidden: the
  per-endpoint ZDR classification is **provider-attested, not independently audited**; request **metadata** is
  always stored; OpenRouter transiently sees the prompt. The pin is enforced **by the app on the user's own
  account** — if the account cannot be routed to a ZDR endpoint for the pinned model, the call **fails closed**
  (§4.3), it is not silently downgraded. The build-time evidence (`scripts/capture-zdr.mjs` + `scripts/audit-zdr.ts`,
  the `zdr-evidence` CI job) is retained and retargeted onto `core/provider`.
- **No third-party transmission beyond a requested operation:** the engine runs only when a vault mutation
  requests it; there is no background telemetry and no periodic upload.

---

## 6. Module contract (was: the HTTP surface)

v1 §6 was an HTTP/JSON contract — endpoints, a bearer token, a status-code error envelope. **All of that retires**
(no server). What survives is the **semantic** contract, now expressed as in-process calls into `core/vault/`:

| Surface (`FLOW.md`) | v1 endpoint | v2 in-process call | Notes |
| :--- | :--- | :--- | :--- |
| **S0** Onboarding | `POST /v1/ideas` · `GET /v1/vault/summary` | `core/vault.createIdea` · `core/vault.vaultSummary` | capture is **domain-mandatory**; S0 domain input is the shipped-taxonomy picker + `Other → free text` escape; summary returns `resolved` cluster count |
| **S0 → S1** exit | — | — | gate on **≥ 2 resolved domains**; client computes it from the summary's `resolved` count |
| **S1** Sparks deck | `GET /v1/sparks` · `…/state` · `…/events` (SSE) | `core/vault.listOfferedSparks` · `…engineState` · an **in-process event** | `state` = E0–E4; delivery is the callback of §4.2 |
| **S1b** Spark detail | `GET /v1/sparks/{id}` | `core/vault.sparkDetail` | no scores, no similarity readout |
| **decision** | `POST /v1/sparks/{id}/decision` | `core/vault.resolveDecision` | idempotent on `(spark_id, decision_id)`; returns the created idea id for ACCEPT |
| **INSPIRE** | `POST /v1/sparks/{id}/inspire` | `core/vault.inspireSeed` | **not a resolution** — writes no `decision` |
| **undo** | `POST /v1/decisions/{decision_id}/undo` | `core/vault.undoDecision` | one step; windowed; retracts derived idea + provenance, re-offers; the three refusal arms survive as typed results |
| **S2** Capture | `POST /v1/ideas` (blank/seeded) | `core/vault.createIdea` | mandatory-field validation; a seeded save writes its `decision` row transactionally, idempotent on `decision_id` |
| **S3** Vault · **S4** detail · **S5** fork · **S6** iterate | `GET/POST /v1/ideas…` | `core/vault.listIdeas · getIdeaDetail · forkIdea · iterateIdea` | fork rejects same-domain; iterate is a version, not a lineage kind |
| **delete** | `DELETE /v1/ideas/{id}` | `core/vault.deleteIdea` | orphan-with-warning; fork children keep the parent ref; provenance source ⇒ dangling ref |
| **Recompute** | `POST /v1/sparks/run` | writes a `PENDING` `spark_run` row (`core/store`) | E1 — enqueueing is a **table write**, never an engine import (§4.1) |
| **Export** | `GET /v1/export` | `core/export.exportVault` | §8 |

**What changes is the transport; what is preserved is the semantics.** `decision_id` persist-and-reuse, the
one-step undo window and its three refusal arms, the invariants ("domain-mandatory capture", "single-parent
lineage", "provenance ≠ lineage", "at most one live offer per pair") — all survive, and they move from
server-enforced to **DB-enforced plus `core/vault`-enforced**:

- **The idempotency key becomes the platform's.** `decision.id` (the client-supplied `decision_id`) is still the
  primary key, and the DB constraint still makes a double-tap or a retry a **single** decision. In v1 the *server*
  enforced it; in v2 the *SQLite primary key* does — the same key, one layer down, which is *stronger* (it cannot
  be bypassed by a second caller).
- **Error classes replace status codes.** v1's `401/404/409/422/500` (`docs/API.md` §2) become typed results
  carrying the same distinctions — `NotFound`, `Conflict`, `ValidationFailed` — because the *distinction* is what
  callers act on, not the number. `docs/API.md` is retired as an HTTP document (§13); the codes that carried no
  meaning off the wire (401, 500) have no successor.

**Invariants `core/` enforces (not the screen):** domain-mandatory capture; single-parent lineage; provenance ≠
lineage; at most one live offer per pair; mandatory-field validation on every write.

---

## 7. Bootstrap

Unchanged from v1 §7: **domain-mandatory capture** (`FLOW.md` T02); the **spread gate** at **≥ 2 distinct
*resolved* domains** with `x/3` as progress, not a gate (`FLOW.md` T04, R1); **no synthetic seeds, no note
import**.

---

## 8. Portability, durability, and the transfer path (NFR-D1)

v1 §8 shipped `GET /v1/export` (a single JSON document) and used SQLite-on-host's **file copy** as backup. The
export format and its guarantees carry forward; **the backup path does not** — and this is the rebuild's sharpest
restatement.

**Export/import is the transfer path.** `core/export.exportVault` returns the same self-describing JSON document
(`{schema_version, exported_at, ideas[], idea_versions[], lineage_edges[], provenance_edges[], decisions[],
domain_tags[]}`), and `core/export.importVault` reads it back. On device the app writes it out and reads it in
through the platform's share/provide/file flow. **Google Drive sync is post-MVP** (owner, 2026-10-17); until it
lands, export/import is *the* path.

**Durability, restated (and it is weaker — stated, not hidden).** On a host, NFR-D1's "no committed idea lost"
was met by a file copy and a wipe→restore test. On a device there is **no file to copy** (the sandbox is not a
filesystem a user can reach) and **no second copy**. So:

- **The device is the only copy.** *Device loss = vault loss*, unless the user has exported. NFR-D1 holds
  **through export**, not automatically — the app must make exporting easy and prompt it at the right moments
  (a stated product obligation, L4).
- **The vault file is excluded from platform backup** — `allowBackup=false` (Android) and
  `NSURLIsExcludedFromBackupKey` (iOS). This is a **decision on record** (David, 2026-10-17), and it is the
  faithful reading of the owner's requirement *"nothing leaves to the cloud"*: an iCloud/Google Drive backup **is**
  the cloud. The consequence is written plainly rather than hidden: excluding backups **raises** the loss-on-
  device-failure risk and makes export the user's own escape hatch.
- **Migration from a v1 vault is not required** — nothing was ever deployed (David, 2026-10-17). A v1 export JSON
  imports, because the format is unchanged.

**Verification.** A backup→wipe→restore test becomes **export → wipe/reinstall → import**, asserting idea counts
and lineage/provenance edges survive (L4). The v1 EV5 `#47` round-trip is the shape; the transport is the only
difference.

---

## 9. Stack & security posture

**Stack (MVP), one language — TypeScript — across app and core:**

| Layer | Choice | Rationale |
| :--- | :--- | :--- |
| App | **Expo (React Native)**, iOS + Android store builds; web from the same codebase | the store-app requirement (`d178c664`); one codebase, three targets; ADR-0006 |
| Store | **SQLite**, one file in the app sandbox, one writer, opened through the `SqliteConnection` port (`expo-sqlite` on device, `node:sqlite` in tests/CI) | §2; the v1 schema and suites carry; ADR-0001 *amended* |
| Engine | **`core/engine`**, in-process, run on foreground (§4) | no broker, no worker process; ADR-0004 *amended* |
| AI | **OpenRouter behind the adapter** (§5), **user's key** in the platform secure store | ADR-0003 *amended* |
| Design | **Nightfall tokens** (palette, Geist/JetBrains Mono, 8px/44px, motion) implemented in **RN** | `DESIGN.md` is *shadcn-based*; the **tokens bind, the shadcn implementation does not** (RN is not the DOM). Re-scoped in §13 |

**Security posture.**

- **Single-tenant by construction** and now **single-device**: one user, one vault file, no tenant boundary and no
  network boundary to enforce. Multi-user is future scope (`PRD.md` §6).
- **Auth is gone.** v1's bearer token existed to authenticate a browser to a server; there is no server. The app
  is the only caller of its own vault. *(The token, `API_TOKEN`/`VITE_API_TOKEN`, is retired.)*
- **At rest.** The **OS app sandbox / platform file protection** is the at-rest defence — **not** app-layer
  encryption. **Encryption at rest (SQLCipher) is OUT for the MVP**, matching `PRD.md` §6's existing deferral of
  "encryption at rest"; it is the named post-MVP upgrade **behind the `SqliteConnection` port**, so it never
  touches vault logic, with the key in the secure store. Decision on record, §12.
- **Least data, least egress.** The provider sees the two ideas in a run and nothing else; the only egress is a
  requested run (§5).

---

## 10. ADRs

Load-bearing decisions, one file each, in `docs/adr/`:

| ADR | Decision | Status after the rebuild | Closes |
| :--- | :--- | :--- | :--- |
| **0001** | SQLite as the MVP store | **Amended** — same engine, now embedded; **single writer**; the two-writer/WAL/retry posture retired (it was an artifact of the API+worker split) | §2, NFR-D1 |
| **0002** | Two-stage, ANN-free spark engine; O(N + gated) | **Stands** | §3, `PRD.md` §3.3 item 7 |
| **0003** | One AI-provider interface + swappable adapter; structured output; ZDR routing | **Amended** — same interface; now in the app, on the **user's** key; key hygiene guard added; per-provider web map | §5, NFR-PRIV1 |
| **0004** | Async in-process queue; vault never imports the AI boundary | **Amended** — the queue is in the app process; the boundary rule carries to `core/vault` vs `core/provider` | §4, NFR-A1/P1 |
| **0005** | React/TS mobile-first **PWA** client | **Superseded** by ADR-0006 | v1 §9 |
| **0006** | **Local-only Expo app · on-device SQLite · device-direct provider on the user's key · no server tier** | **New** — this revision | §1, §5, §9 |

---

## 11. NFR traceability

Every non-functional requirement in `PRD.md` §4 → a design element and its verification, **with the rebuild's
restatements stated**. Rows marked **Δ** changed meaning and the change is the point.

| NFR | Requirement | Design element | Verification |
| :--- | :--- | :--- | :--- |
| **A1** Availability | Vault works without the Spark | `core/vault` may not import `core/provider` (§4); the engine is a module, not the vault (§1) — **and the vault now needs no network at all** *(Δ strengthening)* | **Fault injection:** disable the provider, run the vault suite — capture/read/iterate/fork/delete pass; S1 shows E4. Module-boundary guard, re-homed from v1 |
| **P1** Performance | Sparks async, never block vault; bounded delivery | Mutation commits then enqueues (§4); the deck reads state/events, never waits. **Δ restated:** the v1 bound (p95 ≤ 60 s at ≤ 500 ideas, *responsive provider*) becomes **p95 ≤ 60 s of active foreground time at ≤ 500 ideas**, because a run now advances only while the app is foregrounded and runs on the user's key (§4.1) | **Timed test** with an injected provider delay; vault request latency unchanged; sparks delivered within the foreground bound. *The number is re-derived in L1/L3 against the device* |
| **D1** Durability/Portability | No idea lost; open export | SQLite + WAL; `core/export` JSON (§8). **Δ restated:** the on-host file-copy backup is gone; durability holds **through export**; the device is the only copy; the vault is excluded from platform backup (§8) | **Export → wipe → import** round-trip; counts and lineage/provenance edges survive. L4 |
| **PRIV1** Privacy | No training; no third-party transmission beyond a requested op | Operation-scoped payloads; **ZDR routing control** (`provider:{zdr:true}` on every call); no telemetry; **key hygiene guard** (§5). **Δ strengthened:** no server ever holds the data; **Δ new residual:** the key is the user's, and on web there is no secure store | **Data-flow audit** (grep the boundary; one call site per operation) + **key-hygiene guard** (key never in vault/export/logs) + **routing control** (`zdr-evidence` job, retargeted) |
| **Q1** Quality | Spark quality instrumented (acceptance proxy) | `decision` records kind + whether the accepted idea landed in a **new domain** (`idea.new_domain`). **Δ restated:** the **instrument survives; the server-side reporting service does not.** Metrics are computed **locally** and are visible only to the user; there is **no telemetry** and no fleet aggregation (see §12) | **Instrumentation test** + a local reporting query over `decision`. *Product-level NSM tracking across users is out of scope without a server — flagged, not invented* |
| **U1** Usability | New user onboards spanning domains | Domain-mandatory capture + `≥ 2`-**resolved**-domain spread gate with `x/3` progress (§3.2). **Unchanged** — computed locally | **Onboarding completion test** (≥ 2 distinct resolved domains at exit; E0 not Cold on the first run) |

---

## 12. Open questions (for the reviewer / owner)

Items **1–6** are v1's, carried forward: their content is unchanged in substance by the rebuild, and three other
documents (`FLOW.md`, `W9_CALIBRATION.md`, `docs/adr/0003-ai-provider-boundary.md`) cite them **by position** — so
the numbering is preserved deliberately, and this section stays a top-level numbered list. Items **7–14** are the
rebuild's.

1. ~~Hosted vs local model.~~ **Resolved — hosted, now on the user's own key (2026-10-17).** v1 pinned OpenRouter
   from a server process (Max's verdict 2026-10-13; numbers re-verified by David). The rebuild keeps **OpenRouter**
   but the **device** calls it on the **user's own key** (§5). `AI_PROVIDER`/`AI_MODEL` remain config values, and a
   local/on-device model stays a drop-in adapter — it would strengthen NFR-PRIV1 at higher operational cost;
   **not** MVP.
2. **Mechanism descriptor schema.** The exact fields of the descriptor (§3.3) are a tuning artifact; the contract
   (structured, cached, locally comparable) is the decision. **Field set CONFIRMED — 2026-10-15 (#34)** on the
   stored P2 outcomes (AUC 0.6548). The **threshold** half did not close by that read: the reliability pass failed
   its decidability gate under the label `instrument` (`W9_CALIBRATION.md` §2). **The owner ruled (2026-10-15,
   #106): τ\* = `0.02` is seeded** — a deliberate **C3 amendment**, seeded for coverage, precision **uncertified**
   (§3.4) — the widened sweep's floor. **E is held; F is not executed; M2 never fired; no schema change.**
3. ~~**Cold-start ordering.**~~ **Resolved — closed by O5 (`#25`), 2026-10-14.** The run fires on the exit the user
   chose: *See your sparks* presses the run, *Skip* carries no side effect, and the S0→S1 exit never auto-runs.
   Unchanged by the rebuild (§4.1).
4. ~~FLOW §2.2 wording.~~ **Landed in `FLOW.md` r3.2.** The committed seeded save carries the same client-generated
   `decision_id` as a deck decision.
5. ~~FLOW §4.3 / T27 — "Good" polish prompt.~~ **Landed in `FLOW.md` r3.2.** An un-prefillable Good is saved
   **needs-completion**, held out of candidate selection, **and** the system prompts the user to polish at the right
   moments.
6. ~~FLOW §7 — S0 domain input contract (R1).~~ **Landed in `FLOW.md` r3.2 (picker) and r3.3 (escape).** The S0
   domain input is a **pick from the shipped taxonomy** plus an `Other → free text` escape; a typed lane is
   **provisional** and never opens the gate.
7. **Package layout — decided.** Two workspaces, **`app/`** (Expo) and **`core/`** (portable). The v1 `client/`,
   `api/`, `worker/`, `store/` packages retire (§13).
8. **Encryption at rest is OUT for the MVP — decided.** Matching `PRD.md` §6's existing deferral; the OS sandbox is
   the at-rest defence and SQLCipher is the named post-MVP upgrade behind the `SqliteConnection` port. **Backup
   exclusion is IN** (§8) — a decision on record (David, 2026-10-17), with *device loss = vault loss* stated.
9. **Native-first; web is a constrained second target — decided.** Three named gaps: no secure store → key
   session-only; `expo-sqlite` web = OPFS + Metro wasm + `COEP`/`COOP`, `withExclusiveTransactionAsync`
   unsupported → L1 feature-detects; per-provider CORS map → a provider may be native-only (§5, §9).
10. **One provider for the MVP — decided.** OpenRouter, the adapter swappable. Multi-provider BYO-key
    (OpenAI/Anthropic keys directly) is **post-MVP** — smaller once the header map exists, but not the increment.
11. **The engine runs foreground-only — decided.** P1's bound is restated in active-foreground time (§4.1, §11).
12. ~~NFR-Q1 without a server.~~ **Resolved — ruled (David, 2026-10-17).** **No fleet aggregation and no
    telemetry** — a cross-user NSM needs egress, which contradicts requirement 2 (*"nothing leaves the device"*).
    The **instrument stays and is computed locally** (`decision` kind + `idea.new_domain`, §11). A **user-visible**
    quality readout is user-facing behaviour, so it is the owner's call and sits on the owner queue (*"a local
    spark-quality readout in S1/S3?"*); the instrument itself is not blocked by that. Fold: **no telemetry ·
    instrument local · user-visible surface → owner queue.**
13. ~~The web key.~~ **Resolved — ruled (David, 2026-10-17).** **Session-only in memory, no browser persistence** —
    a `localStorage`/IndexedDB store is XSS-readable and would weaken the one boundary the rebuild is built on;
    re-entering the key each web session is the **stated cost**, and native is the primary target. The owner holds
    a veto (§5).
14. **Open — a product date.** Still open with the owner (David's *"B · a date?"*). It changes *shipping*, not
    *building*; L0–L4 proceed either way.
15. **Open — what the required CI `build` job builds for an Expo app.** `main-gate` requires a `build` check, so it
    must keep reporting something **real**. Recommendation: build **both** workspaces — `core` via `tsc` (as v1
    built `@astrolab/store`, including the built-seed-resolution step) and `app` via `expo export` (or a typecheck
    plus a web bundle) — offline and deterministic. L1/L2 own the config; the binding constraint is that the check
    does not become a no-op (`AGENTS.md` §4: a `paths:`-filtered or no-op'd required job is a permanent freeze).
16. **Open — device-only behaviour has no CI home.** The mid-run kill (L3), the capture-kill (L2) and P1's
    active-foreground bound are **device/emulator** behaviours. CI covers their **deterministic cores** — the
    currency check, the resume unit, the export round-trip — and the rest is **manual emulator sign-off**, stated
    as such in each lane's PR rather than asserted. Recommendation: keep that split for the MVP.

---

## 13. Carry-over table

**What survives from v1, what is ported, and what is deleted** — verified against `origin/main` @ `26811cb`
(the branch point), file by file. Dispositions: **kept** (used as-is), **ported** (moved into the new layout,
possibly with a stated edit), **re-authored** (the artifact's *intent* survives but its code does not),
**retired** (deleted; history only).

### 13.1 Docs & specs

| v1 artifact | disposition | evidence / note |
| :--- | :--- | :--- |
| `docs/PRD.md` | **kept** | product requirements unchanged; §4's NFRs re-mapped in §11 |
| `docs/VISION.md` | **kept** | |
| `docs/FLOW.md` | **kept, amended** | S0–S6 + the state machine survive; the delivery transport changes (§4.2); one new first-run arm — **"no key set"** (§4.3, §12) |
| `DESIGN.md` | **kept, re-scoped** | the **tokens bind** — Nightfall palette, Geist/JetBrains Mono, 8px geometry, 44px targets, motion, and the *judge-the-idea-not-the-pairing* governance; the **shadcn implementation and citation do not** (RN, not the DOM) — implemented in RN (§9) |
| `docs/stitch.md`, `docs/stitch-prompts.md` | **kept as design history** | the S0–S6 screen prompts; the surfaces they describe survive |
| `docs/W9_CALIBRATION.md` | **kept** | the engine's calibration; §3.4 unchanged |
| `docs/SCHEMA.md` | **kept, amended** | same **12** tables + migrations; the F2 (connection) note restated to the `SqliteConnection` port; no second writer |
| `docs/ARCHITECTURE.md` (v1) | **superseded by this file** | the server shape retires; its §2, §3, §5 carry forward almost verbatim |
| `docs/API.md` | **retired as HTTP** | the *semantics* (idempotency, undo arms, error classes, invariants) survive in §6 + code; the transport, the bearer auth, the status codes and the SSE stream do not |
| `docs/DEPLOY.md`, `docs/DEPLOY_SERVING.md`, `docs/RUNBOOK.md` | **retired (history)** | host ops — nothing to operate; kept as history per the re-triage |
| `docs/CI_GATE.md` | **kept, amended** | the `main-gate` ruleset still governs `main`; the deploy job goes, the **three required checks stay** |

### 13.2 ADRs

| v1 ADR | disposition |
| :--- | :--- |
| 0001 store-sqlite | **amended** (single writer) |
| 0002 spark-engine | **stands** |
| 0003 ai-provider-boundary | **amended** (in-app, user's key) |
| 0004 async-spark-pipeline | **amended** (in-process in the app) |
| 0005 client-stack | **superseded** by 0006 |
| **0006** (new) | the local-only rebuild |

### 13.3 Code & packages

| v1 artifact | disposition | evidence / note |
| :--- | :--- | :--- |
| `store/src/**` (store, migrate, migrations, vault, domain-map, sparks, runs, suppression, config, mechanism) | **ported → `core/src/store/`** | the 12-table store **already exists here** — L1 seeds `core/` from it rather than rewriting it; retargeted onto the `SqliteConnection` port |
| `store/src/store.ts` (`DatabaseSync` + WAL + retry) | **ported, amended** | `openStore`/`writeTransaction` retargeted to the port; `foreign_keys=ON` and short transactions kept; the two-writer retry kept as a harmless guard |
| `store/seed/**` (`domain-taxonomy.yaml`, `README.md`) | **ported → `core/`** | the **artifact of record** for the 28 clusters |
| `store/test/**` | **ported → `core/`** | invariants/concurrency/mechanism/taxonomy suites run against the `node:sqlite` adapter; the **two-process** child-spawn tests (`harness.ts`, `writer.ts`, `writers.test.ts`) are **retired or re-scoped to single-writer** — a second process is no longer the model |
| `store/test/o1_check.py` + the `o1-taxonomy` CI job | **kept, retargeted** | the canonical harness on the shipped seed file; the job's paths follow `store/` → `core/` |
| `client/src/api/types.ts` | **ported → `core/`** | **it is the domain model, not transport** — its own docstring says the field names are `docs/API.md` §3.1/§4.2/§4.5's contract verbatim, and **16** files in `client/src/domain/` import it. Its `§` citations re-point at v2's §2/§6 |
| `client/src/domain/**` (**12** modules + **12** tests) | **ported → `core/domain/`** | React-free and DOM-free (verified: no `react`, `window`, `document`, `localStorage`, `import.meta.env`). **4** are pure and move verbatim — `deck-interaction` · `delete-warning` · `run-trigger` · `taxonomy`; **8** need the `types.ts` re-home; **2** carry a **runtime** import to re-point — `onboarding.ts:2` (`createIdea` from `../api/ideas.ts`) and `decision.test.ts:3` (`ApiError` from `../api/client.ts`) |
| `client/src/domain/deck-interaction.test.ts` | **retired** | a **node-only source-text guard** (`node:fs`) reading `../screens/*.tsx` — files outside `core/` that are re-authored. It cannot move; its **intent** re-homes as an `app/`-side guard in L2 (this closes **#148**) |
| `client/src/domain/taxonomy.test.ts` | **retired** | its reason is gone. It exists to stop `taxonomy.ts`'s **mirror** drifting from the shipped YAML — a mirror that existed only because *the client could not reach `store`*. In `core/` the mirror and the loader are one package, so the picker reads the **seeded tables** and there is nothing to drift. The YAML stays the artifact of record, guarded by its own `o1_check.py` harness and `store/test/schema.test.ts` (both ported) |
| `client/src/api/*` (transport: `client.ts`, `ideas.ts`, `sparks.ts`, `decisions.ts`, `vault.ts`, `inspire.ts`) | **retired** | Vite `fetch` transport; its call shapes become `core/vault` calls (§6) |
| `client/src/screens/**`, `components/**`, `styles/*.css` | **re-authored → `app/`** | React-DOM + CSS → RN (`View`/`Text`/`Pressable`, `StyleSheet`/tokens); the deck, gestures, and E0–E4 compositions survive as *design*, not code |
| `api/src/**` (route handlers: capture, decision, delete, fork, ideas, inspire, iterate, sparks, undo, vault-summary, engine-state, export, metrics) | **ported → `core/src/vault/`**, minus transport | the use-cases and their tests move; the HTTP wrapping does not |
| `api/src/server.ts`, `spark-events.ts`, `index.ts` | **retired** | HTTP router, bearer auth, error envelope, SSE, and the process boot — there is no server |
| `worker/src/engine/**` (run, gate, alignment, adjudicate, domain, suppression, mechanism) | **ported → `core/src/engine/`** | the composer and its stages; the run's body/commit split carries verbatim (§4.1) |
| `worker/src/queue.ts` | **ported, amended → `core/src/engine/`** | the in-process runner and supersession stay; the loop is driven by app lifecycle, not a `setInterval` in a daemon |
| `worker/src/provider/**` (openrouter, prompts, schema, types, boundary test) | **ported → `core/src/provider/`** | the adapter and the boundary guard; the boundary test's **path set changes** (`api`/`store` → `core/vault`), its rule is the same |
| `worker/src/nfr-*.test.ts`, `api/src/nfr-*.test.ts` | **ported, amended** | the NFR suites re-home; the A1 fault-injection and P1 timing keep their shape, P1 restated per §11 |
| `scripts/audit-zdr.ts`, `capture-zdr.mjs` | **kept, retargeted** | PRIV1 evidence; the `DEFAULT_MODEL` import follows `core/provider` |
| `scripts/w9-*.ts` | **kept** | calibration; `store/`-relative paths follow `core/` |
| `deploy/**`, `.github/workflows/deploy.yml` | **retired** (L1) | the host layer and the CI deploy job |
| `.github/workflows/ci.yml` | **kept, amended** | the deploy-free required checks; workspace globs and `store/`→`core/` paths follow |
| `api/package.json`, `worker/package.json`, `store/package.json`, `client/package.json` | **replaced** | by `app/package.json` + `core/package.json` |
| `.env.example` | **retired / replaced** | `API_TOKEN`, `VITE_API_TOKEN`, `DB_PATH`, `API_PORT`, `CLIENT_PORT` have no successor; the key is device-held (§5) |
| root `package.json` workspaces | **amended** | `["api","worker","client","store"]` → `["app","core"]` |

**The five rows an independent read caught that this table first missed** (Ari, 2026-10-17, at `26811cb`): the
`api/types.ts` domain model (row 1), the two runtime imports (row 2), the `deck-interaction.test.ts` node-only
guard (row 3), the taxonomy drift gate (row 4), and the fact that `store/` is **not one thing** but `store/src`
(→ `core/`) + `store/seed` (→ `core/`) + package scaffolding (row 5).

### 13.4 The one guard the carry-over table *creates* (not carries)

NFR-A1's requirement — *the vault works with the AI unavailable* — survives its v1 code. In v2 it is a **fresh
`app/`- and `core/`-side boundary guard**: `core/vault/**` may not import `core/provider/**`, asserted by a
structural test **seen failing in the state it forbids** (repo guard discipline, `AGENTS.md`). Named here so it is
not lost between the v1 tree retiring and L2 landing.

---

## 14. Revision history

- **2026-10-12 — r1…r3.6 (v1).** The server architecture: one host, an API service, a worker process,
  SQLite-on-host. Retired by this revision; the full history lives in `git log -- docs/ARCHITECTURE.md` and its
  §13 before this rewrite. Its §2 (data model), §3 (engine) and §5 (provider boundary) carry forward, and are the
  substance of this document.
- **2026-10-17 — v2.** **The local-only rebuild.** Owner call (`d178c664`): store app · all data on device · AI on
  the user's own key · server tier + AWS deploy cancelled · rebuild. This revision: the app-only system context
  (§1), the store as a ported `core/` package (§1, §13), the engine in-app with a resumable, foreground-bound run
  and in-process delivery (§4), the BYO-key provider boundary with the key-hygiene guard and the web gaps stated
  (§5), the HTTP contract re-expressed as in-process calls (§6), durability restated to export-only with backup
  exclusion (§8), encryption-at-rest deferred (§9), and the **carry-over table** (§13). ADR-0006 is new; ADR-0001,
  -0003 and -0004 are amended; ADR-0005 is superseded; ADR-0002 stands (§10). *Review: the carry-over table
  verified against `origin/main` @ `26811cb`; Ari's independent read folded in (§13.3); builder check per the
  `brainstorming` skill.*
