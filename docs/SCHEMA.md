# Schema: Astrolab store (SQLite) — issue F3 design

> **2026-10-17 — retargeted by the local-only rebuild.** The **twelve tables and every migration are unchanged**;
> the file moves into the app sandbox and is opened through the `SqliteConnection` port (`docs/ARCHITECTURE.md` v2
> §2; `docs/adr/0006-local-only-expo-app.md`). **F2's connection posture is amended:** there is now **one
> in-process writer**, so the WAL + `busy_timeout` + retry-for-`SQLITE_BUSY` machinery (below, and in v1's F2) is no
> longer load-bearing. Paths in this file (`store/src/migrations.ts`, `@astrolab/store`) become
> `core/src/store/migrations.ts`, `@astrolab/core`.

> **Status:** The schema of record, in DDL form — and **shipped**: `0001_init` (the twelve tables),
> `0002_seed_vault_meta`, `0003_reference_actions`, `0004_retire_iteration_lineage_kind` and
> `0005_idea_mutation_delta` and `0006_idea_new_domain` live in `store/src/migrations.ts`, and this
> file tracks them.
> **Source of record:** `docs/ARCHITECTURE.md` §2 (data model — the complete table set incl.
> `idea_mechanism`) and ADR-0001 / ADR-0002. Where this file and §2 differ, **§2 wins** and this file
> is the defect — file it.
> **Scope:** the tables, keys, and the partial unique index. Connection/WAL/retry belong to **F2**;
> the invariant *tests* belong to **F3**.

The DDL below applies as one forward-only migration (`0001_init`) — restated here **as amended** by
`0003_reference_actions` (§1b), which changes only the eight `REFERENCES idea(id)` of V5 `#16`; by
`0004_retire_iteration_lineage_kind`, which narrows only `idea.lineage_kind` to `ROOT | FORK`
(V3 `#14`); by `0005_idea_mutation_delta` (§1d), which adds only `idea.mutation_delta` (V4 `#15`); and by
`0006_idea_new_domain` (§1e), which adds only `idea.new_domain` (EV1 `#43`).
`0003`/`0004` are rebuilds — SQLite cannot `ALTER` a `CHECK` or a foreign-key action; `0005`/`0006` are
plain `ADD COLUMN`s, because they add a *new* column and change no existing constraint.
`PRAGMA journal_mode=WAL` and
`PRAGMA foreign_keys=ON` are set by the store's connection setup (F2), not by the migration — the
foreign-keys pragma is per-connection and a no-op inside the migration's `BEGIN IMMEDIATE`.

---

## 1. The tables of §2 — DDL (`0001_init`, as amended by `0003`, `0004`, `0005` and `0006`)

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
  mutation_delta    TEXT CHECK (lineage_kind = 'FORK' OR mutation_delta IS NULL),
                                                   -- `0005` (V4 #15): the fork's mutation delta
                                                   -- (PRD §3.2 item 2); set ONLY for a FORK, nullable.
                                                   -- Column-level CHECK, so it lands as a plain ADD COLUMN
  status            TEXT NOT NULL CHECK (status IN ('ACTIVE','NEEDS_COMPLETION')),
  visibility        TEXT NOT NULL CHECK (visibility IN ('PRIVATE')),
  current_version   INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  new_domain        INTEGER CHECK (new_domain IN (0,1)),
                                                   -- `0006` (EV1 #43): did this idea's domain set
                                                   -- reach a domain the vault did not already carry?
                                                   -- 1 | 0 | NULL = not recorded (§4.13's ACCEPT, and
                                                   -- every row predating the column). Plain ADD COLUMN,
                                                   -- so it lands last in `PRAGMA table_info`
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

### 1d. `0005_idea_mutation_delta` — `idea.mutation_delta`, nullable and FORK-only (V4 `#15`, 2026-10-14)

A fork records an explicit **mutation delta** (`PRD.md` §3.2 item 2), and no `idea` or `idea_version` column
carried one — `git grep mutation_delta` found only the contract (`docs/API.md` §4.7, `ARCHITECTURE.md` §6),
not the schema. `0005` adds the column, so §1's `idea` DDL gains

```sql
mutation_delta TEXT CHECK (lineage_kind = 'FORK' OR mutation_delta IS NULL)
```

A **plain `ALTER TABLE … ADD COLUMN`**, not a rebuild: unlike `0003`/`0004` it adds a *new* column and changes
no existing constraint, so SQLite applies it in place (probed on `node:sqlite` v26, `foreign_keys = ON`, a
table that already has rows — the column-level `CHECK` is enforced on both INSERT and UPDATE). The `CHECK` is
the same structural pattern as `lineage_parent_id`: **a delta exists only on a FORK** is a schema fact, not
call-site discipline. The column stays **nullable** — a `FORK` without a delta, and every `ROOT`, are both
legal — and the fork path stores the delta with the row (`docs/API.md` §4.7).

---

### 1e. `0006_idea_new_domain` — `idea.new_domain`, nullable `0 | 1` (EV1 `#43`, 2026-10-16)

NFR-Q1 (`PRD.md` §5, the requirement table's *"accepted sparks, and how many landed in a new domain"*)
needs that question recorded as an instrument, and no `idea` or `idea_version` column carried it. `0006`
adds the column, so §1's `idea` DDL gains

```sql
new_domain INTEGER CHECK (new_domain IN (0,1))
```

The column lives on **`idea`, not `decision`** — the rejected alternative, recorded rather than dropped.
A `decision` row is immutable and one per ACCEPT, so a flag stored there would be a fact about the
*accept*; but the accepted root's domain can change **after** it (§4.6's iterate, T27's completion), and
the property is about the *idea* — so a `decision`-stored flag would go stale on exactly the
follow-through the metric reads. A `decision.new_domain` would also be a column nothing writes.

**Three states, and the third is load-bearing.** `1` = the write reached a domain the vault did not
already carry; `0` = it did not; `NULL` = **not recorded** — §4.13's ACCEPT, whose root's tags are the
source pair's union drawn from pre-existing rows (the reading there is constant-false, `docs/API.md`
§4.13), and every row that predates the column. The three writes that *can* widen record it (§4.2
capture, §4.7 fork, §4.6 iterate) through `newDomainFlag` (`store/src/domain-map.ts`), whose identity for
a domain is the vault's own — the cluster, with an unmapped tag as its own cluster; the reporting reads
are `api/src/metrics.ts` (`acceptedByMonth`, `newDomainByMonth`, `acceptedLandingNewDomainByMonth`,
documented in the module), which is NFR-Q1's *"instrumentation + reporting"* and is deliberately **not**
a route.

**A recorded `1` is durable.** The metric reads an event — *"a spark that **landed** in a new domain"* —
so `1` is a fact about the idea's *history*, not the latest write's answer. §4.6 is the one writer whose
row already exists, and it writes the value monotonically (`CASE WHEN new_domain = 1 THEN 1 ELSE ? END`,
`api/src/iterate.ts`): once earned — at birth, or by a T27 completion onto a fresh domain — it survives
every later write of the row's own domain, a plain text edit included. Without that, a widening would be
cleared by the next unrelated edit (the recomputation compares against a vault that now includes the row
itself), and both month views would drift down with use. `newDomainFlag` returns only *this* write's
answer; preserving the prior `1` is the writer's job, and only §4.6 has a prior value to preserve.

A **plain `ALTER TABLE … ADD COLUMN`**, not a rebuild (`0005`'s precedent): it adds a *new* column and
changes no existing constraint. Nullable, so every pre-existing row lands `NULL` with no backfill — and
the report counts `= 1`, never `!= 1`, so "did not widen" and "not recorded" cannot be confused.

---

## 2. Invariants F3's tests assert

| Invariant (source) | How it holds |
| :--- | :--- |
| **Provenance-bearing ⇒ `lineage_parent_id IS NULL`** (ARCH §2.2, closes D1) | cross-table; asserted by test. Optionally a trigger — see §4. |
| **Single-parent lineage** (PRD §2) | structural: one nullable `lineage_parent_id` column (no longer a FK — `0003`), plus the `FORK`-only `CHECK`. |
| **A mutation delta exists only on a FORK** (PRD §3.2 item 2; V4 `#15`) | structural: `mutation_delta` is nullable and carries `CHECK (lineage_kind='FORK' OR mutation_delta IS NULL)` (`0005`, §1d). |
| **`new_domain` is `0`, `1`, or unrecorded** (EV1 `#43`; NFR-Q1) | structural: nullable `INTEGER` carrying `CHECK (new_domain IN (0,1))` (`0006`, §1e) — a `NULL` passes as the *absence* of a record, never as a value. |
| **A recorded `new_domain = 1` is durable** (EV1 `#43`; NFR-Q1) | §4.6's iterate assigns `CASE WHEN new_domain = 1 THEN 1 ELSE ? END` (`api/src/iterate.ts`), so no later write clears a recorded widening — asserted by test (`api/src/nfr-q1.test.ts`, claim 3). |
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
