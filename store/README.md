# `@astrolab/store`

The SQLite store: one file, two writer processes (the API and the worker) — `ARCHITECTURE.md` §1, §9;
`ADR-0001`. Built on Node's built-in `node:sqlite`, so the package adds no dependency and CI needs no
native build.

> **Node 22 prints a one-line `ExperimentalWarning`** (*"SQLite is an experimental feature…"*) in any
> process that imports `node:sqlite`; node 26 does not. It is a warning, not an error, and CI tolerates
> it — but it is the visible price of taking the builtin over `better-sqlite3`.

## Connection

```ts
import { openStore } from "@astrolab/store";

const db = openStore(process.env.DB_PATH ?? "./data/astrolab.sqlite");
```

`openStore` sets the posture the architecture names, once per connection:

| pragma | value | why |
| :-- | :-- | :-- |
| `journal_mode` | `WAL` | readers don't block the writer — what makes two writer processes workable |
| `busy_timeout` | `5000` ms (override with `busyTimeoutMs`) | SQLite waits for a released lock before returning `SQLITE_BUSY` |
| `foreign_keys` | `ON` | the schema's guards are real foreign keys (`docs/SCHEMA.md`); it is per-connection, so it lives here |

## Writing

`writeTransaction` is the shape every write takes: `BEGIN IMMEDIATE` (take the write lock up front), your
statements, `COMMIT` — retried on `SQLITE_BUSY` with bounded backoff (5 attempts, 20 ms doubling to a
250 ms ceiling by default).

```ts
import { writeTransaction } from "@astrolab/store";

writeTransaction(db, () => db.exec("INSERT INTO idea (id) VALUES ('…')"));
```

A retry re-runs the body, so the transaction is **at-least-once**: write paths must be keyed idempotently
— decisions are unique on `(spark_id, decision_id)` (`FLOW.md` §2.2) — rather than made once-only.

## Migrations

Forward-only and versioned: there is no `down`. The applied version is SQLite's own `PRAGMA user_version`,
and each pending migration runs in its own transaction, so a failure leaves the file exactly where it was.

```ts
import { migrate, type Migration } from "@astrolab/store";

const MIGRATIONS: Migration[] = [{ version: 1, name: "0001_init", sql: "…" }];
migrate(db, MIGRATIONS);
```

`0001_init` — the twelve tables of `ARCHITECTURE.md` §2 — is F3's (#10); the DDL of record is
`docs/SCHEMA.md`. Running against a store *newer* than the build throws rather than guessing.

## Backup

WAL means the `.sqlite` file alone is not a complete copy — committed data can still live in `-wal`. The
procedure is **checkpoint, then copy**:

```sh
sqlite3 "$DB_PATH" "PRAGMA wal_checkpoint(TRUNCATE);"   # fold -wal back into the main file
cp "$DB_PATH" "astrolab-$(date +%F).sqlite"             # now one self-contained file
```

- `TRUNCATE` leaves the WAL empty, so the copy needs no `-wal`/`-shm` companions and opens standalone.
- A checkpoint is safe with writers running (it truncates only what it could fold in). For a guaranteed
  point-in-time copy, stop the API and the worker first.
- JSON export is a separate path — V6 (#17) owns the runbook.

Restore is the reverse: stop both processes, replace the file, start.
