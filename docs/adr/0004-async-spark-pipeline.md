# ADR-0004: Async in-process queue; vault never imports the AI boundary

- **Status:** Proposed (MVP)
- **Date:** 2026-10-12
- **Context:** `docs/ARCHITECTURE.md` §4
- **Deciders:** architecture (Ari) — review Max

## Context

Sparks must be produced **asynchronously** and **never block vault operations**, delivered within a bounded
time (NFR-P1). The core vault — capture, read, iterate, fork — must function **independently of the Spark**;
AI unavailability degrades only sparks (NFR-A1). The MVP is single-user, so heavyweight infrastructure must
earn its place.

## Decision

- **Queue:** a lightweight **in-process job runner** (a `spark_run` table plus a worker loop) — no external
  broker. A vault mutation stamps `vault_meta.revision` and enqueues a run tagged with it; a run whose revision
  is stale is discarded and **superseded** by the newer one.
- **Boundary:** the vault module **does not import** the AI-provider interface. Only the worker does. This is
  enforced structurally, so NFR-A1 holds by construction, not by discipline. Domain-tag clustering also lives
  in the worker (ADR-0002), so **no vault path — capture included — normalises tags via AI**.
- **Delivery:** the client reads `GET /v1/sparks/state` (E0–E4) and the offered list, and subscribes to
  `GET /v1/sparks/events` (SSE) with a polling fallback; it never waits on a run.
- **Store concurrency:** the API and worker both write the one SQLite file; WAL + `busy_timeout` + bounded
  retry handle the serialization (ADR-0001).

## Consequences

- **Positive:** NFR-P1 — mutations return immediately; sparks arrive out of band.
- **Positive:** NFR-A1 — with the provider down, no vault code path can fail; the deck shows **E4 Unavailable**
  and already-offered sparks stay reviewable (`FLOW.md` §5.6).
- **Positive:** a single-unit deployment; no broker to run or secure for one user.
- **Negative / bounded:** the queue is not durable across a process crash mid-run; a run is cheap to redo and
  `DONE`/`FAILED` is recorded, so a restart simply re-enqueues (`NFR-D1` guards *ideas*, which are committed
  before any run).
- **Supersession:** if throughput or multi-user later demands it, the boundary is one table plus one loop —
  replaceable by a real queue without touching the vault.

## Verification

- **Fault injection:** disable the provider; run the vault suite; assert all vault operations pass and the deck
  reports E4 (NFR-A1).
- **Timed test:** inject AI delay/failure; assert vault request latency is unchanged and sparks deliver within
  the bound (NFR-P1).
