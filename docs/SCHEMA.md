# Schema: Astrolab store (SQLite) — issue F3 design

> **Status:** Design for issue **F3** (`#10`). Becomes the initial forward-only migration
> (`0001_init`) once F1's monorepo layout lands; kept here as the schema of record in DDL form.
> **Source of record:** `docs/ARCHITECTURE.md` §2 (data model — the complete table set incl.
> `idea_mechanism`) and ADR-0001 / ADR-0002. Where this file and §2 differ, **§2 wins** and this file
> is the defect — file it.
> **Scope:** the tables, keys, and the partial unique index. Connection/WAL/retry belong to **F2**;
> the invariant *tests* belong to **F3**.

The DDL below applies as one forward-only migration (`0001_init`). `PRAGMA journal_mode=WAL` is set by
the store's connection setup (F2), not by the migration.

---

## 1. The tables of §2 — DDL (`0001_init`)

**Twelve** tables: the eleven enumerated in §2.1–§2.4, plus **`idea_mechanism`** (the per-idea
descriptor cache — `ARCHITECTURE.md` §2.3, §3.3 step 1; ADR-0002; W3 `#28`), added to the schema of
record 2026-10-13 per David's ruling (reading B — an omission, not a later stage).

```sql
PRAGMA foreign_keys = ON;

-- §2.1 Idea and its history
CREATE TABLE idea (
  id                TEXT PRIMARY KEY,
  hypothesis        TEXT NOT NULL,
  problem           TEXT NOT NULL,
  monetization      TEXT NOT NULL,
  domain_tags       TEXT NOT NULL,                -- JSON array; length >= 1 (PRD §2)
  lineage_kind      TEXT NOT NULL CHECK (lineage_kind IN ('ROOT','ITERATION','FORK')),
  lineage_parent_id TEXT REFERENCES idea(id),     -- set ONLY for FORK; single parent
  status            TEXT NOT NULL CHECK (status IN ('ACTIVE','NEEDS_COMPLETION')),
  visibility        TEXT NOT NULL CHECK (visibility IN ('PRIVATE')),
  current_version   INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  -- structural guard: only a FORK may carry a parent
  CHECK (lineage_kind = 'FORK' OR lineage_parent_id IS NULL)
);

CREATE TABLE idea_version (                        -- iteration history, same node (PRD §3.2.1)
  idea_id      TEXT NOT NULL REFERENCES idea(id),
  version      INTEGER NOT NULL,
  hypothesis   TEXT NOT NULL,
  problem      TEXT NOT NULL,
  monetization TEXT NOT NULL,
  domain_tags  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (idea_id, version)
);

-- §2.2 Provenance — explicitly NOT lineage
CREATE TABLE provenance_edge (
  derived_idea_id TEXT NOT NULL REFERENCES idea(id),   -- the accepted / inspired idea (a ROOT)
  source_idea_id  TEXT NOT NULL REFERENCES idea(id),   -- one of the two source ideas
  spark_id        TEXT NOT NULL,
  PRIMARY KEY (derived_idea_id, source_idea_id, spark_id)
);

-- §2.3 Sparks, runs, decisions, suppression, mechanism cache
CREATE TABLE spark (
  id                   TEXT PRIMARY KEY,
  idea_a_id            TEXT NOT NULL REFERENCES idea(id),
  idea_b_id            TEXT NOT NULL REFERENCES idea(id),
  pair_key             TEXT NOT NULL,               -- min(a,b)||'|'||max(a,b)
  direction            TEXT NOT NULL,               -- proposed idea (headline)
  claim                TEXT NOT NULL,
  what_it_takes        TEXT,
  first_step           TEXT,
  mechanism            TEXT,                        -- internal; never surfaced
  domain_distance      REAL,                        -- internal; never surfaced
  structural_alignment REAL,                        -- internal; never surfaced
  status               TEXT NOT NULL CHECK (
                         status IN ('OFFERED','RESOLVED-ACCEPTED','RESOLVED-DISMISSED','RESOLVED-INSPIRED')),
  created_at           TEXT NOT NULL
);

-- at most one live offer per pair (ARCH §3.5)
CREATE UNIQUE INDEX ux_spark_live ON spark(pair_key) WHERE status = 'OFFERED';

CREATE TABLE idea_mechanism (                       -- per-idea descriptor cache (ARCH §3.3 step 1; W3)
  idea_id      TEXT PRIMARY KEY REFERENCES idea(id),-- one descriptor per idea
  descriptor   TEXT NOT NULL,                       -- JSON {verb, object_class, constraint, transferable_structure}
  source_hash  TEXT NOT NULL,                       -- hash of the idea text the descriptor was extracted from
  extracted_at TEXT NOT NULL
);

CREATE TABLE decision (                             -- one row per RESOLVING action (FLOW §4.3)
  id             TEXT PRIMARY KEY,                  -- == the client-supplied decision_id (the idempotency key)
  spark_id       TEXT NOT NULL REFERENCES spark(id),
  kind           TEXT NOT NULL CHECK (kind IN ('ACCEPT','DISMISS','INSPIRED')),
  result_idea_id TEXT REFERENCES idea(id),          -- root from ACCEPT or committed seeded save; NULL for DISMISS
  decided_at     TEXT NOT NULL
);

CREATE TABLE spark_run (
  id             TEXT PRIMARY KEY,
  vault_revision INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','DONE','FAILED')),
  started_at     TEXT,
  finished_at    TEXT,
  error          TEXT
);

CREATE TABLE suppressed_pair (
  pair_key   TEXT PRIMARY KEY,
  reason     TEXT NOT NULL CHECK (reason IN ('CLICHE','NOISE','DISMISSED')),
  updated_at TEXT NOT NULL
);

CREATE TABLE vault_meta (                           -- single row; monotonic (§4)
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE config (                               -- thresholds (§3.4)
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- §2.4 Domain vocabulary (for distance)
CREATE TABLE domain_cluster (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  adjacency TEXT NOT NULL                           -- JSON {other_cluster_id: hops}
);

CREATE TABLE domain_map (                           -- free-text tag → cluster
  tag        TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL REFERENCES domain_cluster(id)
);
```

**Table count = 12** — `idea`, `idea_version`, `provenance_edge`, `spark`, `idea_mechanism`,
`decision`, `spark_run`, `suppressed_pair`, `vault_meta`, `config`, `domain_cluster`, `domain_map`.
Applied cleanly under SQLite; see §3.

**`idea_mechanism` semantics** (per David's ruling, 2026-10-13): one descriptor per idea, keyed by
`idea_id`; the descriptor stored as JSON; `source_hash` is a hash of the idea's text so extraction is
re-run **only when the text changes** (`ARCHITECTURE.md` §3.3 step 1; W3's "re-run only when an idea's
text changes"). Exact column shape is F3's; the cache is **internal** and never surfaced.

---

## 2. Invariants F3's tests assert

| Invariant (source) | How it holds |
| :--- | :--- |
| **Provenance-bearing ⇒ `lineage_parent_id IS NULL`** (ARCH §2.2, closes D1) | cross-table; asserted by test. Optionally a trigger — see §4. |
| **Single-parent lineage** (PRD §2) | structural: one nullable `lineage_parent_id` FK, plus the `FORK`-only `CHECK`. |
| **A repeated `decision_id` insert is a no-op** (FLOW §2.2/N4, H4) | PK on `decision.id`; write via `INSERT … ON CONFLICT(id) DO NOTHING` (then read the existing row). |
| **`vault_meta.revision` monotonicity** (ARCH §4) | every candidate-affecting vault mutation bumps it inside the same transaction; test asserts non-decreasing and single-row. |
| **At most one live offer per pair** (ARCH §3.5) | `ux_spark_live` partial unique index. |
| **One descriptor per idea** (ARCH §3.3) | PK on `idea_mechanism.idea_id`. |
| **`domain_tags` never empty** (PRD §2) | server validation (F4/API); JSON length ≥ 1 asserted on write and in tests. |

---

## 3. Verification (evidence)

Applied the fenced DDL as one script to a fresh **in-memory** SQLite 3.45.1 database (Python `sqlite3`;
no `sqlite3` CLI on this host) and probed the guards:

```
tables (12): config, decision, domain_cluster, domain_map, idea, idea_mechanism, idea_version,
             provenance_edge, spark, spark_run, suppressed_pair, vault_meta
index: ux_spark_live | CREATE UNIQUE INDEX ux_spark_live ON spark(pair_key) WHERE status = 'OFFERED'
foreign_keys pragma = 1

ux_spark_live:              2nd live OFFERED for pair 'a|b'  -> UNIQUE constraint failed: spark.pair_key
decision PK idempotency:    duplicate decision.id 'd1'       -> UNIQUE constraint failed: decision.id
lineage CHECK:              ROOT row carrying a parent       -> CHECK constraint failed
```

So the table count, the partial index, and the `FORK`-only-parent check all hold. This is a schema
probe, **not** a green CI run — the F3 invariant *tests* (`provenance ⇒ no lineage parent`,
`vault_meta.revision` monotonicity) land with the harness once F1 lands, shaped for F1's runner.

---

## 4. Optional strengthening: trigger for `provenance ⇒ no lineage parent`

The D1 invariant spans two tables, so a `CHECK` cannot express it. Two options: assert it in tests only
(this design's default), or add a `BEFORE INSERT` trigger on `provenance_edge` / `idea` that rejects an
idea carrying both a `lineage_parent_id` and provenance edges. Left as a test for the MVP — a trigger
adds write-path complexity for one invariant; revisit if the class recurs.

---

*Design — Ari (AstroLab agent), 2026-10-13, issue F3 (`#10`). Source: `ARCHITECTURE.md` §2. Review:
David (ruling, 2026-10-13); pending PR.*
