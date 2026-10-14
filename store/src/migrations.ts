import type { Migration } from "./migrate.js";

/**
 * The schema of record as forward-only migrations (`docs/SCHEMA.md`; `ARCHITECTURE.md` §2).
 *
 * `0001_init` is the twelve tables of §2 — the eleven enumerated there plus `idea_mechanism` — with
 * the partial unique index `ux_spark_live`. `PRAGMA foreign_keys` is deliberately absent from the
 * DDL: it is per-connection and a no-op inside a transaction, so `openStore` sets it, not the
 * migration (`docs/SCHEMA.md` §1).
 *
 * `0002_seed_vault_meta` seeds the `vault_meta` singleton. §4's stamp is relative
 * (`revision = revision + 1`), so an empty table makes the first candidate-affecting mutation a
 * silent no-op; seeding makes §2's *single-row* invariant true the moment `migrate()` returns. A new
 * migration rather than an edit to `0001_init`, which is already applied — rewriting it would break
 * forward-only and skip every store already at v1.
 */
export const SCHEMA_VERSION = 3;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "0001_init",
    sql: `
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
  CHECK (lineage_kind = 'FORK' OR lineage_parent_id IS NULL)   -- only a FORK may carry a parent
);

CREATE TABLE idea_version (                       -- iteration history, same node (PRD §3.2 item 1)
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
  pair_key             TEXT NOT NULL,              -- min(a,b)||'|'||max(a,b)
  direction            TEXT NOT NULL,              -- proposed idea (headline)
  claim                TEXT NOT NULL,
  what_it_takes        TEXT,
  first_step           TEXT,
  mechanism            TEXT,                       -- internal; never surfaced
  domain_distance      REAL,                       -- internal; never surfaced
  structural_alignment REAL,                       -- internal; never surfaced
  status               TEXT NOT NULL CHECK (
                         status IN ('OFFERED','RESOLVED-ACCEPTED','RESOLVED-DISMISSED','RESOLVED-INSPIRED')),
  created_at           TEXT NOT NULL
);

-- at most one live offer per pair (ARCH §3.5)
CREATE UNIQUE INDEX ux_spark_live ON spark(pair_key) WHERE status = 'OFFERED';

CREATE TABLE idea_mechanism (                      -- per-idea descriptor cache (ARCH §3.3 step 1; W3)
  idea_id      TEXT PRIMARY KEY REFERENCES idea(id), -- one descriptor per idea
  descriptor   TEXT NOT NULL,                      -- JSON {verb, object_class, constraint, transferable_structure}
  source_hash  TEXT NOT NULL,                      -- hash of the idea text the descriptor was extracted from
  extracted_at TEXT NOT NULL
);

CREATE TABLE decision (                            -- one row per RESOLVING action (FLOW §4.3)
  id             TEXT PRIMARY KEY,                 -- == the client-supplied decision_id (the idempotency key)
  spark_id       TEXT NOT NULL REFERENCES spark(id),
  kind           TEXT NOT NULL CHECK (kind IN ('ACCEPT','DISMISS','INSPIRED')),
  result_idea_id TEXT REFERENCES idea(id),         -- root from ACCEPT or a committed seeded save; NULL for DISMISS
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

CREATE TABLE vault_meta (                          -- single row; monotonic (ARCH §4)
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE config (                              -- thresholds (ARCH §3.4)
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- §2.4 Domain vocabulary (for distance)
CREATE TABLE domain_cluster (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  adjacency TEXT NOT NULL                          -- JSON {other_cluster_id: hops}
);

CREATE TABLE domain_map (                          -- free-text tag → cluster
  tag        TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL REFERENCES domain_cluster(id)
);
`,
  },
  {
    version: 2,
    name: "0002_seed_vault_meta",
    // The stamp is relative (ARCH §4), so an empty table makes the first mutation a silent no-op.
    // A separate migration, not an edit to 0001_init — that one is already applied.
    sql: "INSERT INTO vault_meta (id, revision) VALUES (1, 0);",
  },
  {
    version: 3,
    name: "0003_reference_actions",
    // V5 (#16): the eight `REFERENCES idea(id)` constraints, restated as the delete semantics T26
    // needs — **the row's owner cascades, historical refs dangle**. `0001_init` declared every one as
    // a bare reference, so with `foreign_keys = ON` (which `openStore` sets) deleting any idea that
    // was ever captured failed on its own `idea_version` row: the delete API could not exist without
    // this.
    //
    // SQLite cannot `ALTER` a constraint, so each change is a rebuild — create new → copy → drop old →
    // rename — and the whole thing runs under `PRAGMA foreign_keys = OFF`, which `migrate()` sets
    // *outside* the transaction (inside one it is a silent no-op) and checks with
    // `PRAGMA foreign_key_check` before the commit. `legacy_alter_table` is not needed; the flush
    // order below is the order that was probed to work.
    rebuildReferences: true,
    sql: `
-- §2.1 Idea — a fork child keeps its parent id, so the reference dangles by design (T26).
CREATE TABLE idea_new (
  id                TEXT PRIMARY KEY,
  hypothesis        TEXT NOT NULL,
  problem           TEXT NOT NULL,
  monetization      TEXT NOT NULL,
  domain_tags       TEXT NOT NULL,
  lineage_kind      TEXT NOT NULL CHECK (lineage_kind IN ('ROOT','ITERATION','FORK')),
  lineage_parent_id TEXT,
  status            TEXT NOT NULL CHECK (status IN ('ACTIVE','NEEDS_COMPLETION')),
  visibility        TEXT NOT NULL CHECK (visibility IN ('PRIVATE')),
  current_version   INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (lineage_kind = 'FORK' OR lineage_parent_id IS NULL)
);
INSERT INTO idea_new (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                      lineage_parent_id, status, visibility, current_version, created_at, updated_at)
  SELECT id, hypothesis, problem, monetization, domain_tags, lineage_kind,
         lineage_parent_id, status, visibility, current_version, created_at, updated_at
    FROM idea;
DROP TABLE idea;
ALTER TABLE idea_new RENAME TO idea;

-- §2.2 Provenance — the edge belongs to its derived idea (so it goes with it); the source ref
-- dangles, which is the tolerance T26 names.
CREATE TABLE provenance_edge_new (
  derived_idea_id TEXT NOT NULL REFERENCES idea(id) ON DELETE CASCADE,
  source_idea_id  TEXT NOT NULL,
  spark_id        TEXT NOT NULL,
  PRIMARY KEY (derived_idea_id, source_idea_id, spark_id)
);
INSERT INTO provenance_edge_new (derived_idea_id, source_idea_id, spark_id)
  SELECT derived_idea_id, source_idea_id, spark_id FROM provenance_edge;
DROP TABLE provenance_edge;
ALTER TABLE provenance_edge_new RENAME TO provenance_edge;

-- §2.1 History — the idea's own rows: meaningless without it.
CREATE TABLE idea_version_new (
  idea_id      TEXT NOT NULL REFERENCES idea(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  hypothesis   TEXT NOT NULL,
  problem      TEXT NOT NULL,
  monetization TEXT NOT NULL,
  domain_tags  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (idea_id, version)
);
INSERT INTO idea_version_new (idea_id, version, hypothesis, problem, monetization, domain_tags, created_at)
  SELECT idea_id, version, hypothesis, problem, monetization, domain_tags, created_at FROM idea_version;
DROP TABLE idea_version;
ALTER TABLE idea_version_new RENAME TO idea_version;

-- §2.3 Descriptor cache — the idea's own row too (so the API's delete path does not have to clear it).
CREATE TABLE idea_mechanism_new (
  idea_id      TEXT PRIMARY KEY REFERENCES idea(id) ON DELETE CASCADE,
  descriptor   TEXT NOT NULL,
  source_hash  TEXT NOT NULL,
  extracted_at TEXT NOT NULL
);
INSERT INTO idea_mechanism_new (idea_id, descriptor, source_hash, extracted_at)
  SELECT idea_id, descriptor, source_hash, extracted_at FROM idea_mechanism;
DROP TABLE idea_mechanism;
ALTER TABLE idea_mechanism_new RENAME TO idea_mechanism;

-- §2.3 Sparks — a spark's pair is history: the ids stay even when an idea is gone. (A *live* offer is
-- not history, which is why the delete path retracts it in application code, not here.)
CREATE TABLE spark_new (
  id                   TEXT PRIMARY KEY,
  idea_a_id            TEXT NOT NULL,
  idea_b_id            TEXT NOT NULL,
  pair_key             TEXT NOT NULL,
  direction            TEXT NOT NULL,
  claim                TEXT NOT NULL,
  what_it_takes        TEXT,
  first_step           TEXT,
  mechanism            TEXT,
  domain_distance      REAL,
  structural_alignment REAL,
  status               TEXT NOT NULL CHECK (
                         status IN ('OFFERED','RESOLVED-ACCEPTED','RESOLVED-DISMISSED','RESOLVED-INSPIRED')),
  created_at           TEXT NOT NULL
);
INSERT INTO spark_new (id, idea_a_id, idea_b_id, pair_key, direction, claim, what_it_takes,
                       first_step, mechanism, domain_distance, structural_alignment, status, created_at)
  SELECT id, idea_a_id, idea_b_id, pair_key, direction, claim, what_it_takes,
         first_step, mechanism, domain_distance, structural_alignment, status, created_at
    FROM spark;
DROP TABLE spark;
ALTER TABLE spark_new RENAME TO spark;
CREATE UNIQUE INDEX ux_spark_live ON spark(pair_key) WHERE status = 'OFFERED';

-- §2.3 Decisions — the resolution is permanent (FLOW §5.4): the decision keeps its ref, and NULL
-- already means DISMISS, so SET NULL was never available here.
CREATE TABLE decision_new (
  id             TEXT PRIMARY KEY,
  spark_id       TEXT NOT NULL REFERENCES spark(id),
  kind           TEXT NOT NULL CHECK (kind IN ('ACCEPT','DISMISS','INSPIRED')),
  result_idea_id TEXT,
  decided_at     TEXT NOT NULL
);
INSERT INTO decision_new (id, spark_id, kind, result_idea_id, decided_at)
  SELECT id, spark_id, kind, result_idea_id, decided_at FROM decision;
DROP TABLE decision;
ALTER TABLE decision_new RENAME TO decision;
`,
  },
];
