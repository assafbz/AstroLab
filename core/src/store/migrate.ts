import type { AsyncSqliteConnection, SqlRow, SqliteConnection } from "./connection.js";

import { writeTransaction, writeTransactionAsync } from "./store.js";

/**
 * Forward-only versioned migrations (ARCHITECTURE.md §9; ADR-0001). There is no `down`: the
 * applied version lives in SQLite's own `PRAGMA user_version`, and a migration is applied once,
 * in ascending version order, each inside one transaction.
 *
 * ## Two channels, one set of rules (#186)
 *
 * The rules below — ascending order, a positive-integer version, no duplicate version, forward-only
 * refusal, the in-transaction re-read, `BEGIN IMMEDIATE`, the `foreign_keys`-off rebuild dance and its
 * restore — are each written **once** and run on both channels. What differs is only *when* the
 * statements execute: {@link migrate} runs them synchronously (the steady state, and every suite), and
 * {@link migrateAsync} awaits them on `AsyncSqliteConnection` (the web boot, #186).
 *
 * A note on why this is two drivers and not one shared body, because it is the honest cost of the
 * change: the port is synchronous **by design** (invariant 1), and a body that both returns `number`
 * synchronously *and* can await cannot exist in TypeScript — an `async` function always returns a
 * `Promise`. So the rule *decisions* are extracted into helpers both channels call
 * ({@link orderedMigrations} · {@link assertForwardOnly} · {@link assertForeignKeysDisabled} ·
 * {@link assertNoForeignKeyViolations}), the SQL comes from one place (`./migrations.js`), and the two
 * loops are pinned to each other by `migrate-parity.test.ts`, which drives both channels over the same
 * fixtures and asserts an identical resulting database. The alternative — making the *port* async —
 * retires invariant 1 and was explicitly out of scope (`docs/adr/0007-web-boot-async-channel.md`).
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

/**
 * The ordering rules, shared by both channels: ascending version, a positive integer version, and no
 * duplicate (`user_version` would be ambiguous — one of the two would never be applied).
 */
function orderedMigrations(migrations: Migration[]): Migration[] {
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
  return ordered;
}

/** The forward-only refusal, shared by both channels: a store newer than this build must not run. */
function assertForwardOnly(applied: number, newest: number): void {
  if (applied > newest) {
    throw new Error(
      `store is at schema v${applied} but this build knows only v${newest}: forward-only, refusing to run against a newer database`,
    );
  }
}

/** Applies every pending migration and returns the resulting schema version. */
export function migrate(db: SqliteConnection, migrations: Migration[]): number {
  const ordered = orderedMigrations(migrations);
  const newest = ordered.at(-1)?.version ?? 0;
  let applied = schemaVersion(db);
  assertForwardOnly(applied, newest);

  const foreignKeysBefore = foreignKeys(db);
  for (const m of ordered) {
    if (m.version <= applied) continue;
    const rebuild = m.rebuildReferences === true;
    if (rebuild) {
      // Outside the transaction, which is the only place this takes effect.
      db.exec("PRAGMA foreign_keys = OFF");
      assertForeignKeysDisabled(foreignKeys(db), m);
    }
    try {
      writeTransaction(db, () => {
        // Re-read inside the transaction: a second process migrating the same file at boot may have
        // applied this while we waited for the write lock, and `BEGIN IMMEDIATE` serializes writers —
        // so this re-read is race-free, where the one above the loop is only a fast path.
        if (schemaVersion(db) >= m.version) return;
        db.exec(m.sql);
        if (rebuild) assertNoForeignKeyViolations(db.prepare("PRAGMA foreign_key_check").all(), m);
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

/** {@link migrate} on the async channel — the same rules, awaited (#186). */
export async function migrateAsync(
  db: AsyncSqliteConnection,
  migrations: Migration[],
): Promise<number> {
  const ordered = orderedMigrations(migrations);
  const newest = ordered.at(-1)?.version ?? 0;
  let applied = await schemaVersionAsync(db);
  assertForwardOnly(applied, newest);

  const foreignKeysBefore = await foreignKeysAsync(db);
  for (const m of ordered) {
    if (m.version <= applied) continue;
    const rebuild = m.rebuildReferences === true;
    if (rebuild) {
      // Outside the transaction, which is the only place this takes effect.
      await db.exec("PRAGMA foreign_keys = OFF");
      assertForeignKeysDisabled(await foreignKeysAsync(db), m);
    }
    try {
      await writeTransactionAsync(db, async () => {
        // The same in-transaction re-read as the sync path, for the same reason.
        if ((await schemaVersionAsync(db)) >= m.version) return;
        await db.exec(m.sql);
        if (rebuild) assertNoForeignKeyViolations(await db.all("PRAGMA foreign_key_check"), m);
        await db.exec(`PRAGMA user_version = ${m.version}`);
      });
    } finally {
      if (rebuild && foreignKeysBefore !== 0) await db.exec("PRAGMA foreign_keys = ON");
    }
    applied = m.version;
  }
  return schemaVersionAsync(db);
}

/** `PRAGMA foreign_keys` on this connection: 1 = enforced. */
function foreignKeys(db: SqliteConnection): number {
  const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined;
  return row?.foreign_keys ?? 0;
}

/** {@link foreignKeys} on the async channel. */
async function foreignKeysAsync(db: AsyncSqliteConnection): Promise<number> {
  const row = (await db.get("PRAGMA foreign_keys")) as { foreign_keys?: number } | undefined;
  return row?.foreign_keys ?? 0;
}

/**
 * SQLite accepts `PRAGMA foreign_keys = OFF` **inside a transaction and ignores it, without an
 * error** — the pragma reads back unchanged. A rebuild migration would then fail later with a bare
 * `FOREIGN KEY constraint failed`, which points at the SQL rather than at the real cause. So read it
 * back and say what actually happened.
 */
function assertForeignKeysDisabled(foreignKeysValue: number, m: Migration): void {
  if (foreignKeysValue !== 0) {
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
function assertNoForeignKeyViolations(violations: SqlRow[], m: Migration): void {
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

/** {@link schemaVersion} on the async channel. */
async function schemaVersionAsync(db: AsyncSqliteConnection): Promise<number> {
  const row = (await db.get("PRAGMA user_version")) as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}
