#!/usr/bin/env bash
# astrolab-backup.sh — the host's nightly backup of the one SQLite file (`docs/RUNBOOK.md` §1).
#
# Run by `astrolab-backup.timer`. `.backup` is SQLite's online backup API: one transactionally
# consistent snapshot, taken while both writers keep running. The RUNBOOK's checkpoint-then-copy is
# still the manual procedure, but it is *not* point-in-time while the app is up, so the timer uses the
# one that is. Either way the copy is verified before it is trusted (`docs/RUNBOOK.md` §4).
set -euo pipefail

DB="${ASTROLAB_DB:-/opt/astrolab/data/astrolab.sqlite}"
DEST="${ASTROLAB_BACKUP_DIR:-/opt/astrolab/backups}"
KEEP_DAYS="${ASTROLAB_BACKUP_KEEP_DAYS:-14}"

[ -f "$DB" ] || { echo "[backup] no database at $DB" >&2; exit 1; }
install -d -m 755 "$DEST"

stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
out="$DEST/astrolab-$stamp.sqlite"
tmp="$out.partial"

sqlite3 "$DB" ".backup '$tmp'"
# Verify before publishing the file: a backup you have not opened is a hypothesis (RUNBOOK §4).
sqlite3 "$tmp" "PRAGMA integrity_check;" | grep -qx ok
mv "$tmp" "$out"

# Retention. This is a same-disk copy: it survives a bad deploy or a dropped table, not the loss of
# the volume. An off-host copy is the open gap (`docs/DEPLOY.md`, "what this does not cover").
find "$DEST" -name 'astrolab-*.sqlite' -mtime "+$KEEP_DAYS" -delete
echo "[backup] $out ($(du -h "$out" | cut -f1)); kept $(find "$DEST" -name 'astrolab-*.sqlite' | wc -l)"
