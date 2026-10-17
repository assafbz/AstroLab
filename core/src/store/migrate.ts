import type { SqliteConnection } from "./connection.js";

import { writeTransaction } from "./store.js";

/**
 * Forward-only versioned migrations (ARCHITECTURE.md §9; ADR-0001). There is no `down`: the
 * applied version lives in SQLite's own `PRAGMA user_version`, and a migration is applied once,
 * in ascending version order, each inside one transaction.
 */
export interface Migration {
  /** 1-based, applied in ascending order. */
  version: number;
  name: string;
  sql: string;
  /**
   * Set for a migration that **rebuilds a table to change a foreign-key action**. SQLite cannot
   * `ALTER` a constraint, so the change is create-new → copy → drop-old → rename, and it needs
   * `PRAGMA foreign_keys = OFF` — which is only settable **outside** a transaction, because inside
   * one it is a silent no-op (see `requireForeignKeysDisabled`).
   *
   * Flagged rather than inferred: only a rebuild needs the pragma dance, and a migration that does
   * not get it (and asserts nothing) is cheaper and less surprising.
   */
  rebuildReferences?: boolean;
}

/** Applies every pending migration and returns the resulting schema version. */
export function migrate(db: SqliteConnection, migrations: Migration[]): number {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  for (const m of ordered) {
    if (!Number.isInteger(m.version) || m.version < 1) {
      throw new RangeError(`migration version must be a positive integer: ${m.version}`);
    }
  }
  for (let i = 1; i < ordered.length; i++) {
    // A duplicate makes `user_version` ambiguous — one of the two would never be applied.
    if (ordered[i]!.version === ordered[i - 1]!.version) {
      throw new Error(`duplicate migration version: ${ordered[i]!.version}`);
    }
  }

  const newest = ordered.at(-1)?.version ?? 0;
  let applied = schemaVersion(db);
  if (applied > newest) {
    throw new Error(
      `store is at schema v${applied} but this build knows only v${newest}: forward-only, refusing to run against a newer database`,
    );
  }

  const foreignKeysBefore = foreignKeys(db);
  for (const m of ordered) {
    if (m.version <= applied) continue;
    const rebuild = m.rebuildReferences === true;
    if (rebuild) {
      // Outside the transaction, which is the only place this takes effect.
      db.exec("PRAGMA foreign_keys = OFF");
      requireForeignKeysDisabled(db, m);
    }
    try {
      writeTransaction(db, () => {
        // Re-read inside the transaction: a second process migrating the same file at boot may have
        // applied this while we waited for the write lock, and `BEGIN IMMEDIATE` serializes writers —
        // so this re-read is race-free, where the one above the loop is only a fast path.
        if (schemaVersion(db) >= m.version) return;
        db.exec(m.sql);
        if (rebuild) requireNoForeignKeyViolations(db, m);
        db.exec(`PRAGMA user_version = ${m.version}`);
      });
    } finally {
      // Restored even when the migration threw. A connection left with enforcement off is the kind of
      // state that corrupts a store quietly, with nothing pointing back here.
      if (rebuild && foreignKeysBefore !== 0) db.exec("PRAGMA foreign_keys = ON");
    }
    applied = m.version;
  }
  return schemaVersion(db);
}

/** `PRAGMA foreign_keys` on this connection: 1 = enforced. */
function foreignKeys(db: SqliteConnection): number {
  const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined;
  return row?.foreign_keys ?? 0;
}

/**
 * SQLite accepts `PRAGMA foreign_keys = OFF` **inside a transaction and ignores it, without an
 * error** — the pragma reads back unchanged. A rebuild migration would then fail later with a bare
 * `FOREIGN KEY constraint failed`, which points at the SQL rather than at the real cause. So read it
 * back and say what actually happened.
 */
function requireForeignKeysDisabled(db: SqliteConnection, m: Migration): void {
  if (foreignKeys(db) !== 0) {
    throw new Error(
      `migration ${m.name} rebuilds a foreign key and needs PRAGMA foreign_keys = OFF, but the pragma did not take effect: it is a silent no-op inside a transaction, and migrate() was called with one already open`,
    );
  }
}

/**
 * The rebuild's own proof. `PRAGMA foreign_key_check` is a **query** — a violation comes back as a
 * row — so a migration string containing it cannot fail anything; the check has to run here, *inside*
 * the transaction, where a violation rolls the whole migration back. Re-enabling `foreign_keys` does
 * not re-validate rows that are already written.
 */
function requireNoForeignKeyViolations(db: SqliteConnection, m: Migration): void {
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new Error(
      `migration ${m.name} left ${violations.length} foreign-key violation(s): ${JSON.stringify(violations.slice(0, 5))}`,
    );
  }
}

export function schemaVersion(db: SqliteConnection): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}
