import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteConnection } from "../store/connection.js";
import { openNodeStore } from "../store/connection.node.js";
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  migrate,
  schemaVersion,
  seedDomainTaxonomy,
  vaultMutation,
} from "../store/index.js";
import { afterEach, expect, test } from "vitest";

import {
  exportVault,
  type ExportDocument,
  type LineageEdge,
  type ProvenanceEdge,
} from "./export.js";

/**
 * EV5 (#47) — **NFR-D1, the backup/restore + export round-trip** (`docs/PRD.md` §4 NFR-D1;
 * `docs/ARCHITECTURE.md` §8, §11 D1; `docs/RUNBOOK.md` §4).
 *
 * The Done clause is two passes asserting idea counts and lineage/provenance edges. Both are proved
 * against the **real** store and the **real** export, in one file: neither half needs a process
 * boundary, unlike EV4 `#46` (whose two halves had to split across `api`/`worker`). The route that
 * returned this object (`GET /v1/export`) retired with the HTTP layer, so this file reads the export
 * function directly, serializes it, and rebuilds from the bytes.
 *
 * | # | claim | read from | the fixture that fails it |
 * | :-- | :-- | :-- | :-- |
 * | 1 | backup→wipe→restore loses no committed idea | restored file: idea count, lineage + provenance edges | skip the checkpoint before the copy — rows in `-wal` never reach the copy (claim 2 is that fixture, run) |
 * | 2 | the checkpoint is load-bearing (WAL) | a naive copy vs the documented copy | **(the discriminator)** naive restores only the checkpointed base; the delta is gone by id |
 * | 3 | the restore path runs `migrate` forward, and **fails closed** on a file newer than the build | `schemaVersion(restored)` == `SCHEMA_VERSION`; `migrate` on a bumped `user_version` throws | the version pin is non-discriminating (the backup is already current); the discriminating half is the refusal — a `migrate` that guessed would open a future store |
 * | 4 | the document alone rebuilds the vault (open, portable) | a fresh store rebuilt from the JSON only, after the original file is deleted | empty `provenance_edges[]` cannot invent edges (non-vacuity, run) |
 *
 * **0 provider calls** — a file copy and a `BEGIN`…`COMMIT` read; no vault path can reach a provider.
 *
 * **Out of scope, recorded not dropped** (`docs/RUNBOOK.md` §"Not in this document"): `decisions[]`
 * does not round-trip the JSON path — it names a `spark_id` the eight keys do not carry (no `spark[]`
 * key), and `domain_cluster` names / `adjacency` are likewise unexported. NFR-D1's Done clause asserts
 * **idea counts and lineage/provenance edges**, not decisions; the file path (§1–§2) is complete.
 */

const TS = "2026-01-01T00:00:00Z";

const live: SqliteConnection[] = [];
const scratch: string[] = [];

afterEach(() => {
  for (const db of live.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed by a wipe — nothing to do
    }
  }
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh migrated vault on a **real file** — the backup path is a file-level property. */
function newVault(): { dir: string; path: string; db: SqliteConnection } {
  const dir = mkdtempSync(join(tmpdir(), "astrolab-nfr-d1-"));
  scratch.push(dir);
  const path = join(dir, "vault.sqlite");
  const db = openNodeStore(path);
  migrate(db, MIGRATIONS);
  seedDomainTaxonomy(db);
  live.push(db);
  return { dir, path, db };
}

/** Open a file the way boot does: `openStore` → `migrate` forward (`RUNBOOK.md` §2). */
function boot(path: string): SqliteConnection {
  const db = openNodeStore(path);
  migrate(db, MIGRATIONS);
  live.push(db);
  return db;
}

/** The documented backup: checkpoint `-wal` into the main file, then copy (`store/README.md`, RUNBOOK §1). */
function backup(db: SqliteConnection, path: string, dest: string): void {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  copyFileSync(path, dest);
}

/** Stop the writer, then remove the file **and** its sidecars — a stale `-wal` beside a replaced file is not the backup. */
function wipe(db: SqliteConnection, path: string): void {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}

interface VaultShape {
  ideas: number;
  lineage: LineageEdge[];
  provenance: ProvenanceEdge[];
}

/** The Done clause's quantities: idea count, lineage edges (derived from the idea row), provenance edges. */
function shapeOf(db: SqliteConnection): VaultShape {
  return {
    ideas: (db.prepare("SELECT COUNT(*) AS n FROM idea").get() as { n: number }).n,
    lineage: db
      .prepare(
        `SELECT id AS idea_id, lineage_parent_id AS parent_idea_id
           FROM idea WHERE lineage_parent_id IS NOT NULL ORDER BY id`,
      )
      .all() as unknown as LineageEdge[],
    provenance: db
      .prepare(
        `SELECT derived_idea_id, source_idea_id, spark_id FROM provenance_edge
         ORDER BY derived_idea_id, source_idea_id, spark_id`,
      )
      .all() as unknown as ProvenanceEdge[],
  };
}

function insertIdea(
  db: SqliteConnection,
  spec: { id: string; tags: string[]; parent?: string; delta?: string; newDomain?: 0 | 1 | null },
): void {
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at,
                       mutation_delta, new_domain)
     VALUES (?, ?, 'p', 'm', ?, ?, ?, 'ACTIVE', 'PRIVATE', 1, ?, ?, ?, ?)`,
  ).run(
    spec.id,
    `h-${spec.id}`,
    JSON.stringify(spec.tags),
    spec.parent === undefined ? "ROOT" : "FORK",
    spec.parent ?? null,
    TS,
    TS,
    // A ROOT's `mutation_delta` is NULL by the schema's CHECK — never both a parent and a delta.
    spec.delta ?? null,
    // The instrument (`0006`, EV1 `#43`) — omitted ⇒ `null` = "not recorded", which is the shape the
    // real writers leave behind for a pre-existing row.
    spec.newDomain ?? null,
  );
}

function insertVersion(db: SqliteConnection, id: string, tags: string[]): void {
  db.prepare(
    `INSERT INTO idea_version (idea_id, version, hypothesis, problem, monetization, domain_tags, created_at)
     VALUES (?, 1, ?, 'p', 'm', ?, ?)`,
  ).run(id, `h-${id}`, JSON.stringify(tags), TS);
}

function insertProvenance(
  db: SqliteConnection,
  derived: string,
  source: string,
  spark: string,
): void {
  db.prepare(
    "INSERT INTO provenance_edge (derived_idea_id, source_idea_id, spark_id) VALUES (?, ?, ?)",
  ).run(derived, source, spark);
}

/**
 * The fixture vault: two ROOTs, a FORK (`f1`, a row-only `mutation_delta`), a provenance-derived
 * ROOT (`d1`) with two sources, and a version per idea.
 */
function writeVault(db: SqliteConnection): void {
  vaultMutation(db, () => {
    insertIdea(db, { id: "r1", tags: ["fintech"] });
    insertIdea(db, { id: "r2", tags: ["health"], newDomain: 1 });
    insertIdea(db, { id: "f1", tags: ["fintech"], parent: "r1", delta: "widened into health" });
    insertIdea(db, { id: "d1", tags: ["fintech"] });
    insertVersion(db, "r1", ["fintech"]);
    insertVersion(db, "r2", ["health"]);
    insertVersion(db, "f1", ["fintech"]);
    insertVersion(db, "d1", ["fintech"]);
    insertProvenance(db, "d1", "r1", "sp1");
    insertProvenance(db, "d1", "r2", "sp1");
  });
}

const FIXTURE: { ideas: number; lineage: LineageEdge[]; provenance: ProvenanceEdge[] } = {
  ideas: 4,
  lineage: [{ idea_id: "f1", parent_idea_id: "r1" }],
  provenance: [
    { derived_idea_id: "d1", source_idea_id: "r1", spark_id: "sp1" },
    { derived_idea_id: "d1", source_idea_id: "r2", spark_id: "sp1" },
  ],
};

/**
 * Rebuild a vault **from the document alone** — the round-trip's importer. There is no product import
 * route (none is scoped): this stands in for "any tool that reads the open format", which is exactly
 * NFR-D1's portability claim. Foreign keys are ON, so parents (`idea`) land before children
 * (`idea_version`, `provenance_edge`). `decisions[]` is not replayed — it needs `spark` rows the eight
 * keys do not carry (`RUNBOOK.md` §"Not in this document").
 */
function reimport(doc: ExportDocument): SqliteConnection {
  const dir = mkdtempSync(join(tmpdir(), "astrolab-nfr-d1-reimport-"));
  scratch.push(dir);
  const db = openNodeStore(join(dir, "vault.sqlite"));
  migrate(db, MIGRATIONS);
  seedDomainTaxonomy(db);
  live.push(db);

  const idea = db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at,
                       mutation_delta, new_domain)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of doc.ideas) {
    idea.run(
      row.id,
      row.hypothesis,
      row.problem,
      row.monetization,
      JSON.stringify(row.domain_tags),
      row.lineage_kind,
      row.lineage_parent_id,
      row.status,
      row.visibility,
      row.current_version,
      row.created_at,
      row.updated_at,
      row.mutation_delta,
      // Carried, not defaulted: EV1 `#43`'s instrument is a stored fact (it is not recomputable from
      // the current vault), so an importer that dropped it would change what the report counts.
      row.new_domain,
    );
  }

  const version = db.prepare(
    `INSERT INTO idea_version (idea_id, version, hypothesis, problem, monetization, domain_tags, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of doc.idea_versions) {
    version.run(
      row.idea_id,
      row.version,
      row.hypothesis,
      row.problem,
      row.monetization,
      JSON.stringify(row.domain_tags),
      row.created_at,
    );
  }

  const provenance = db.prepare(
    "INSERT INTO provenance_edge (derived_idea_id, source_idea_id, spark_id) VALUES (?, ?, ?)",
  );
  for (const row of doc.provenance_edges) {
    provenance.run(row.derived_idea_id, row.source_idea_id, row.spark_id);
  }

  return db;
}

const ideaIds = (db: SqliteConnection): string[] =>
  (db.prepare("SELECT id FROM idea ORDER BY id").all() as unknown as Array<{ id: string }>).map(
    (row) => row.id,
  );

/**
 * EV1 `#43`'s instrument, per row — carried by the export/import path as well, because it is a
 * **stored** fact: it is not recomputable from the vault the importer rebuilds, so a document that
 * dropped it would silently change what NFR-Q1 reports. Read here, beside `shapeOf`, as the second
 * quantity a rebuild must preserve.
 */
const newDomainFlags = (db: SqliteConnection): Array<{ id: string; new_domain: number | null }> =>
  db.prepare("SELECT id, new_domain FROM idea ORDER BY id").all() as Array<{
    id: string;
    new_domain: number | null;
  }>;

test("backup → wipe → restore: every idea, lineage and provenance edge survives", () => {
  const { dir, path, db } = newVault();
  writeVault(db);
  const before = shapeOf(db);
  // The fixture is what it claims to be — a count-only fixture could not carry the edge claims.
  expect(before).toEqual(FIXTURE);

  const backupPath = join(dir, "astrolab-backup.sqlite");
  // The copy is taken with the connection **open** — the RUNBOOK's live-vault case.
  backup(db, path, backupPath);
  expect(statSync(backupPath).size).toBeGreaterThan(0);

  wipe(db, path);
  expect(existsSync(path)).toBe(false); // the vault is gone; only the backup remains

  copyFileSync(backupPath, path); // restore: put the file back…
  const restored = boot(path); // …and boot it (openStore → migrate forward, RUNBOOK §2)
  // The version pin is a preservation check, not a guard: the backup is already at the build's
  // version, so nothing here can fail on it. Claim 3's discriminating half is the refusal below.
  expect(schemaVersion(restored)).toBe(SCHEMA_VERSION);
  expect(shapeOf(restored)).toEqual(before);
});

test("the restore path fails closed on a file newer than the build — never migrates backward", () => {
  const { dir, path, db } = newVault();
  writeVault(db);
  const backupPath = join(dir, "future.sqlite");
  backup(db, path, backupPath);
  wipe(db, path);

  // A file written by a *newer* build: forward-only has nothing to apply, so "restoring" it by
  // guessing would silently drop newer state. `migrate` refuses instead (RUNBOOK §2).
  const future = openNodeStore(backupPath);
  live.push(future);
  future.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);

  expect(() => migrate(future, MIGRATIONS)).toThrow(/newer/i);
});

test("the checkpoint is load-bearing: a copy without it loses committed ideas (NFR-D1)", () => {
  const { dir, path, db } = newVault();

  // The vault as of its last checkpoint — one idea, folded into the main file.
  vaultMutation(db, () => insertIdea(db, { id: "base-1", tags: ["fintech"] }));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

  // A committed write after that checkpoint: it lives in `-wal` until the next checkpoint.
  vaultMutation(db, () => insertIdea(db, { id: "delta-1", tags: ["health"] }));
  expect(existsSync(`${path}-wal`)).toBe(true);
  expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
  expect(ideaIds(db)).toEqual(["base-1", "delta-1"]);

  // The mistake the procedure exists to prevent: copy the file, skip the checkpoint.
  const naivePath = join(dir, "naive.sqlite");
  copyFileSync(path, naivePath);
  // The documented backup: checkpoint, then copy.
  const goodPath = join(dir, "good.sqlite");
  backup(db, path, goodPath);

  // The committed delta is gone from the naive copy — a real, measured loss of a committed idea…
  expect(ideaIds(boot(naivePath))).toEqual(["base-1"]);
  // …and present in the documented one. This is the "seen failing" bar for claim 1's procedure.
  expect(ideaIds(boot(goodPath))).toEqual(["base-1", "delta-1"]);
});

test("export → wipe → re-import: the document alone rebuilds the vault", () => {
  const { path, db } = newVault();
  writeVault(db);
  const before = shapeOf(db);
  const flagsBefore = newDomainFlags(db);
  // Non-vacuity for the flags below: one row carries a recorded `1`, the rest are unrecorded — a
  // fixture of all-`null` would pass the equality even if the importer dropped the column.
  expect(flagsBefore.map((row) => row.new_domain)).toEqual([null, null, null, 1]);

  // The bytes a user gets from the export — the object the retired `GET /v1/export` returned verbatim.
  const json = JSON.stringify(exportVault(db));
  wipe(db, path); // the original vault is gone — nothing remains but the document

  const rebuilt = reimport(JSON.parse(json) as ExportDocument);
  expect(shapeOf(rebuilt)).toEqual(before);
  // EV1 `#43`: the instrument is part of the vault's state (`0006`), so "nothing the vault holds is
  // dropped" covers it too — and unlike an edge, it cannot be re-derived from the rebuilt vault.
  expect(newDomainFlags(rebuilt)).toEqual(flagsBefore);
});

test("the round-trip reads the document: an emptied provenance_edges[] cannot invent edges", () => {
  const { db } = newVault();
  writeVault(db);
  const doc = exportVault(db);

  // Cut one key; only the structure it carries should disappear. This is the non-vacuity fixture for
  // the equality above — it proves the reconstruction is driven by the document, not a hidden channel.
  const rebuilt = reimport({ ...doc, provenance_edges: [] });
  expect(shapeOf(rebuilt).provenance).toEqual([]);
  expect(shapeOf(rebuilt).ideas).toBe(doc.ideas.length); // ideas still round-trip
  expect(shapeOf(rebuilt).lineage).toEqual(FIXTURE.lineage);
});
