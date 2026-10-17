# ADR-0006: Local-only Expo app — on-device SQLite, device-direct provider, no server tier

- **Status:** Proposed (MVP) — supersedes **ADR-0005**; amends **ADR-0001**, **ADR-0003**, **ADR-0004**; leaves **ADR-0002** standing
- **Date:** 2026-10-17
- **Context:** `docs/ARCHITECTURE.md` §1, §5, §8, §9, §13 · the owner's call (`d178c664`) · David's re-triage (`0a14a749`)
- **Deciders:** architecture (Max) — review David

## Context

The MVP was designed (v1) as a **single host**: an API service, a worker process, SQLite-on-host, and an AWS +
Tailscale deploy (ADR-0001/0004/0005; `docs/DEPLOY*.md`). The owner has since ruled (`d178c664`, 2026-10-17) that
the MVP is rebuilt as a **store app**, **all data on device**, with AI kept on the **user's own API key**, the
**server tier and AWS deploy cancelled**, as a **rebuild, not a reuse**. Nothing was ever deployed and no host was
touched, so there is nothing to unwind.

This forces four coupled decisions the PRD deliberately left open (`PRD.md` §4 names no technologies):

1. **The client.** v1 shipped a mobile-first **PWA** (ADR-0005). The requirement is a **store app** — iOS + Android
   builds — plus web from the same codebase. A PWA cannot ship to the stores.
2. **The store.** v1's SQLite was an **embedded engine on a host with two writer processes** (ADR-0001). If
   "nothing leaves the device" holds, the vault moves into the app sandbox.
3. **The AI.** v1's engine called a provider from a server process that held the credential (ADR-0003). With no
   server, the device calls the provider, and the credential is the **user's**.
4. **The engine.** v1 ran an in-process queue inside a long-lived worker (ADR-0004). With no worker, the engine
   runs inside the app, which the OS suspends at will.

Hard constraints carry over unchanged: **no vector DB / ANN index** (`PRD.md` §3.3 item 7) and **no user-facing
similarity surface** (`VISION.md` §8 item 4).

## Decision

**The app is the whole system. No backend, no API, no worker, no AWS.**

- **Client — Expo (React Native).** One TypeScript codebase → the iOS + Android store builds, plus web
  (`react-native-web`). **Native-first**: web is a constrained second target, because two platform facts (below)
  make it so. ADR-0005 is **superseded**.
- **Store — on-device SQLite, opened through a port.** The same **twelve tables** and migrations
  (`docs/SCHEMA.md`), in the app sandbox, **one writer**. `core/` opens SQLite through a `SqliteConnection` port
  with two adapters: `expo-sqlite` (device) and `node:sqlite` (tests/CI) — so the v1 `store`/`api` suites run
  unchanged in substance. **ADR-0001 is amended, not superseded**: the engine is the same SQLite; what retires is
  the *two-writer* posture (WAL + `busy_timeout` + retry-for-`SQLITE_BUSY`), which existed **only** because the
  API and the worker opened one file from two processes. One in-process writer is strictly simpler.
- **AI — device → provider direct, on the user's key.** The one provider interface is unchanged (ADR-0003), now
  implemented **inside the app**; the key is read from the **platform secure store** at call time and never
  touches the vault, the export, or a log. The `provider: { zdr: true }` pin is kept and is enforced **by the app**
  — if the user's account cannot be routed to a ZDR endpoint, the call **fails closed**. ADR-0003 is **amended**.
- **Engine — in-process, foreground-bound, resumable.** The two-stage ANN-free engine (ADR-0002) is unchanged.
  It runs in the app process; a run advances **only while the app is foregrounded**, is **resumable** from
  `spark_run` + the vault revision stamp, and delivers via an **in-process event** (SSE and its polling fallback
  retire). The run's body/commit split — a stale run writes nothing — is carried verbatim. ADR-0004 is **amended**.
- **Durability — export/import is the transfer path.** The export JSON is unchanged; the on-host file-copy backup
  is gone. The vault file is **excluded from platform backup** (`allowBackup=false`,
  `NSURLIsExcludedFromBackupKey`) — the faithful reading of *"nothing leaves to the cloud"* — with the consequence
  stated: *device loss = vault loss* until Drive sync (post-MVP).
- **Encryption at rest is OUT for the MVP**, matching `PRD.md` §6; the OS sandbox is the at-rest defence, and
  SQLCipher is the named post-MVP upgrade **behind the same `SqliteConnection` port**.
- **Two workspaces:** `app/` (Expo) + `core/` (portable store + vault + domain + engine + provider). The v1
  `api/`, `worker/`, `store/`, `client/` packages retire. `docs/ARCHITECTURE.md` §13 is the carry-over table.

## Consequences

- **Positive:** requirement 2 is **structural**, not policy — with no server, "nothing leaves the device" is a
  property of the deployment, not a promise. The only egress is a run's payload (§5).
- **Positive:** the v1 **domain model, engine, taxonomy, lineage, and tests** largely **carry over** — `store/src`
  becomes `core/store`, `client/src/domain` becomes `core/domain` (4 of 12 modules verbatim), and the `api` route
  handlers become `core/vault` use-cases. This is a *move with a port*, not a rewrite; the ADR-0001 amendment is
  small **because the retiring concurrency model was an artifact of the split, not of the store.**
- **Positive:** one language, one toolchain, one artifact per platform; no host to run, secure, or pay for.
- **Negative / bounded — durability.** No host copy and no platform backup ⇒ **the device is the only copy**;
  NFR-D1 holds **through export**. This is the rebuild's sharpest cost and it is stated, not hidden (§8, §11).
- **Negative / bounded — the engine is foreground-bound.** P1's bound is restated as **p95 ≤ 60 s of active
  foreground time at ≤ 500 ideas**; sparks advance only while the app is open (§4.1, §11).
- **Negative / bounded — web is second-class by platform fact.** No `expo-secure-store` on web (key is
  session-only in memory); `expo-sqlite` on web is OPFS + Metro wasm + `COEP`/`COOP` and lacks
  `withExclusiveTransactionAsync` (feature-detect); device→provider needs a per-provider CORS header map on web.
  Native is the primary target.
- **Bounded / controlled (PRIV1).** No server ever sees the data — a strengthening. New residuals: the key is the
  user's and, on web, sits in memory for the session; the ZDR classification stays provider-attested, and the pin
  now runs against the user's account and fails closed.
- **Reversible.** The `SqliteConnection` port and the provider interface are the two seams; a future server tier
  or a local model re-enters through them without touching vault logic.

## Alternatives considered

- **Keep the v1 server and add a store client.** Rejected: it does not meet requirement 2 (a server *is* the
  cloud) and re-opens the whole deploy lane the owner cancelled.
- **Expo but keep a server for the AI (a key-holding proxy).** Rejected: the proxy would see every idea, and it is
  a server tier by another name. The owner chose the **user's own key**; a proxy is the opposite.
- **PWA plus a Capacitor store wrapper.** Rejected: "rebuild, not reuse", and it keeps the DOM stack the design
  system's shadcn citation drags in, with a weaker native story than Expo.
- **On-device model instead of a provider (no egress).** Not rejected on merit — it strengthens PRIV1 — but
  deferred: it is heavy on phones and lower quality, and the owner ruled the AI is kept on a provider key. The
  adapter interface keeps it a drop-in later.
- **SQLCipher (encryption at rest) now.** Deferred, not rejected: `PRD.md` §6 already defers encryption at rest,
  and it changes the vault-open path and the export format. It belongs behind the `SqliteConnection` port,
  post-MVP.
- **Supersede ADR-0001 outright.** Rejected as the wrong degree of change: the *store* decision (SQLite, one file,
  relational constraints, no vector index) is untouched; only the **writer model** changes, and only because the
  second process is gone. **Amend** records that precisely.

## Verification

- **NFR-A1:** module-boundary guard — `core/vault/**` may not import `core/provider/**` — **seen failing** in the
  state it forbids (repo guard discipline, `AGENTS.md`), plus the provider-disabled vault suite.
- **NFR-D1:** **export → wipe/reinstall → import** round-trip; idea, version, lineage and provenance counts survive.
- **NFR-PRIV1:** key-hygiene guard (the key appears in no vault row, no export, no log) + the retargeted
  `zdr-evidence` job.
- **NFR-P1:** timed run with an injected provider delay, measured in **foreground** time.
