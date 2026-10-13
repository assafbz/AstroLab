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

Two details of that setup are load-bearing, because the API and the worker boot independently:

- `busy_timeout` is set **before** the WAL conversion, and that conversion is **retried**. SQLite does
  not run the busy handler for a journal-mode change, so two processes converting a fresh file at once
  would otherwise collide with `SQLITE_BUSY` instantly — however large the timeout. On the retry the
  loser finds the file already in WAL, where the pragma is a no-op.
- Consequently a bare `new DatabaseSync(path)` at a second boot site would reintroduce that race: open
  the file through `openStore`.
- That retry bounds the boot race by the **retry window** (~300 ms: 5 attempts, 20 ms doubling to a
  250 ms ceiling), **not** by `busy_timeout` — a loser whose conversion is blocked past the budget
  still fails to boot. A real fresh-file conversion is sub-millisecond, so the budget is generous;
  it is a deliberate limit, not a wall.

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
import { migrate, MIGRATIONS } from "@astrolab/store";

migrate(db, MIGRATIONS);
```

`0001_init` — the twelve tables of `ARCHITECTURE.md` §2 — ships in `src/migrations.ts` (`MIGRATIONS`,
`SCHEMA_VERSION`); the DDL of record is `docs/SCHEMA.md`. It deliberately does not set
`PRAGMA foreign_keys`: that is per-connection and a no-op inside a transaction, so `openStore` owns it.
`0002_seed_vault_meta` then seeds the `vault_meta` singleton, so §4's relative `revision` bump lands
instead of silently matching zero rows. Running against a store *newer* than the build throws rather
than guessing.

`migrate` is safe to call from both processes at boot: the applied version is re-read **inside** the
transaction, so a process that loses the write-lock race skips the migration instead of re-applying its
DDL. Without that re-read, a concurrent boot fails with `table … already exists`.

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
