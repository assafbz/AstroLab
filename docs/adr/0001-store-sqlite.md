# ADR-0001: SQLite as the MVP store

- **Status:** Proposed (MVP)
- **Date:** 2026-10-12
- **Context:** `docs/ARCHITECTURE.md` §2.4
- **Deciders:** architecture (Ari) — review Max

## Context

The MVP is a **single-user** vault (`PRD.md` §1.3). The data is relational: ideas with single-parent lineage
(`PRD.md` §2), provenance edges distinct from lineage (D1), and a **`(spark_id, decision_id)` uniqueness
constraint** that make decisions idempotent (`FLOW.md` §2.2). The engine must compare candidate pairs directly
and **must not** introduce a vector database or ANN index (`PRD.md` §3.3.7). Durability and an **open export**
are requirements (NFR-D1). Deferred scope includes multi-user and tenancy (`PRD.md` §6).

## Decision

Use **SQLite** as the single store — one file, **two writer processes** (the API owns vault tables, the worker
owns spark tables). Run it in **WAL mode** (readers don't block the writer) with a `busy_timeout` and bounded
retry-with-backoff on `SQLITE_BUSY`; keep every write a short transaction. Keep the schema relational and
constraint-driven — the idempotency key, single-parent lineage, and provenance edges are enforced by the
database, not by application convention. Ship a JSON export and file-level backup (§8 of the architecture).

## Consequences

- **Positive:** zero operational footprint (one file); relational constraints enforce the invariants the flow
  depends on; backup/export are trivial, satisfying NFR-D1 cheaply; no ANN infrastructure, per PRD §3.3.7.
- **Positive:** pairwise scoring at personal scale is plain SQL + a local loop — no index to maintain.
- **Negative / bounded:** SQLite takes **one file-wide write lock**, so the two writers serialize and may hit
  `SQLITE_BUSY` — handled by WAL + `busy_timeout` + retry (above). Acceptable for one user, where writes are
  short and infrequent. If contention ever bites, the fallback is to **funnel all writes through one process**
  (e.g. the API posts spark-table changes to the worker), which restores true single-writer semantics without
  changing the schema.
- **Scale-out path:** when multi-user/tenancy ships (`PRD.md` §6), migrate to **Postgres** — the schema is
  already relational; the export format (§8) is the migration-honest interchange. This ADR supersedes only then.

## Alternatives considered

- **Postgres now.** Rejected: operational weight with no MVP payoff for one user; RLS/tenancy are explicitly
  not MVP requirements (`PRD.md` §4).
- **Document store / embedded key-value.** Rejected: loses the declarative constraints (idempotency key,
  lineage) that make the flow's invariants trustworthy.
- **Vector store.** Rejected outright: `PRD.md` §3.3.7 forbids it for the MVP.
