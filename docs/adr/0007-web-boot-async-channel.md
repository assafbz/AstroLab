# ADR-0007: The web boot's writes run on `expo-sqlite`'s async channel

- **Status:** Accepted (MVP) — **amends the L1–L4 plan's interface invariant 1** ("the port is SYNCHRONOUS — no
  async variant is needed"); does not amend ADR-0006
- **Date:** 2026-11-01
- **Context:** `docs/ARCHITECTURE.md` §2, §9 · `expo-sqlite@58.0.13` `web/WorkerChannel.ts` · issue #186 · the
  L1–L4 plan's invariants 1 and 10 (`docs/superpowers/plans/2026-10-17-l1-l4-local-only-rebuild.md`)
- **Deciders:** David (triage, on Ari's instrumented finding), implemented by Max — review Ari

## Context

The L1–L4 plan pinned the store's port as **synchronous** (invariant 1) and recorded that *"no async variant is
needed"*. That was **verified off the shipped typings** — which prove the sync surface *exists*
(`execSync` · `prepareSync` · `executeSync` · `closeSync`), not that the **web worker can answer inside the
busy-wait cap the typings do not show**.

It cannot, for the **writes**. `expo-sqlite`'s web target runs SQLite in a worker and implements a sync call as a
main-thread busy-wait of at most `1_000_000` `Atomics.pause` iterations (~133 ms on a 2-core box)
(`web/WorkerChannel.ts` `invokeWorkerSync`). A read answers in 0–5 ms and clears it; a **write** — the WAL
conversion, DDL, `COMMIT`/`ROLLBACK`, `PRAGMA … = …` — fsyncs and routinely does not. Measured at the pre-fix
head: **18 red cold loads in 19**, dying at `COMMIT`/DDL/~22 sync calls in, with `Sync operation timeout` (or a
`cannot rollback - no transaction is active` cascade when the stall landed inside a migration).

Two premises were tested and are **false**, and they are recorded here so no lane re-tries them:

- **"Warm the worker first"** (option B′). The head already awaited the *open*, and the killing call answers 17
  round-trips in ~120 ms before it — the worker is provably warm at the call that dies. The spin that times out
  is *inside* the statement (its fsync), so yielding between calls cannot shorten it. Measured: 2/25 green.
- **"Raise the budget"**. It is a hard-coded iteration cap inside `node_modules`; there is no option and no
  export, and patching the dependency is not shippable.

## Decision

**The boot path runs on `expo-sqlite`'s async channel; the synchronous port stays the steady-state API.**

- **A second port, `AsyncSqliteConnection`** (`core/src/store/connection.ts`): `exec` · `run` · `get` · `all`,
  promise-returning, plus `asAsyncConnection(conn)` to present a synchronous engine as that port (tests, CI, and
  any device engine whose only async story is this port). No statement object: each call names its own SQL, so
  the adapter never issues a `prepareSync` for a write — which is exactly the thing being kept off the capped
  channel.
- **Three rules get an async twin**, and only these: `openStoreAsync` · `migrateAsync` · `seedDomainTaxonomyAsync`
  — the sequence `app/src/bootstrap.ts` runs. `core/src/boot.ts`'s `bootVault` is untouched, and `app/` does not
  route through it (see *Known divergence*). **Amended 2026-11-12 (#190):** the twins are now **five** plus the
  boot entry — `seedGateConfigAsync` · `requeueOrphanedRunsAsync` · `bootVaultAsync` join them, and the app routes
  through the entry. The rule this bullet states is unchanged (*a boot write runs on the async channel*); see
  *Amendment — #190* below for what was added and what it cost.
- **Reads stay synchronous.** `vaultSummary` is the composition root's first sync read and runs only after every
  async step has been awaited — `bootstrap.test.ts` pins that ordering with a boot held open mid-flight. The
  1 MiB sync result cap (invariant 10) is unchanged and still L4's business.
- **Not port-wide.** Invariant 1 is **amended, not retired**: `writeTransaction` stays the only sync transaction
  primitive a non-store caller can reach, `vaultMutation` is unchanged, and no steady-state read or write moved.

### What is shared, and what is restated per channel — stated plainly

| rule | status |
| :-- | :-- |
| migration ordering · positive-int version · no duplicate version · forward-only refusal | **one definition** (`orderedMigrations` · `assertForwardOnly`), called by both channels |
| in-transaction re-read before applying a migration | **one rule, two call sites** — sync `schemaVersion` / async `schemaVersionAsync` (a read is a read) |
| `foreign_keys`-off rebuild dance + `foreign_key_check` + restore | **one decision each** (`assertForeignKeysDisabled` · `assertNoForeignKeyViolations`), read through the channel |
| the seed's upsert SQL · the silent-re-point refusal · the seed's write order | **one definition** (`CLUSTER_UPSERT` · `TAG_UPSERT` · `requireDeclaredRepoint` · `seedRows`) |
| **the transaction shell** — `BEGIN IMMEDIATE` → work → `COMMIT`, `ROLLBACK`-if-open, under `withRetry` | **restated**: `writeTransaction` / `writeTransactionAsync`, and `withRetry` / `withRetryAsync` |
| **the loop that walks pending migrations** | **restated**, one per channel |

The restatement exists because the two cannot be one body: a function that returns `number` **synchronously**
cannot contain `await`, and making the *port* async is the port-wide change this ADR declines. The duplication is
therefore **guarded, not asserted**: `core/src/store/migrate-parity.test.ts` drives **both channels over the same
fixtures** and requires an identical database — identical `sqlite_master` (type · name · `sql`), identical
`user_version`, identical seed rows and counts, and identical *refusals* (same error, same message). The guard was
seen failing: perturbing the async channel's `user_version` write reddens two of its six cases.

## Consequences

- **The hazard is removed, not won.** On the web boot, zero `exec`/`prepare` posts carrying write SQL reach the
  sync channel; the only sync posts are `vaultSummary`'s read. Gate 2 measures this directly
  (`scripts/gate2-cold-load.mjs`).
- **Cost.** The seed is a few hundred idempotent upserts issued as awaited `run`s — uncapped, so correct, and
  measured rather than assumed. The async transaction shell is a second copy of the same rule, guarded by the
  parity suite; a reader who changes one and not the other gets a red test, not a divergence.
- **`asAsyncConnection` is not the web path.** The app implements the async port directly over
  `expo-sqlite`'s `…Async` methods; the bridge exists for engines that are synchronous.

### Known divergence — **RESOLVED** by #190 (2026-11-12)

`core/src/boot.ts`'s `bootVault` — `migrate → seedDomainTaxonomy → seedGateConfig → requeueOrphanedRuns` — had
**no caller in `app/` or in any shipped `core/src` module** (it was reached by tests and `scripts/w9-calibrate.ts`).
`app/src/bootstrap.ts` ran the first two steps only, per the L2 plan's Task 1. Inert while the shell rendered with
the engine down (an absent gate config is filled from `GATE_CONFIG_DEFAULTS`, and no runs existed); live the moment
L3 wired the driver, because a killed `RUNNING` run was then never requeued (invariant 16 / ADR-0004). #186 twinned
the steps that ran and did **not** widen boot behaviour; **#190** owns the reconciliation (app boot becomes one
`bootVaultAsync` in `core/`), and landed it — this paragraph is kept as the record of the divergence, not as a
description of `main`.

### Amendment — #190 (2026-11-12): the twins are five, and the app routes through the entry

Three things were added, each a consequence of the same rule rather than a new one:

- **Two more rules get an async twin.** `seedGateConfigAsync` · `requeueOrphanedRunsAsync` — the two steps
  `app/src/bootstrap.ts` had been skipping. A seed is a **write** and the requeue `UPDATE` is a write, so both are
  subject to the ~133 ms sync cap this ADR exists for; leaving them sync would have meant the app's boot was
  half-moved and the skipped steps were the half nobody watched.
- **The boot itself gets one:** `bootVaultAsync(conn: AsyncSqliteConnection)`, the async twin of `bootVault` —
  **the same four steps, in the same order, on the same rules**. Its contract is deliberately its sync twin's: it
  takes a connection the caller already opened and applied the pragmas to (`openStoreAsync`), never a path. Folding
  the opener in would have given it a *different* contract from `bootVault`, so *"the vault's boot is one
  definition"* would stop being true and a parity comparison between the two would compare unlike shapes.
- **`app/` calls the entry and names no step.** The composition root is `openStoreAsync` → `bootVaultAsync`;
  `app/src/store/boot-async-plane.test.ts` walks the shipped source and fails if any module there names a boot
  step — the sync ones *or* the async ones. That replaces a per-step habit with one call, which is the actual fix
  for the divergence above: a step run "by hand" is a step that can be forgotten.

**The duplication discipline is extended, not waived.** This ADR's parity table says the two channels' copies are
*guarded, not asserted*; the two new twins and the entry are guarded the same way —
`core/test/vault-boot-async.test.ts` drives `bootVault` and `bootVaultAsync` over one fixture (schema, taxonomy
rows, `config` rows, `run` rows, `user_version`, `sqlite_master`) and requires an identical database, plus
per-twin cases for the two new bodies (`migrate-parity.test.ts` is the pattern). A reader who changes one shell and
not the other gets a red test, not a divergence to spot.

**Cost, stated.** Five rules are now written twice — the same honest cost the original Decision records, one step
further. The alternative (make the *port* async) still retires invariant 1 and is still declined.

