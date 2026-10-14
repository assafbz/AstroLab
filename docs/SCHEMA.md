# Schema: Astrolab store (SQLite) — issue F3 design

> **Status:** The schema of record, in DDL form — and **shipped**: `0001_init` (the twelve tables),
> `0002_seed_vault_meta`, `0003_reference_actions` and `0004_retire_iteration_lineage_kind` live in
> `store/src/migrations.ts`, and this file tracks them.
> **Source of record:** `docs/ARCHITECTURE.md` §2 (data model — the complete table set incl.
> `idea_mechanism`) and ADR-0001 / ADR-0002. Where this file and §2 differ, **§2 wins** and this file
> is the defect — file it.
> **Scope:** the tables, keys, and the partial unique index. Connection/WAL/retry belong to **F2**;
> the invariant *tests* belong to **F3**.

The DDL below applies as one forward-only migration (`0001_init`) — restated here **as amended** by
`0003_reference_actions` (§1b), which changes only the eight `REFERENCES idea(id)` of V5 `#16`, and by
`0004_retire_iteration_lineage_kind`, which narrows only `idea.lineage_kind` to `ROOT | FORK`
(V3 `#14`). Both are rebuilds; SQLite cannot `ALTER` a `CHECK` or a foreign-key action.
`PRAGMA journal_mode=WAL` and
`PRAGMA foreign_keys=ON` are set by the store's connection setup (F2), not by the migration — the
foreign-keys pragma is per-connection and a no-op inside the migration's `BEGIN IMMEDIATE`.

---

## 1. The tables of §2 — DDL (`0001_init`, as amended by `0003` and `0004`)

**Twelve** tables: the eleven enumerated in §2.1–§2.4, plus **`idea_mechanism`** (the per-idea
descriptor cache — `ARCHITECTURE.md` §2.3, §3.3 step 1; ADR-0002; W3 `#28`), added to the schema of
record 2026-10-13 per David's ruling (reading B — an omission, not a later stage).

```sql
-- (no `PRAGMA foreign_keys`: per-connection, so the store's setup (F2) sets it, not this migration)

-- §2.1 Idea and its history
CREATE TABLE idea (
  id                TEXT PRIMARY KEY,
  hypothesis        TEXT NOT NULL,
  problem           TEXT NOT NULL,
  monetization      TEXT NOT NULL,
  domain_tags       TEXT NOT NULL,                -- JSON array; length >= 1 (PRD §2)
  lineage_kind      TEXT NOT NULL CHECK (lineage_kind IN ('ROOT','FORK')),
  lineage_parent_id TEXT,                          -- set ONLY for FORK; single parent. NOT a FK since
                                                   -- `0003` (V5 #16): the ref dangles by design (T26)
  status            TEXT NOT NULL CHECK (status IN ('ACTIVE','NEEDS_COMPLETION')),
  visibility        TEXT NOT NULL CHECK (visibility IN ('PRIVATE')),
  current_version   INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  -- structural guard: only a FORK may carry a parent
  CHECK (lineage_kind = 'FORK' OR lineage_parent_id IS NULL)
);

CREATE TABLE idea_version (                        -- iteration history, same node (PRD §3.2 item 1)
  idea_id      TEXT NOT NULL REFERENCES idea(id) ON DELETE CASCADE,
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
  derived_idea_id TEXT NOT NULL REFERENCES idea(id) ON DELETE CASCADE,
                                                   -- the accepted / inspired idea (a ROOT); the edge
                                                   -- belongs to it, so it goes when the idea does
  source_idea_id  TEXT NOT NULL,                    -- one of the two source ideas; NOT a FK since
                                                   -- `0003` — deleting a source leaves this ref (T26)
  spark_id        TEXT NOT NULL,
  PRIMARY KEY (derived_idea_id, source_idea_id, spark_id)
);

-- §2.3 Sparks, runs, decisions, suppression, mechanism cache
CREATE TABLE spark (
  id                   TEXT PRIMARY KEY,
  idea_a_id            TEXT NOT NULL,               -- ordered ids; NOT FKs since `0003` — a spark's
  idea_b_id            TEXT NOT NULL,               -- pair is history and outlives a deleted idea
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
  idea_id      TEXT PRIMARY KEY REFERENCES idea(id) ON DELETE CASCADE, -- one descriptor per idea
  descriptor   TEXT NOT NULL,                       -- JSON {verb, object_class, constraint, transferable_structure}
  source_hash  TEXT NOT NULL,                       -- hash of the idea text the descriptor was extracted from
  extracted_at TEXT NOT NULL
);

CREATE TABLE decision (                             -- one row per RESOLVING action (FLOW §4.3)
  id             TEXT PRIMARY KEY,                  -- == the client-supplied decision_id (the idempotency key)
  spark_id       TEXT NOT NULL REFERENCES spark(id),
  kind           TEXT NOT NULL CHECK (kind IN ('ACCEPT','DISMISS','INSPIRED')),
  result_idea_id TEXT,                              -- root from ACCEPT or committed seeded save; NULL for
                                                    -- DISMISS. NOT a FK since `0003` — the resolution
                                                    -- is permanent (FLOW §5.4)
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

**`0002_seed_vault_meta` — the singleton's first row** (issue #62, 2026-10-13). `0001_init` creates
`vault_meta` empty, and §4's stamp is relative — `UPDATE vault_meta SET revision = revision + 1` — so the
**first** candidate-affecting mutation would be a silent no-op: it matches zero rows and reports success.
A second forward-only migration seeds the row, so §2's *single-row* invariant holds the moment
`migrate()` returns and the bump stays a plain relative `UPDATE` inside the mutation's transaction:

```sql
INSERT INTO vault_meta (id, revision) VALUES (1, 0);
```

A new migration rather than an edit to `0001_init`, which is already applied — rewriting it would break
forward-only and skip every store already at v1.

### 1b. `0003_reference_actions` — the eight `REFERENCES idea(id)` (V5 `#16`, 2026-10-14)

`0001_init` declared all eight references bare, and a bare reference is **immediate** with
`foreign_keys = ON` (which `openStore` sets) — so deleting *any* idea that had ever been captured failed on
its own `idea_version` row. `0003` restates them as the delete semantics T26 needs — **the row's owner
cascades, historical refs dangle** — so §1's DDL for those six tables reads as follows:

| table | column | now |
| :--- | :--- | :--- |
| `idea_version` | `idea_id` | `REFERENCES idea(id) ON DELETE CASCADE` |
| `idea_mechanism` | `idea_id` | `REFERENCES idea(id) ON DELETE CASCADE` |
| `provenance_edge` | `derived_idea_id` | `REFERENCES idea(id) ON DELETE CASCADE` |
| `provenance_edge` | `source_idea_id` | **no reference** — the source ref dangles (T26) |
| `idea` | `lineage_parent_id` | **no reference** — a fork child keeps its parent id (T26) |
| `spark` | `idea_a_id`, `idea_b_id` | **no references** — a resolved spark's pair is history |
| `decision` | `result_idea_id` | **no reference** — the resolution is permanent (`FLOW.md` §5.4) |
| `decision` | `spark_id` | unchanged: `REFERENCES spark(id)` |

SQLite cannot `ALTER` a constraint, so each change is a **table rebuild** (create new → copy → drop old →
rename), and `ux_spark_live` is recreated with `spark`. The rebuild runs under `PRAGMA foreign_keys = OFF`,
set **outside** the migration's transaction by `migrate()` (the `rebuildReferences` flag on a `Migration`):
inside a transaction that pragma is a **silent no-op**, so `migrate()` reads it back and throws if it did not
take, checks `PRAGMA foreign_key_check` **inside** the transaction (a violation rolls the migration back —
and the check must be code, because the pragma is a *query*, so a migration string containing it cannot fail
anything), and restores the pragma in a `finally`. `legacy_alter_table` is not needed;
`defer_foreign_keys` does **not** work (it defers the violation to `COMMIT`, which then fails).

The one case that is neither cascade nor dangle lives in application code, not in the schema: a **live
`OFFERED` spark** named by a deleted idea is retracted by the delete path (`docs/API.md` §4.8), because a
live offer is a promise made from the vault's current state and the state has changed.

### 1c. `0004_retire_iteration_lineage_kind` — `lineage_kind` ∈ `ROOT | FORK` (V3 `#14`, 2026-10-14)

`ITERATION` was never reachable: iteration writes a new `idea_version` row on the **same** node and creates
no lineage edge (`FLOW.md` §2.3 L1; `PRD.md` §3.2 item 1), and the FORK-only `CHECK` already forbade the
only parent-bearing form an `ITERATION` row could have had. Its only occurrences were negative test cases.
`0004` narrows the vocabulary, so §1's `idea` DDL reads
`lineage_kind TEXT NOT NULL CHECK (lineage_kind IN ('ROOT','FORK'))`.

SQLite cannot `ALTER` a `CHECK`, so this is the `0003`-style **table rebuild** — and it is a **new**
migration, not an edit to `0001`/`0003`: those keep `ITERATION` in their DDL as **immutable history**, and
an in-place edit would leave every store already at v3 holding the permissive `CHECK` under the same
`user_version` (the silent skip forward-only forbids). On the contract side, `docs/API.md` §3.1/§4.4 drop the
value from the enum and the `lineage` filter, so `?lineage=ITERATION` is the `422` envelope (§1), and the
client's `LINEAGES` drops it too.

---

## 2. Invariants F3's tests assert

| Invariant (source) | How it holds |
| :--- | :--- |
| **Provenance-bearing ⇒ `lineage_parent_id IS NULL`** (ARCH §2.2, closes D1) | cross-table; asserted by test. Optionally a trigger — see §4. |
| **Single-parent lineage** (PRD §2) | structural: one nullable `lineage_parent_id` column (no longer a FK — `0003`), plus the `FORK`-only `CHECK`. |
| **A repeated `decision_id` insert is a no-op** (FLOW §2.2/N4, H4) | PK on `decision.id`; write via `INSERT … ON CONFLICT(id) DO NOTHING` (then read the existing row). |
| **`vault_meta.revision` monotonicity** (ARCH §4) | every candidate-affecting vault mutation bumps it inside the same transaction; test asserts non-decreasing and single-row. |
| **At most one live offer per pair** (ARCH §3.5) | `ux_spark_live` partial unique index. |
| **One descriptor per idea** (ARCH §3.3) | PK on `idea_mechanism.idea_id`. |
| **`domain_tags` never empty** (PRD §2) | server validation (F4/API); JSON length ≥ 1 asserted on write and in tests. |

---

## 3. Verification (evidence)

Applied the fenced DDL as one script to a fresh **in-memory** SQLite 3.45.1 database (Python `sqlite3`;
no `sqlite3` CLI on this host), with `PRAGMA foreign_keys=ON` set on the connection first — as F2's
`openStore` does, not the migration (§1) — and probed the guards:

```
tables (12): config, decision, domain_cluster, domain_map, idea, idea_mechanism, idea_version,
             provenance_edge, spark, spark_run, suppressed_pair, vault_meta
index: ux_spark_live | CREATE UNIQUE INDEX ux_spark_live ON spark(pair_key) WHERE status = 'OFFERED'
foreign_keys pragma = 1

ux_spark_live:              2nd live OFFERED for pair 'a|b'  -> UNIQUE constraint failed: spark.pair_key
decision PK idempotency:    duplicate decision.id 'd1'       -> UNIQUE constraint failed: decision.id
lineage CHECK:              ROOT row carrying a parent       -> CHECK constraint failed
vault_meta after 0001_init: 0 rows                          -> the first relative bump is a no-op
vault_meta after 0002 seed: {id: 1, revision: 0}             -> the first bump yields 1
```

So the table count, the partial index, and the `FORK`-only-parent check all hold. This is a schema
probe, **not** a green CI run — the F3 invariant *tests* (`provenance ⇒ no lineage parent`,
`vault_meta.revision` monotonicity) have since landed with the harness (`store/test/`, F3 #61), and the
singleton-seed assertion with #62.

---

## 4. Optional strengthening: trigger for `provenance ⇒ no lineage parent`

The D1 invariant spans two tables, so a `CHECK` cannot express it. Two options: assert it in tests only
(this design's default), or add a `BEFORE INSERT` trigger on `provenance_edge` / `idea` that rejects an
idea carrying both a `lineage_parent_id` and provenance edges. Left as a test for the MVP — a trigger
adds write-path complexity for one invariant; revisit if the class recurs.

---

*Design — Ari (AstroLab agent), 2026-10-13, issue F3 (`#10`). Source: `ARCHITECTURE.md` §2. Review:
David (ruling, 2026-10-13); merged as PR #61; `0002_seed_vault_meta` added under #62.*
