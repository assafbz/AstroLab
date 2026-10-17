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
- **A held-lane PR carries no closing keyword + `#n`** anywhere in body or commits; write `Part of #164`.
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
- [ ] **Pin the device engine:** record `expo-sqlite@58.0.13` as the app's dependency in the PR body
      (L1 does not install it into `core/` — the app owns that dependency).

### T2 · Move the store and retarget it onto the port

**Files:** move `store/src/*` → `core/src/store/*`, `store/seed/*` → `core/seed/*`, `store/test/*` →
`core/test/*`; modify `core/src/store/{store,config,migrate,runs,vault,sparks,suppression,domain-map,
domain-seed,mechanism}.ts` and their tests; re-scope `core/test/{harness.ts,writer.ts,writers.test.ts}`.

- [ ] Write the failing test: `openStore(conn)` sets `foreign_keys=ON` and WAL; `writeTransaction`
      commits on success and rolls back + rethrows when the body throws.
- [ ] `git mv` the three trees.
- [ ] Retarget `openStore`/`writeTransaction` onto `SqliteConnection`, keeping `BEGIN IMMEDIATE`, the
      short transaction and `withRetry` as a guard whose comment now says it is no longer load-bearing
      (single in-process writer).
- [ ] Replace the `DatabaseSync` type imports with the port's type; fix `TAXONOMY_PATH` to `../../seed/`.
- [ ] Run `npm test -w core` — the v1 store suites pass against the node adapter.
- [ ] Re-scope or delete the two-process tests (`harness.ts` spawns a child; `writers.test.ts`) — a
      second process is not the model; single-writer assertions replace them.

### T3 · Move the vault use-cases off HTTP

**Files:** `git mv api/src/*.ts` → `core/src/vault/*` (minus `server.ts`, `index.ts`, `spark-events.ts`,
and `export.ts` → `core/src/export/export.ts`, a **verbatim relocation L4 owns**); `metrics*.ts` move as
local queries.

- [ ] Write the failing test: a use-case returns a **typed result** where the v1 handler returned a
      status code.
- [ ] Strip the HTTP wrapping, the bearer auth and the error envelope; keep the use-case bodies.
- [ ] Run the moved suites green.

### T4 · Move the domain and re-home the types

**Files:** `git mv client/src/api/types.ts` → `core/src/types.ts`; `git mv client/src/domain/*` →
`core/src/domain/*`.

- [ ] `git mv` both; re-point the 16 `../api/types.ts` specifiers at `../types.js`.
- [ ] Fix the two **runtime** imports (`onboarding.ts` → `createIdea`; `decision.test.ts` → `ApiError`).
- [ ] Re-point `types.ts`'s `§` citations at ARCHITECTURE v2 §2/§6.
- [ ] **Do not port `domain/deck-interaction.test.ts`** (node-only source-text guard; its intent is L2-5).
- [ ] Run the domain suites green.

### T5 · The taxonomy has one source

**Files:** `core/src/store/domain-seed.ts`, `core/src/domain/taxonomy.ts` (+ its test), the
`o1-taxonomy` job's paths.

- [ ] Write the failing test: `core/domain/taxonomy.ts` resolves the picker vocabulary from the **seeded
      `domain_cluster` rows**, not an inline list.
- [ ] Drop the mirror; keep the types and the curated ordering. Keep `o1_check.py` + `schema.test.ts`
      guarding the YAML.
- [ ] Update the **required** `o1-taxonomy` job's paths (`store/seed/…` → `core/seed/…`,
      `store/test/o1_check.py` → `core/test/o1_check.py`).
- [ ] Run the migration suite (`0003`/`0004` rebuilds, `PRAGMA foreign_keys`, `ux_spark_live`,
      `ON CONFLICT`, WAL) against `node:sqlite`; record the emulator/OPFS row as a **manual sign-off
      item** (invariant 8/9).

### T6 · Retire the server packages and fix the workspace

- [ ] `git rm -r api/ store/ client/ deploy/ .github/workflows/deploy.yml` — **not `worker/`**.
- [ ] `workspaces: ["app","core"]`; fix `tsconfig` references, `.prettierignore` (`core/seed/`),
      `.env.example` (drop the deploy/API/bearer values).
- [ ] Park `scripts/w9-calibrate.ts` + `scripts/w9-c5-fixture.ts` from the root project, with the
      comment naming L3 (see *Corrections*).
- [ ] `npm run lint && npm run format && npm run typecheck && npm test && npm run build` — green.
- [ ] Confirm all three required jobs still report (this PR touches `.github/`).

### T7 · The A1 boundary guard (new)

**Files:** `core/test/boundary-a1.test.ts`.

- [ ] Write the guard: no file under `core/src/vault/**` imports `core/src/provider/**` or
      `core/src/engine/**`, with a **non-vacuity** assertion (the vault dir holds ≥1 module).
- [ ] **See it fail** with a planted import; restore; see it pass.

**Deliverable:** `core/` builds and its store + vault + domain suites are green in CI; the server
packages are gone; the boundary guards bite.
