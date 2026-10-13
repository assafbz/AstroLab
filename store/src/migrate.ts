import type { DatabaseSync } from "node:sqlite";

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
}

/** Applies every pending migration and returns the resulting schema version. */
export function migrate(db: DatabaseSync, migrations: Migration[]): number {
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

  const current = schemaVersion(db);
  const newest = ordered.at(-1)?.version ?? 0;
  if (current > newest) {
    throw new Error(
      `store is at schema v${current} but this build knows only v${newest}: forward-only, refusing to run against a newer database`,
    );
  }

  for (const m of ordered) {
    if (m.version <= current) continue;
    // SQLite's DDL is transactional, so a failure leaves the file exactly at the previous version.
    writeTransaction(db, () => {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    });
  }
  return schemaVersion(db);
}

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}
