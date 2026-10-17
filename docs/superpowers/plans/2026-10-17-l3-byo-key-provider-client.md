# L3 · BYO-key provider client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Issue:** [#166](https://github.com/assafbz/AstroLab/issues/166) · **Lane owner:** Ari · **Branch:** `feat/166-byo-key-provider-client`, cut from `df6eea12`.

**Goal:** The device calls OpenRouter **on the user's own key**, the key never leaks (no vault row, no
export, no log), and a run that a suspension interrupts is safely re-run — with the engine and the
provider boundary relocated into `core/` and `worker/` retired.

**Architecture:** `core/src/engine/**` (the four stages, the run lifecycle) and `core/src/provider/**`
(the one adapter) move out of `worker/` unchanged in behaviour; `core/src/provider/key.ts` is the single
module that reads the key, through an injected `KeyStore` port that the **app** implements (native
secure store / web session memory). The composition root is `app/`: it builds the connection, the key
store, the provider and the run driver. `core/` never imports `expo-*`.

**Tech Stack:** TypeScript · OpenRouter behind the `Provider` interface · `node:sqlite` (tests/CI) ·
`expo-sqlite@58.0.13` (device) · vitest.

**Spec:** `docs/ARCHITECTURE.md` (v2) §2/§3/§4/§5/§9/§13 · `docs/adr/0006-local-only-expo-app.md` ·
`docs/superpowers/plans/2026-10-17-l1-l4-local-only-rebuild.md` (the L0 breakdown; its invariants 1–11
are binding here and are cited by number below).

## Global Constraints

- **`core/src/vault/**` must not import `core/src/provider/**`** (nor `core/src/engine/**`) — NFR-A1.
  It follows that the E4 *cause* vocabulary cannot live in the provider: see Correction 5.
- **The API key must not appear** in any vault row, the export, or a log — NFR-PRIV1. `core/` never
  imports `expo-secure-store` (invariant 4).
- **`core/` is a package both a device bundle and `tsc` compile** (invariant 6): no `node:*` import
  outside the adapters, no `process.env` in a portable module.
- **Never sleep or poll** in tests or code (harness override 1). The v1 worker's poll loop is deleted,
  not ported.
- **One language: TypeScript**; explicit type annotations on exported signatures.
- **A held-lane PR carries no closing keyword + `#n`** anywhere in body or commits (write `Part of
  #166`). L3 closes on the PR that lands the **app** half (T5) — the issue's Deliverable is the
  device behaviour, and `app/` does not exist until L2 (#165).
- **Any PR touching `.github/` must show the three required jobs still report** (`lint · format ·
  typecheck · test · build`, `citation ref-lint`, `o1-taxonomy`).
- **`provider: { zdr: true }` fails closed** — a model the provider does not classify ZDR is a failed
  call, never a silent downgrade (§5, NFR-PRIV1).

## Interface invariants (L0's 1–11, plus the six this lane settles)

12. **The `KeyStore` port** (invariant 4), in `core/src/provider/key.ts`:

    ```ts
    export interface KeyStore {
      get(): Promise<string | null>;
      set(key: string): Promise<void>;
      clear(): Promise<void>;
    }
    ```

    Async because both real adapters are (`expo-secure-store`'s `getItemAsync`; the web one is
    memory), and because the key must be able to *change* under a live process.
13. **The adapter resolves the key per request, not per boot.** v1 read `OPENROUTER_API_KEY` once in
    `createAdapterFromEnv`; the rebuild passes the `KeyStore` down to `createOpenRouterAdapter` and
    reads it inside the call. A missing/blank key is `NoKeyError` — a **failed call**, never a request
    sent with an empty `Authorization`.
14. **`runOnce` stays; the poll loop goes.** `core/src/engine/queue.ts` keeps
    `cutVault`/`runOnce`/`RunBody`/`RunCommit`/`RunResult` verbatim in behaviour; `startWorker` and
    `WorkerOptions` are **deleted** (polling is banned, harness override 1). The app's driver (T5)
    calls `runOnce` on foreground.
15. **`bootVault(conn)` is portable.** `core/src/boot.ts` exports `bootVault(conn: SqliteConnection):
    void` = `migrate → seedDomainTaxonomy → seedGateConfig → requeueOrphanedRuns`. The v1 `bootWorker`
    (path + `node:sqlite` + `mkdirSync`) is not ported; the node adapter and `fs` stay in tests and
    scripts.
16. **The crash-orphan requeue is the resume mechanism.** A run left `RUNNING` by a kill is requeued
    at the next boot (`requeueOrphanedRuns`) and re-run by the driver; the body is side-effect-free
    (invariant 3), so a re-run is safe by construction, not by a check.
17. **The boundary's `provider.zdr` pin is unchanged**, and the pin remains **one** call site — the
    moved guard keeps that claim.

## Review Focus (the L0 list, held against this lane)

1. **Provider answers invalid JSON / a non-ZDR-routable model** → a failed call, **nothing stored**,
   E4. Vault untouched (NFR-A1, NFR-PRIV1). → T4.
2. **App suspended or killed mid-run** → next foreground **re-runs**; no partial writes, no duplicate
   live offers, no lost committed idea. → T1 (the lifecycle) + T5 (the driver).
3. **No key set / wrong key / offline / timeout / 429 / CORS-blocked** → E4 with the right cause, never
   a blank deck and never a request carrying a bad key. → T3 + T4.
4. **The key leaks into a log, a vault row or the export** → the hygiene guard reddens. → T3.
5. **A sync-only port meets a web runtime** → `crossOriginIsolated` + the 1 MiB sync cap (invariant 10)
   are named where a reader will hit them; nothing in `core/` calls the async transaction API that web
   lacks. → T4.

## Corrections to the L0 breakdown (found at source before building)

1. **The boundary guard's claim 1 is already L1's.** `core/test/boundary-a1.test.ts` walks
   `core/src/vault/**` and fails on a `provider`/`engine` reach — the edge the L0 line *"re-point the
   boundary test's path set (`api`/`store` → `core/vault`), same rule"* describes. The moved
   `core/src/provider/boundary.test.ts` therefore keeps its **other** claims (boundary-reaches-only-
   siblings · the ZDR pin's one site · one call site per operation · no synthetic seeds) re-pointed,
   and points at the vault-side guard instead of duplicating it.
2. **`worker/src/boot.ts` does not move as-is** — it is a path + `node:sqlite` + `fs` function, and
   neither belongs in a portable module (invariant 15).
3. **`worker/src/{index,compose}.ts` partly die.** The process entry is deleted (no worker process);
   `engineFromProvider` stays (portable, provider-free wiring the app calls) but
   `createEngineFromEnv` — env key, env model — goes with the server tier, replaced by the app's
   `KeyStore`.
4. **`app/src/engine/runScheduler.ts` and the two key adapters need `app/`** (L2, in flight), so the
   lane runs in two halves on one branch: **T1–T4 are core-only and land first; T5 is held until L2's
   scaffold is on `main`.** Flagged in the lane's pickup, not guessed.
5. **The E4 cause vocabulary lives in `core/src/types.ts`, not in the provider.** NFR-A1 forbids
   `vault → provider`, and `vault/engine-state.ts` is what reports E4 — so a provider-owned enum
   could not be read there. The **tag** is shared vocabulary; the provider *classifies* an error into
   it, and the vault *parses* it back out of the run's `error` column.

## Tasks

### T1 · Move the engine and the provider into `core/`; retire `worker/`

**Files:** `git mv worker/src/{engine,provider} core/src/` · `git mv worker/src/queue.ts
core/src/engine/queue.ts` · `git mv worker/src/boot.ts core/src/boot.ts` (rewritten) ·
`git mv worker/src/*.test.ts core/test/` · delete `worker/` · `core/src/index.ts` ·
`scripts/w9-{calibrate,c5-fixture}.ts` · root `tsconfig.json`

- [ ] Move the two directories, `queue.ts`, `boot.ts` and the process-level suites; leave `worker/`
      empty, then `git rm -r worker/`.
- [ ] Re-point every `@astrolab/store` specifier to the package's own `../store/index.js`; every
      `../queue.js` to `./queue.js`; `boot.ts` → `bootVault(conn)` on the port (invariant 15).
- [ ] Delete `startWorker`/`WorkerOptions` and the process entry (invariants 14, Correction 3);
      re-scope `queue.test.ts` to the run lifecycle it still owns.
- [ ] Export the lane's surface from `core/src/index.ts` (engine, provider, key, `runOnce`,
      `engineFromProvider`) — the app is the composition root and this is its door.
- [ ] Re-home `scripts/w9-{calibrate,c5-fixture}.ts` onto `@astrolab/core` + `core/src/…` and drop
      the root `tsconfig.json` exclude L1 parked them behind (its comment names L3 as the re-homer).
- [ ] Run: `npm run lint && npm run format && npm run typecheck && npm test && npm run build` — green,
      with the moved suites counted in the total.

**Deliverable:** `worker/` is gone, `core/` owns the engine and the provider, the whole suite is green.

### T2 · Re-point the boundary + privacy guards to the rebuild's shape

**Files:** `core/src/provider/boundary.test.ts`

- [ ] Re-scope the walk: every `src/` file of every workspace **except** the boundary's own directories
      (`core/src/provider/**`, `core/src/engine/**`), with the app's door (`core/src/index.ts`) named
      as the one allowed re-export site.
- [ ] Re-point the v1 surface names (`api/src/capture.ts`, `client/src/App.tsx`, `store/`) at their
      core homes; keep every non-vacuity leg.
- [ ] Keep claims 2–4 and the one-call-site claim; replace claim 1 with a loader that asserts
      `core/test/boundary-a1.test.ts` exists and is non-vacuous (Correction 1).
- [ ] **See it fail**: plant `import { … } from "@astrolab/core"` in a `core/src/vault/**` module and a
      second `provider: { zdr: … }` site; watch each redden; restore.

**Deliverable:** the guard describes the rebuild's edges, and each arm is mutation-checked.

### T3 · The key: the port, the accessor, and the hygiene guard

**Files:** `core/src/provider/key.ts` (new) · `core/src/provider/key.test.ts` (new) ·
`core/src/provider/types.ts` (`NoKeyError`)

- [ ] Write the failing guard first: no module outside `core/src/provider/**` imports the accessor; no
      `expo-*` specifier anywhere under `core/src/**`; the key string never reaches a log call
      (`console.*`, `process.stdout`), a vault row, or the export codec.
- [ ] **See it fail** with a planted `console.log(key)` and a planted `expo-secure-store` import;
      restore.
- [ ] Implement `KeyStore` + `NoKeyError` + the accessor that normalises a blank key to `null`
      (invariants 12–13).

**Deliverable:** one module reads the key, the guard bites, and the leak classes are enumerated.

### T4 · Device-direct: the adapter, the failure taxonomy, the web posture

**Files:** `core/src/provider/openrouter.ts` · `core/src/provider/failure.ts` (new) ·
`core/src/types.ts` (`RunFailureCause`) · `core/src/engine/queue.ts` · `core/src/vault/engine-state.ts`

- [ ] `openrouter.ts` takes the `KeyStore` and resolves the key **per request**; no key ⇒ `NoKeyError`
      before any fetch (invariant 13); the ZDR pin stays one call site.
- [ ] `RunFailureCause` (`no-key` · `invalid-key` · `offline` · `timeout` · `rate-limited` ·
      `cors-blocked` · `invalid-output` · `unavailable`) in `core/src/types.ts` with `failureTag` /
      `parseRunFailure`; the provider classifies, `runOnce` writes the tag into `spark_run.error`, and
      `engineState` reports the cause in E4 (Correction 5).
- [ ] Tests: invalid JSON stores nothing (Review Focus 1); each cause maps to its arm; a run with no
      key never reaches the transport.
- [ ] Web posture: the per-provider CORS header map + a `native-only` marker with its reason; assert
      nothing under `core/src/**` names `withExclusiveTransactionAsync` / `withTransactionAsync`
      (web-unsupported, invariant 10) and document the 1 MiB sync cap at the export seam.

**Deliverable:** the boundary is key-driven and every provider failure lands in a named E4 arm.

### T5 · The app half — HELD until L2's scaffold is on `main`

**Files:** `app/src/engine/runScheduler.ts` · `app/src/keystore.native.ts` · `app/src/keystore.web.ts`

- [ ] The two `KeyStore` adapters (native secure store; web session memory, never `localStorage`).
- [ ] The foreground run driver: single-flight, calls `runOnce` on foreground, in-process events, no
      polling; kill mid-run ⇒ next foreground re-runs (invariants 14, 16).
- [ ] The emulator sign-off: kill mid-run, background/foreground, no duplicate offers.

**Deliverable:** `#166`'s own sentence — *the device calls OpenRouter on the user's key, the key never
leaks, and runs survive suspension* — is true on a device.
