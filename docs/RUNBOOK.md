# RUNBOOK — Backup · Restore · Export

The vault's durability and portability procedures (`docs/PRD.md` NFR-D1; `docs/ARCHITECTURE.md` §8).
Operator-facing: what to run, what it guarantees, and — in the last two sections — what it does not.

The store is **one SQLite file**, opened through `openStore` (`@astrolab/store`; `store/README.md`), with
two writer processes — the API and the worker. The file lives at `DB_PATH` (default
`./data/astrolab.sqlite`). Two facts drive everything below:

- **WAL is on**, so the `.sqlite` file *alone* is not a complete backup — committed data can still sit in
  the `-wal` sidecar until a checkpoint folds it back.
- **The file is the whole vault.** There is no second datastore, no vector index, no object store
  (`ARCHITECTURE.md` §9). A copy of this one file — or the export document — is the entire state.

---

## 1. Backup

**Checkpoint, then copy.** The checkpoint folds `-wal` into the main file; `TRUNCATE` then empties the
WAL, so the copy is one self-contained file with no `-wal`/`-shm` companions.

```sh
DB_PATH=${DB_PATH:-./data/astrolab.sqlite}

sqlite3 "$DB_PATH" "PRAGMA wal_checkpoint(TRUNCATE);"   # fold -wal back into the main file
cp "$DB_PATH" "astrolab-$(date -u +%Y-%m-%dT%H%M%SZ).sqlite"
```

- A checkpoint is safe with writers running — it folds only what it can, and never blocks them. It is
  therefore **not** a point-in-time snapshot: a write committing between the checkpoint and the copy can
  land in the copy, or miss it.
- For a **guaranteed point-in-time** copy, stop the API and the worker first, then checkpoint and copy.
- **Verify the copy before trusting it** (§4). A backup you have not opened is a hypothesis.

**On a deployed host this runs itself.** `astrolab-backup.timer` (→ `astrolab-backup.service` →
`deploy/backup.sh`) takes a copy nightly into `/opt/astrolab/backups` and keeps 14 days. It uses
**`.backup` — SQLite's online backup API** — rather than checkpoint-then-copy: both writers are live on
that host, and `.backup` yields a point-in-time file without stopping them, which a checkpoint followed
by a copy does not. The manual procedure above stands unchanged, and its *guaranteed* variant is still
"stop the processes, then checkpoint and copy". Either way the copy is verified before it is trusted
(§4). The deployed paths are in `docs/DEPLOY.md`.

## 2. Restore

The reverse: stop both processes, put the file back, start — boot runs migrations forward.

```sh
# the API and the worker are stopped
cp astrolab-2026-10-15T051405Z.sqlite "$DB_PATH"
rm -f "$DB_PATH-wal" "$DB_PATH-shm"     # a stale -wal beside a replaced file is not the backup
# start the API and the worker; each boots through openStore → migrate(db, MIGRATIONS)
```

- **Migrations run forward at boot** (`migrate`; `store/README.md`). A backup taken on an older build is
  brought up to `SCHEMA_VERSION` on first start; `migrate` refuses a store **newer** than the build
  rather than guessing, so restore a file whose `user_version` is ≤ the running build's.
- **No committed idea is lost** on this path (`ARCHITECTURE.md` §8) — every idea, version, lineage and
  provenance edge, and every decision is in the file.

**On a deployed host.** Stop the stack first, then replace the file, then start it — the boot re-runs
`migrate` exactly as the manual path does:

```sh
systemctl stop astrolab
cp /opt/astrolab/backups/astrolab-2026-10-15T051405Z.sqlite /opt/astrolab/data/astrolab.sqlite
rm -f /opt/astrolab/data/astrolab.sqlite-wal /opt/astrolab/data/astrolab.sqlite-shm
systemctl start astrolab
```

## 3. Export (the open, portable path)

`GET /v1/export` returns the whole vault as one self-describing JSON document (`docs/API.md` §4.17;
`ARCHITECTURE.md` §8) — the format that needs no SQLite, no schema, and no code of ours to read.

```sh
curl -sS -H "Authorization: Bearer $API_TOKEN" http://localhost:8080/v1/export \
  | jq '{schema_version, ideas: (.ideas|length), edges: (.lineage_edges|length)}'
```

- **Eight keys, top-level, in contract order**: `schema_version, exported_at, ideas[], idea_versions[],
  lineage_edges[], provenance_edges[], decisions[], domain_tags[]`.
- **One snapshot, read-only.** `exported_at` and the seven arrays come from a single `BEGIN`…`COMMIT`, so
  a writer committing mid-read cannot make the document disagree with itself — and the read writes
  nothing (no revision bump, no run). Safe to run against a **live** vault; no need to stop the
  processes.
- **`decisions[]` is empty until the decision writer lands** (K4 `#38`) — correct for a vault with no
  decisions, not a stub to fill.
- **Auth** like every `/v1` route (§1): no token is `401`.

## 4. Verify a backup or an export

```sh
# the copy opens standalone, and its schema version is the build's or older:
sqlite3 astrolab-2026-10-15T051405Z.sqlite "PRAGMA user_version; SELECT count(*) FROM idea;"
```

The **automated** checks are **EV5 `#47`** — a backup→wipe→restore test and an export→re-import
round-trip test, both asserting idea counts and lineage/provenance edges survive. V6 `#17` ships this
runbook and the endpoint; the round-trip proof is EV5's (build ≠ prove), and it is **not yet shipped** —
until it lands, the checks above are what stands behind the guarantee.

## Not in this document

Two portability gaps are **deliberately** outside the frozen eight keys; read them as known, not missing
(EV5 `#47` is where a round-trip meets them):

- **`decisions[].spark_id` names a spark the document does not carry** — there is no `spark[]` key. A
  re-import that keeps decisions needs the spark rows from the file path, not the JSON path.
- **`domain_cluster` names and `adjacency` are not exported** — `domain_tags[]` is the `domain_map`
  vocabulary (`{tag, cluster_id}`); the cluster *names* and the adjacency graph behind the spread gate
  are not among the eight keys.

Neither gap costs a **committed idea**: both live in the file path (§1–§2), which is complete.
