# L1–L4 Local-Only Rebuild — Implementation Plan (lane breakdown)

> **For agentic workers:** this is the **lane breakdown** agreed in L0. Each lane owner expands **their own lane**
> into a task-level plan with `superpowers:writing-plans` before building, then executes it with
> `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rebuild AstroLab as a local-only Expo app — on-device SQLite, device-direct provider on the user's key —
retiring the v1 server tier, without losing the domain model, engine, taxonomy, lineage, or their tests.

**Architecture:** Two workspaces. `core/` holds everything portable (store · vault · domain · engine · provider);
`app/` is the Expo (React Native) app. The v1 `store`, `api`, `worker`, `client` packages retire; `store/src` and
`api/src` *move* (the store is not rewritten), `client/src/domain` moves with two edits, and the DOM/HTTP layers
are re-authored or deleted. Full dispositions: `docs/ARCHITECTURE.md` §13.

**Tech Stack:** TypeScript · Expo (React Native) · `expo-sqlite` (device) / `node:sqlite` (tests, CI) · OpenRouter
behind the provider interface · vitest.

**Spec:** `docs/ARCHITECTURE.md` (v2) + `docs/adr/0006-local-only-expo-app.md` — the plan argues from the spec, so
both travel with it; every executor reads them.

## Global Constraints

- **No vector DB / ANN index** (`PRD.md` §3.3 item 7). **No user-facing similarity surface** (`VISION.md` §8 item 4; `DESIGN.md` §7).
- **One language: TypeScript.** Explicit type annotations on exported signatures.
- **`core/vault/**` must not import `core/provider/**`** (NFR-A1). **The API key must not appear** in any vault row,
  the export, or a log (NFR-PRIV1).
- **Never sleep or poll** in tests or code (`AGENTS.md`, *Harness overrides* 1). **Only merges need a human**, and
  the **assigned reviewer performs** the approve-and-merge (`AGENTS.md`, *Harness overrides* 2). Author ≠ reviewer.
- **A held-lane PR carries no closing keyword + `#n`** anywhere in body or commits; write `Part of #<n>` (§3).
- **Any PR touching `.github/` must show the three required jobs still report** (`AGENTS.md`, *Harness overrides* 4;
  `docs/CI_GATE.md`): `lint · format · typecheck · test · build`, `citation ref-lint`, `o1-taxonomy`.
- **Design tokens bind, shadcn does not**: Nightfall palette, Geist/JetBrains Mono, 8px radius, 44px targets,
  `transform`/`opacity` motion, no circular spinners (`DESIGN.md`; `ARCHITECTURE.md` §13).

## Interface invariants (binding on L1–L3 — settled by the L0 builder check)

The design leaves these forks open. They are **decided here** so no lane re-decides them; a wrong guess in any
costs a lane.

1. **The `SqliteConnection` port is SYNCHRONOUS — and so is every transaction callback.** `exec` · `prepare` ·
   `Statement.run/get/all` · `close`, plus `writeTransaction<T>(conn, fn: () => T): T` with a **synchronous** `fn`.
   This is what makes *"one process ⇒ writes serialized by construction"* literally true (a sync callback cannot
   interleave) and what lets the v1 store/vault/engine suites carry.
   **VERIFIED — Ari, 2026-10-17**, read off the shipped typings of `expo-sqlite@58.0.13` (SDK-58, `latest`) *and*
   `57.0.4` (SDK-57): the full sync surface is present, including a sync transaction wrapper
   (`withTransactionSync`). **No async variant is needed and the concurrency argument stands.** Three consequences,
   binding on L1:
   - **1a — nothing was actually pinned.** Root `package.json` @`26811cb` has no expo dependency and `app/` does not
     exist, so *"the pinned `expo-sqlite`"* has **no referent**. **L1 creates the pin: `expo-sqlite@58.0.13`**
     (npm `latest`, SDK-58).
   - **1b — `writeTransaction` is implemented *over the port*, not via Expo's wrapper.** Expo's
     `withTransactionSync` is literally `BEGIN` → `task()` → `COMMIT` (deferred, no `IMMEDIATE`, no retry, no typed
     result) — it is **not** v1's `writeTransaction` (`store/src/store.ts:41`: `BEGIN IMMEDIATE` + retry + `T`).
     Keep **v1's body verbatim** (`exec("BEGIN IMMEDIATE")` / `fn()` / `COMMIT` / `ROLLBACK`) so both adapters share
     one code path and the v1 store/concurrency suites do not move; Expo's wrapper stays unused.
   - **1c — the miss sentinel is pinned to `undefined`.** `node:sqlite`'s `.get()` returns **`undefined`** on no row
     and v1 branches on it (`store/src/runs.ts:32-36, 66`); Expo's `getFirstSync()` is typed **`T | null`**. CI runs
     the node adapter, so a naive Expo adapter is **CI-green and device-broken** (invariant 8's class). **The port
     pins `undefined`; the Expo adapter maps `null → undefined`**; add a **device-adapter parity test** (Expo also
     needs `finalizeSync()`; `node:sqlite` has `close()` — each adapter closes per call, no statement cache, which
     matches v1's inline `prepare`).
2. **Enqueueing a run is a table write, not a call.** A candidate-affecting vault mutation (and Recompute) writes a
   `PENDING` `spark_run` row **inside its own transaction**; the app's engine driver observes the table. No
   `core/vault` → `core/engine` import exists, so the A1 guard is satisfiable.
3. **The body may warm the extract cache; only the commit writes results.** `idea_mechanism` is a `source_hash`
   memo — revision-independent — so the body may write it incrementally (else a suspension re-pays every O(N)
   extract). Offers and suppressions are **results** and land only on a current run.
4. **A `KeyStore` port mirrors `SqliteConnection`.** `core/provider/key.ts` reads the key through an injected
   `KeyStore` (`get`/`set`/`clear`); `app/` supplies the native secure-store adapter and the web session-memory
   adapter. **`core/` never imports `expo-secure-store`.** The **composition root is `app/`** — it constructs the
   connection, the key store, and the engine driver.
5. **Adapter isolation.** The `node:sqlite` adapter is imported **only by tests/CI**; the `expo-sqlite` adapter
   **only by `app/`**. L2 checks the device bundle carries no `node:sqlite`; `core`'s vitest run never resolves
   `expo-*`.
6. **`core/` is a TS workspace package consumed by Metro and compiled by `tsc`** (the v1 `@astrolab/store` shape:
   `main: dist/index.js`, `types: src/index.ts`), so the **required `build` check stays real** (spec §12 item 15).
7. **The taxonomy has one source.** The picker reads the **seeded `domain_cluster` rows**; `core/domain/taxonomy.ts`
   keeps its types + ordering and **drops the mirror**; the retired drift test's job is done by the YAML's own
   harness (`o1_check.py` + `schema.test.ts`, both ported). Boot order: `migrate()` → `seedDomainTaxonomy()` →
   render S0.
8. **Engine parity is a verification item, not an assumption.** L1 runs the migration suite (the `0003`/`0004`
   table rebuilds, `PRAGMA foreign_keys` handling, `ux_spark_live`, `ON CONFLICT`, WAL) against **each** engine —
   `node:sqlite` (CI), `expo-sqlite` (emulator), web OPFS — because a divergence is CI-green + device-broken.
9. **Device-only behaviour is manual sign-off.** Each Review Focus item that is a device/emulator behaviour gets a
   **deterministic core test in CI** (the currency check, the resume unit, the export round-trip) plus a **manual
   emulator sign-off** for the rest, named in the lane's PR (spec §12 item 16).
10. **Web sync has two hard platform limits (verified — Ari, 2026-10-17).** `expo-sqlite` implements sync on web via
    a Worker + `Atomics.wait` on a `SharedArrayBuffer`, so it needs a **cross-origin-isolated** context
    (`crossOriginIsolated`: `COEP` + `COOP`) — and the sync result buffer is a fixed **1 MiB**, over which a sync
    call **throws**. ⇒ **L1's web row: sync reads must be row-bounded; a full-vault read pages or goes async.**
    **L4 owns the consequence:** `exportVault` on web cannot be one sync `SELECT *`. (`withExclusiveTransactionAsync`
    unsupported on web — confirmed verbatim; `interruptSync` throws `UnavailabilityError`.)
11. **SQLCipher is a seam, not a free swap (verified — Ari, 2026-10-17).** The `SqliteConnection` port holds, but
    the plugin is **native-only** (no web, no Expo Go), needs a **custom native build** (not an OTA update), and
    *does not encrypt an existing plaintext database* — so the post-MVP upgrade carries a **data migration**.
    Stated so no later reader takes *"behind the same port"* for *"free"* (spec §9).

## Review Focus

Failure modes the spec implies that no single task's tests own; each is pinned to the task that owns the code.

1. **First launch, no key set** → S1 shows **E4 with the cause** (*"Add your AI key…"*), never a blank deck, a
   crash, or a silent cold state (`ARCHITECTURE.md` §4.3). → L2-4.
2. **Provider returns invalid JSON / a non-ZDR-routable model** → a **failed call**, nothing stored, E4; the vault
   is untouched (NFR-A1, NFR-PRIV1). → L3-3.
3. **App suspended or killed mid-run** → the next foreground **re-runs**; no partial writes, no duplicate live
   offers, no lost committed idea. → L3-4.
4. **Import a v1 export, and a corrupt/truncated one** → either a clean import or a typed error; never a
   half-populated vault (NFR-D1). → L4-2.
5. **A swipe and a button tap fired together** → exactly **one** decision, keyed on `(spark_id, decision_id)`
   (`FLOW.md` §2.2), and a capture abandoned by an OS kill loses no typed value silently. → L2-3, L2-2.

---

### L1: Local data layer — `core/` skeleton, the store, the vault, the domain  (@Ari)

**Files:**
- Create: `core/package.json`, `core/tsconfig*.json`, `core/src/index.ts`
- Create: `core/src/store/connection.ts` (the `SqliteConnection` port)
- Create: `core/src/store/connection.node.ts` (`node:sqlite` adapter — tests & CI)
- Move: `store/src/*` → `core/src/store/*`; `store/seed/*` → `core/src/seed/*`; `store/test/*` → `core/test/*`
- Move: `api/src/*.ts` (handlers) → `core/src/vault/*.ts` (use-cases, transport stripped) — **except `api/src/export.ts`**
- Move: `api/src/export.ts` → `core/src/export/export.ts` (**verbatim relocation**, so the codec survives `api/`'s
  retirement; **L4 owns its contents** — §6 places export at `core/export`, not `core/vault`)
- Move: `client/src/api/types.ts` → `core/src/types.ts`; `client/src/domain/*` → `core/src/domain/*`
- Delete: `api/`, `store/`, `client/`, `deploy/`, `.github/workflows/deploy.yml`
  (**not** `worker/` — L1 lands before L3 relocates its `engine`/`provider` and `queue.ts`; **L3** empties and retires it)
- Modify: root `package.json` (`workspaces: ["app","core"]`); `.github/workflows/ci.yml` paths

**Interfaces:**
- Produces: `SqliteConnection` — `exec(sql: string): void` · `prepare(sql): Statement` ·
  `Statement.run(...params): void` · `.get(...): unknown` · `.all(...): unknown[]` · `close(): void`.
- Produces: `openStore(conn: SqliteConnection): void` (pragmas: `foreign_keys=ON`, WAL) ·
  `writeTransaction<T>(conn, fn: () => T): T`.
- Produces: `core/src/vault/*` use-case signatures, derived from the v1 `api/src` handlers with the HTTP layer removed
  (typed results replace status codes — `NotFound` · `Conflict` · `ValidationFailed`).
- Produces: the domain modules `core/src/domain/*` and the domain types in `core/src/types.ts`.

- [ ] **Step 1: `core/` skeleton + the connection port.**
  **First, verify** the pinned `expo-sqlite` sync surface (invariant 1). Then create the workspace; define the
  **synchronous** `SqliteConnection`/`Statement`; implement the `node:sqlite` adapter so the vitest suites can run.
  Test: open an in-memory connection, create a table, round-trip a row.
- [ ] **Step 2: Move the store and retarget it to the port.**
  `git mv store/src core/src/store`, `git mv store/test core/test`, `git mv store/seed core/src/seed`.
  Retarget `openStore`/`writeTransaction` onto `SqliteConnection`. **Single-writer**: keep `foreign_keys=ON` and the
  short transaction; keep the WAL pragma and drop the *necessity* of the BUSY retry (retain it as a guard, with the
  comment corrected to say why it is no longer load-bearing).
  Run: `npm test -w core` — the v1 store suites pass against the node adapter. **Retire or re-scope the two-process
  tests** (`test/harness.ts` spawns a child; `test/writers.test.ts`): a second process is not the model — re-write
  them as single-writer assertions, or delete them with a note.
- [ ] **Step 3: Move the vault use-cases off HTTP.**
  `git mv api/src/*.ts core/src/vault/` (minus `server.ts`, `index.ts`, `spark-events.ts`, and **`export.ts`** —
  reserved for L4 and relocated verbatim to `core/src/export/export.ts`); delete the HTTP wrapping and the error
  envelope; return typed results. Move `metrics.ts`/`metrics-report.ts` as local queries (not routes).
  Tests: the moved `*.test.ts` re-home and pass.
- [ ] **Step 4: Move the domain and re-home the types.**
  `git mv client/src/api/types.ts core/src/types.ts`; `git mv client/src/domain core/src/domain`.
  Fix the two **runtime** imports (`onboarding.ts` → `createIdea`; `decision.test.ts` → `ApiError`); re-point the
  `../api/types.ts` specifiers (16 files) and the `§` citations in `types.ts` at `ARCHITECTURE.md` §2/§6.
  **Do not port `domain/deck-interaction.test.ts`** — it is a node-only source-text guard reading `app/` files it
  cannot see; it retires (its intent is L2-5).
- [ ] **Step 5: The taxonomy has one source.**
  Move the shipped YAML; **retire the mirror and its drift test** (invariant 7; `ARCHITECTURE.md` §13.3) —
  `core/domain/taxonomy.ts` keeps its types and the curated ordering and reads the **seeded `domain_cluster` rows**.
  Keep the YAML guarded by its own harness (`o1_check.py` + `schema.test.ts`), and update the **required**
  `o1-taxonomy` CI job's paths (`store/seed/…` → `core/src/seed/…`, `store/test/o1_check.py` → `core/test/…`).
  Run the migration suite against `node:sqlite` **and** flag the emulator/OPFS row (invariant 8).
- [ ] **Step 6: Retire the server packages and fix the workspace.**
  Delete `api/`, `store/`, `client/`, `deploy/`, `.github/workflows/deploy.yml`; set `workspaces:["app","core"]`;
  update `tsconfig` references and `.prettierignore`. Remove the deploy job's env from `.env.example`.
  Run: `npm run lint && npm run format && npm run typecheck && npm test && npm run build` — green.
- [ ] **Step 7: The A1 boundary guard (new).**
  Add a structural test: **no file under `core/src/vault/**` imports `core/src/provider/**`** (nor `core/src/engine/**`),
  with a **non-vacuity** assertion (it reads the vault dir and finds ≥1 module); **see it fail** with a planted
  import, then restore. This is the NFR-A1 guard re-homed from v1 (`ARCHITECTURE.md` §13.4).

**Deliverable:** `core/` builds and its store+vault+domain suites are green in CI; the server packages are gone; the
boundary guard bites.

---

### L2: Expo app shell + screens  (@Eli)

**Files:**
- Create: `app/package.json`, `app/app.json` (Expo config), `app/src/App.tsx`, navigation
- Create: `app/src/screens/{Onboarding,Sparks,SparkDetail,Capture,Vault,IdeaDetail,Fork,Iterate}.tsx`
- Create: `app/src/components/{SparkCard,StarChart,DomainPicker,EmptyState,Shimmer}.tsx`
- Create: `app/src/theme/tokens.ts` (Nightfall tokens as values)
- Create: `app/src/store/expoConnection.ts` (the `expo-sqlite` adapter injected into `core`)
- Create: `app/src/domain/deck-interaction.test.ts` (re-homed guard; **#148**)

**Interfaces:**
- Consumes: `core/src/vault/*`, `core/src/domain/*`, `core/src/types.ts`, the `SqliteConnection` port.
- Produces: the S0–S6 screens and the deck; the E0–E4 compositions (`DESIGN.md` §9).

- [ ] **Step 1: `app/` shell + the connection binding.**
  Scaffold Expo; inject the `expo-sqlite` adapter into `core`; boot to S0 on an empty vault, S1 otherwise.
- [ ] **Step 2: Capture (S2) + Onboarding (S0).**
  Mandatory-field validation, the 280 counter, the **taxonomy picker + `Other → free text` escape**, the star-chart
  reveal, the `x/3` readout; the S0→S1 gate on **≥ 2 resolved domains**; *See your sparks* runs, *Skip* does not (O5).
  Test: an OS kill during capture loses no typed value **silently** (autosave the draft or confirm discard).
- [ ] **Step 3: Deck (S1) + Spark detail (S1b).**
  The card (`direction`/`claim`/`first_step`/tags); **swipe right = ACCEPT, left = DISMISS** with 44px buttons;
  one-step **undo** covering ACCEPT/DISMISS/**committed seeded save**; INSPIRE opens seeded Capture.
  Test: a swipe and a button tap fired together produce **one** decision, keyed `(spark_id, decision_id)`.
- [ ] **Step 4: Engine states E0–E4.**
  Compose the deck band: E0 (progress, not failure), E1 (skeletal shimmer, **no circular spinner**), E2 (+ list
  toggle when n>1), E3 (`x/3` widening nudge at exactly 2 domains), E4 (quiet + Retry). **Add the "no key set" arm**
  of E4 with cause copy (§4.3). Precedence: E0 > (E4 > E3); E1 coexists with E2.
- [ ] **Step 5: Re-home the deck-interaction guard.**
  Port the *intent* of the retired `client/src/domain/deck-interaction.test.ts`: the gesture axis and thresholds,
  the card's **single `onResolve` call site**, and **the `app/`-side boundary that a vault screen reaches no engine
  module** (the `../api/…` specifier walk becomes an `app/`-side walk over `core` imports). **#148** closes here.
- [ ] **Step 6: Vault (S3)/detail (S4)/fork (S5)/iterate (S6) + lineage.**
  Re-author the four screens; lineage chain vs provenance (muted); iterate = a new version, **not** an ancestor;
  fork rejects same-domain and offers Iterate.

**Deliverable:** the app runs on device, all six surfaces work offline, and the deck's states and parity hold.

---

### L3: BYO-key provider client  (@Ari)

**Files:**
- Move: `worker/src/provider/*` → `core/src/provider/*`; `worker/src/engine/*` → `core/src/engine/*` (plus
  `worker/src/queue.ts` and the `worker/src/nfr-*.test.ts` suites, §13.3)
- Delete: `worker/` — emptied by the move above; **L1 leaves it in place for this lane** (§13.3)
- Create: `core/src/provider/key.ts` (secure-store accessor — the one module the adapter may import)
- Create: `core/src/provider/key.test.ts` (key-hygiene guard)
- Create: `app/src/engine/runScheduler.ts` (foreground run driver; in-process events)

**Interfaces:**
- Consumes: `core/src/store/*`, `core/src/vault/*`.
- Produces: the `Provider` interface (`MechanismExtractor & SparkAdjudicator & TagNormalizer`) unchanged; the
  engine's run producer + commit; `enqueueRun`, the run event emitter.

- [ ] **Step 1: Move the engine and the provider boundary.**
  `git mv` `worker/src/{engine,provider}` → `core/src/`; fix imports; re-point the boundary test's **path set**
  (`api`/`store` → `core/vault`); keep its rule. Ported NFR-P1 test kept, bound restated (§11).
- [ ] **Step 2: The key accessor + its hygiene guard.**
  `core/src/provider/key.ts` reads the key through an injected **`KeyStore` port** (invariant 4) — `app/` supplies
  the native secure-store adapter and the web session-memory adapter; `core/` imports neither `expo-*` nor the OS
  keychain. **Guard**: assert no module outside `core/src/provider/` imports the accessor, that the export codec is
  key-free, and that the key is never logged — **seen failing** with a planted leak.
- [ ] **Step 3: Web posture.**
  Session-only key on web (never `localStorage`/`IndexedDB`); feature-detect `withExclusiveTransactionAsync`;
  a **per-provider CORS header map** for web (`fetch` as-is for OpenAI; the dangerous-direct-browser header for
  Anthropic), a provider with no web path marked **native-only** with a stated reason.
- [ ] **Step 4: The foreground run driver.**
  Drive the engine from app lifecycle: single-flight, resumable from `spark_run` + `vault_revision`, **side-effect-free
  body** so a re-run after a suspension is safe; the commit writes **only when the run is current**; emit
  **in-process events** (no SSE). Test: kill mid-run → next foreground re-runs; **no partial writes, no duplicate
  offers**.
- [ ] **Step 5: Failure taxonomy.**
  Map provider failures to E4 arms: no key / invalid key / offline / timeout / 429 / CORS-blocked / invalid JSON.
  Invalid JSON is a **failed call**, never stored (§5). Test: invalid output stores nothing.

**Deliverable:** the device calls OpenRouter on the user's key, the key never leaks, and runs survive suspension.

---

### L4: Export / import  (@Eli)

**Files:**
- Own: `core/src/export/export.ts` (relocated **verbatim** by L1, so it survives `api/`'s retirement — **do not
  re-move it from `api/`**, which is gone by L4); **create** `core/src/export/import.ts`
- Create: `core/src/export/roundtrip.test.ts`
- Create: `app/src/screens/Export.tsx`, `app/src/screens/Import.tsx`
- Modify: `app/app.json` — `allowBackup=false` (Android) and `NSURLIsExcludedFromBackupKey` (iOS)

**Interfaces:**
- Consumes: `core/src/store/*`.
- Produces: `exportVault(conn): VaultExport` · `importVault(conn, doc: unknown): ImportResult` (typed error on a bad
  document).

- [ ] **Step 1: The codec.**
  Keep the JSON shape (`{schema_version, exported_at, ideas[], idea_versions[], lineage_edges[], provenance_edges[],
  decisions[], domain_tags[]}`). `importVault` validates before writing; a bad document is a typed error, **never a
  half-vault**. Test: a v1 export imports cleanly.
- [ ] **Step 2: The round-trip proof (NFR-D1).**
  export → wipe/reinstall → import; assert idea, version, lineage and provenance counts survive. Plant a corrupted
  document → typed error, vault untouched.
- [ ] **Step 3: Backup exclusion.**
  Set `allowBackup=false` / `NSURLIsExcludedFromBackupKey`; a test/assert that the config carries it, and a doc note
  stating *device loss = vault loss* (`ARCHITECTURE.md` §8).
- [ ] **Step 4: The app UI.**
  Export via the platform share sheet; import via the file provider; the empty/error states are composed, not bare.

**Deliverable:** a user can move their whole vault off-device and back, and a lost device is the only way to lose it.

---

### Independent review  (@Max)

- [ ] Review each lane's PR (author ≠ reviewer is already satisfied — L1/L3 are Ari's, L2/L4 are Eli's), **approve and
  merge** per the repo rule, with the verdict as a PR comment and the `--match-head-commit` merge.
- [ ] Hold the **Review Focus** list above against each lane: the five failure modes get exercised, not asserted.

---

## Self-review

- **Spec coverage:** §1 layout → L1/L2 · §2 store → L1 · §3 engine → L1/L3 · §4 runs → L3 · §5 provider → L3 ·
  §6 contract → L1/L2 · §8 export → L4 · §9 stack → L2/L3 · §11 NFRs → L1 (A1), L3 (P1/PRIV1), L4 (D1), L2 (U1). Q1 → §13 open.
- **Type consistency:** `SqliteConnection`/`openStore`/`writeTransaction` are named once (L1) and consumed by name in
  L2/L3/L4; the `Provider` interface keeps the v1 names (`extract`/`adjudicate`/`normalizeTag`).
- **Review Focus:** five lines, each pinned to a task (L2-2, L2-3, L2-4, L3-3, L3-4, L4-2).
- **Proportion:** a breakdown, not a transcript — each lane expands via `writing-plans` before building.
