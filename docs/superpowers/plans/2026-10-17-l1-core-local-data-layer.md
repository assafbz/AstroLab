# L1 · `core/` — local data layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Issue:** [#164](https://github.com/assafbz/AstroLab/issues/164) · **Lane owner:** Ari · **Branch:** `feat/164-core-local-data-layer`, cut from `bf98e12`.

**Goal:** Land `core/` as the portable, synchronous data layer — the 12-table store, the vault
use-cases, the domain modules and their tests — green in CI on `node:sqlite`, with the v1 server
packages retired and the NFR-A1 boundary guard biting.

**Architecture:** One workspace package `core/`, consumed by the Expo app (Metro) and compiled by
`tsc`. Every SQLite call goes through a synchronous `SqliteConnection` port with two adapters —
`node:sqlite` (tests, CI) and `expo-sqlite` (device, supplied by the app). v1's `store/src`, the
`api/src` handlers and `client/src/domain` are **moved**, not rewritten.

**Tech Stack:** TypeScript · `node:sqlite` (CI) · `expo-sqlite@58.0.13` (device; L1 creates the pin) · vitest.

**Spec:** `docs/ARCHITECTURE.md` (v2) §1/§2/§6/§13 · `docs/adr/0006-local-only-expo-app.md` ·
`docs/superpowers/plans/2026-10-17-l1-l4-local-only-rebuild.md` (the L0 breakdown; its invariants 1–11
are binding here and are cited by number below).

## Global Constraints

- **`core/src/vault/**` must not import `core/src/provider/**`** (nor `core/src/engine/**`) — NFR-A1.
- **The API key must not appear** in any vault row, the export, or a log — NFR-PRIV1.
- **One language: TypeScript**; explicit type annotations on exported signatures.
- **No vector DB / ANN index**; **no user-facing similarity surface**.
- **Never sleep or poll** in tests or code. **Only merges need a human**; the assigned reviewer merges.
- **The closing PR for #164 is this one**, so its *body* carries the closing keyword + `#164`
  (`AGENTS.md`, _Harness overrides_ 3) and closes the issue on merge. The held-lane rule — no closing
  keyword anywhere — is for a lane whose issue must stay open; L1's issue closes here, and no commit in
  the lane carries a closing keyword either way.
- **Any PR touching `.github/` must show the three required jobs still report** (`lint · format ·
  typecheck · test · build`, `citation ref-lint`, `o1-taxonomy`); a `paths:`-filtered required job is a
  permanent freeze, not a weaker gate.
- **Do not delete `worker/`** — L3 relocates its `engine`/`provider`/`queue.ts` first (David's collision
  #1 on #163). L1 retires `api/`, `store/`, `client/`, `deploy/` only.

## Interface invariants (settled in L0 + the L1 verification pass — see `RESEARCH/EXPO_SQLITE_SYNC_SURFACE_2026-10-17.md`)

1. **The port is SYNCHRONOUS.** Verified against `expo-sqlite@58.0.13` and `57.0.4`: `openDatabaseSync`
   · `execSync` · `prepareSync` · `executeSync` · `getFirstSync` · `getAllSync` · `closeSync` ·
   `withTransactionSync`. No async variant exists and the concurrency argument stands.
2. **`writeTransaction` is implemented over the port, not via `withTransactionSync`** — Expo's wrapper is
   a deferred `BEGIN`/`COMMIT` with no retry; v1's is `BEGIN IMMEDIATE` + `withRetry` + typed `T`.
3. **The port pins the miss sentinel as `undefined`**; an adapter whose engine answers `null`
   (`expo-sqlite`) maps it with `normalizeMiss`. Pinned by `core/src/store/connection.test.ts`.
4. **Statements are prepared per call and released per call** (v1 has no statement cache). The port
   exposes no `finalize`.
5. **Adapter isolation.** `node:sqlite` only in tests/CI; `expo-sqlite` only in `app/`. Guarded by
   `core/test/boundary-node-adapter.test.ts` (the app's bundle half is L2's).
6. **Web: sync reads must be row-bounded** — the web sync path needs `crossOriginIsolated` and a sync
   result over 1 MiB throws. L1 must not build a whole-vault sync read (L4's problem).

## Review Focus

1. A read that misses a row returns **`undefined`, never `null`** — a `null` reaching v1 code
   (`if (row === undefined) throw`) turns a loud failure into a silent wrong path (→ T1).
2. A write that throws mid-transaction leaves **no partial row and rethrows the original error**, on
   both adapters (→ T2).
3. A `core/vault` module reaching a provider/engine module **fails the guard**, and the guard fails when
   the vault directory is empty (non-vacuity) (→ T7).
4. A consumer importing a **moved type from its old path** fails to compile rather than resolving to a
   stale duplicate (→ T4).
5. The **taxonomy artifact and its drift gate travel together** — retiring the mirror must not leave the
   picker's vocabulary unverifiable (→ T5).

## Corrections to the L0 breakdown (found at source before building)

- **The seed belongs at `core/seed/`, not `core/src/seed/`.** `TAXONOMY_PATH` is
  `new URL("../seed/domain-taxonomy.yaml", import.meta.url)` — the one-level-under-the-package-root trick
  that makes the file resolve from **both** `src/` (tsx) and `dist/` (the built entry the app imports;
  `docs/ARCHITECTURE.md` §2.4). Moving it to `src/seed/` breaks the `dist/` resolution, which only the
  post-`build` CI step would catch. Kept: `core/seed/` + `../../seed/…` from `src/store/`.
- **`scripts/w9-*.ts` reach into `worker/`** (`../worker/src/engine/*`, `../worker/src/queue.js`), and
  every one of those files imports `@astrolab/store`. Root `tsconfig.json` typechecks `scripts/`, so
  retiring `store/` strands the calibration harness through the **required** `build` job. T6 parks the
  two scripts from the root project with a comment naming L3 as the re-homer; nothing is deleted.
- **`workspaces: ["app","core"]` is safe before `app/` exists** — npm treats each entry as a glob and
  ignores a directory that is not there (verified with `npm install --package-lock-only` on a
  throwaway workspace set). L2 only has to create the directory.
- **The NFR suites retire *with a successor named*, not silently.** `api/src/*.test.ts`'s three HTTP
  suites (`nfr-a1` · `nfr-p1` · `nfr-u1`) cannot move — they drive `api/src/server.ts`, which retires.
  So they are deleted in T3 and **re-homed by the lane §11 assigns**: A1 → L1 (T7's
  `core/test/nfr-a1.test.ts`, in process); p1 → L3 (its in-flight half stays in
  `worker/src/nfr-p1.test.ts` until L3 moves the engine); u1 → L2 (a completed-flow test). `nfr-q1`
  and `nfr-d1` are in-process already and move with their modules
  (`core/test/nfr-q1.test.ts`, `core/src/export/nfr-d1.test.ts`). The other two live in `git show`
  for their lanes — named here so nothing is lost between the retirement and the re-home.
- **Flagged, not decided: the package entry exports the store's surface only.** `core/src/index.ts`
  re-exports `./store/index.js`; the vault use-cases (`core/src/vault/*`) and the domain modules
  (`core/src/domain/*`, `core/src/types.ts`) are reachable *within* the package but not from
  `@astrolab/core`. `core/package.json` carries no `exports` map, so the app must consume them by
  subpath (`@astrolab/core/src/vault/capture.js`) or L2/L3 widen the entry. Left to L2's intake: it
  owns the app's first real import, and the shape of that import is the app's decision, not L1's.

---

### T1 · `core/` workspace + the synchronous `SqliteConnection`

**Files:** create `core/package.json`, `core/tsconfig.json`, `core/tsconfig.build.json`,
`core/src/index.ts`, `core/src/store/connection.ts`, `core/src/store/connection.node.ts`,
`core/src/store/connection.test.ts`, `core/test/boundary-node-adapter.test.ts`; modify root
`package.json` (add the `core` workspace).

- [x] Write the failing test: open an in-memory connection, `exec` a `CREATE TABLE`, `prepare` + `run` a
      row, `get` it back, `all` it back, `close`; assert a miss is `undefined`.
- [x] Run it — fails (no module).
- [x] Declare the port: `exec(sql)` · `prepare(sql): SqlStatement` · `Statement.run(…)` · `.get(…)` ·
      `.all(…)` · `close()`, with the miss sentinel and the per-call statement lifetime documented on
      the type.
- [x] Implement `connection.node.ts` over `node:sqlite` (`DatabaseSync`; `prepare`/`run`/`get`/`all`;
      `busy_timeout` per connection).
- [x] Add the device-parity test: an engine that answers `null` on a miss silently skips a v1-shaped
      loud branch until it is routed through `normalizeMiss`.
- [x] Add the adapter guard: no non-test `core/src` module may import `connection.node.js`
      (non-vacuity: the scanner is checked against all three import forms and the walk asserts it saw
      the file that *does* import it). **Seen failing** with a planted export in `src/index.ts`.
- [x] Run `npm test -w core` green; `npm run typecheck`, `npm run lint`, `npm run format` green.
- [x] **Pin the device engine:** `expo-sqlite@58.0.13` (invariant 1a — *L1 creates the pin*). Created as a
      root `overrides` entry (`"expo-sqlite": "58.0.13"`), so wherever L2's `app/` declares the
      dependency it resolves to the verified version; nothing is installed into `core/`, which never
      resolves `expo-*` (invariant 5), and `npm ci` is unchanged (verified against the real command).
      Recorded in the PR body and in `connection.ts`'s port note, so it is a fact about the repo rather
      than prose in one place.

### T2 · Move the store and retarget it onto the port

**Files:** move `store/src/*` → `core/src/store/*`, `store/seed/*` → `core/seed/*`, `store/test/*` →
`core/test/*`; modify `core/src/store/{store,config,migrate,runs,vault,sparks,suppression,domain-map,
domain-seed,mechanism}.ts` and their tests; re-scope `core/test/{harness.ts,writer.ts,writers.test.ts}`.

- [x] Write the failing test: `openStore(conn)` sets `foreign_keys=ON` and WAL; `writeTransaction`
      commits on success and rolls back + rethrows when the body throws.
- [x] `git mv` the three trees.
- [x] Retarget `openStore`/`writeTransaction` onto `SqliteConnection`, keeping `BEGIN IMMEDIATE`, the
      short transaction and `withRetry` as a guard whose comment now says it is no longer load-bearing
      (single in-process writer).
- [x] Replace the `DatabaseSync` type imports with the port's type; fix `TAXONOMY_PATH` to `../../seed/`.
- [x] Run `npm test -w core` — the v1 store suites pass against the node adapter.
- [x] Re-scope or delete the two-process tests (`harness.ts` spawns a child; `writers.test.ts`) — a
      second process is not the model; single-writer assertions replace them.

### T3 · Move the vault use-cases off HTTP

**Files:** `git mv api/src/*.ts` → `core/src/vault/*` (minus `server.ts`, `index.ts`, `spark-events.ts`,
and `export.ts` → `core/src/export/export.ts`, a **verbatim relocation L4 owns**); `metrics*.ts` move as
local queries.

- [x] Write the failing test: a use-case returns a **typed result** where the v1 handler returned a
      status code.
- [x] Strip the HTTP wrapping, the bearer auth and the error envelope; keep the use-case bodies.
- [x] Run the moved suites green.

### T4 · Move the domain and re-home the types

**Files:** `git mv client/src/api/types.ts` → `core/src/types.ts`; `git mv client/src/domain/*` →
`core/src/domain/*`.

- [x] `git mv` both; re-point the 16 `../api/types.ts` specifiers at `../types.js`.
- [x] Fix the two **runtime** imports (`onboarding.ts` → `createIdea`; `decision.test.ts` → `ApiError`).
- [x] Re-point `types.ts`'s `§` citations at ARCHITECTURE v2 §2/§6.
- [x] **Do not port `domain/deck-interaction.test.ts`** (node-only source-text guard; its intent is L2-5).
- [x] Run the domain suites green.

### T5 · The taxonomy has one source

**Files:** `core/src/store/domain-seed.ts`, `core/src/domain/taxonomy.ts` (+ its test), the
`o1-taxonomy` job's paths.

- [x] Write the failing test: `core/domain/taxonomy.ts` resolves the picker vocabulary from the **seeded
      `domain_cluster` rows**, not an inline list.
- [x] Drop the mirror; keep the types and the curated ordering. Keep `o1_check.py` + `schema.test.ts`
      guarding the YAML.
- [x] Update the **required** `o1-taxonomy` job's paths (`store/seed/…` → `core/seed/…`,
      `store/test/o1_check.py` → `core/test/o1_check.py`).
- [x] Run the migration suite (`0003`/`0004` rebuilds, `PRAGMA foreign_keys`, `ux_spark_live`,
      `ON CONFLICT`, WAL) against `node:sqlite`; record the emulator/OPFS row as a **manual sign-off
      item** (invariant 8/9).

### T6 · Retire the server packages and fix the workspace

- [x] `git rm -r api/ store/ client/ deploy/ .github/workflows/deploy.yml` — **not `worker/`**.
- [x] `workspaces: ["app","core"]`; fix `tsconfig` references, `.prettierignore` (`core/seed/`),
      `.env.example` (drop the deploy/API/bearer values).
- [x] Park `scripts/w9-calibrate.ts` + `scripts/w9-c5-fixture.ts` from the root project, with the
      comment naming L3 (see *Corrections*).
- [x] `npm run lint && npm run format && npm run typecheck && npm test && npm run build` — green.
- [x] Confirm all three required jobs still report (this PR touches `.github/`).

### T7 · The A1 guard — the structural edge **and** the fault injection (new + carried)

**Files:** `core/test/boundary-a1.test.ts`, `core/test/nfr-a1.test.ts`.

ARCHITECTURE §4 names **both** halves of NFR-A1, and the carry-over table (§13) says the A1
fault-injection *keeps its shape*. So T7 is two files, not one: the new **structural** guard (§13.4)
and the in-process re-home of v1's `api/src/nfr-a1.test.ts`, whose lane this is (§11 NFRs → L1 (A1)).

- [x] Write the structural guard: no non-test module under `core/src/vault/**` imports
      `core/src/provider/**` or `core/src/engine/**`, with the walk and the boundary rule each
      **non-vacuous** (the vault dir holds ≥12 modules; the rule refuses a provider/engine reach and
      accepts the vault's own `./engine-state.js`).
- [x] **See it fail** with a planted import (`core/src/vault/ideas.ts` → `../provider/index.js`),
      restore; see it pass — and the same pipeline fails on a synthetic planted module, so the
      mutation is reproducible without editing a real file.
- [x] Re-home the **fault injection** in process: capture · list · detail · iterate · fork · delete,
      each passing while `engineState` reads **E4**, with the discriminating **E1** fixture and the
      non-vacuity vault (v1's claims 1–3, HTTP swapped for in-process calls; the injection itself is
      L3's, attributed not restated).

**Deliverable:** `core/` builds and its store + vault + domain suites are green in CI; the server
packages are gone; the boundary guards bite.
