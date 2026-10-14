import type { DatabaseSync } from "node:sqlite";

import { isoTimestamp } from "./iso.js";
import { withRetry } from "./retry.js";

/**
 * The `idea_mechanism` descriptor cache, as SQL over one table (`ARCHITECTURE.md` §2.3, §3.3 step 1).
 *
 * It lives in `store` — beside `runs.ts`, the same precedent: SQL over the worker's tables lives
 * here though §1 gives the worker those writes — because **two callers that do not depend on each
 * other** need it. The **worker** writes the descriptor (W3); the **API's delete path** (V5 #16)
 * must clear the rows for a deleted idea, or removing an idea violates `idea_mechanism`'s foreign key
 * (`idea_mechanism.idea_id` has no `ON DELETE`, and `openStore` sets `PRAGMA foreign_keys = ON`).
 * Engine-side SQL would force a new `api → worker` dependency, which neither package has today.
 *
 * ## The named exception to `vaultMutation`
 *
 * `vaultMutation` (§4's trigger) governs the vault tables and **stamps `vault_meta.revision` +
 * enqueues a run**; the cache is **derived state**, so writing it through the trigger would advance
 * the revision inside the run that writes it, discarding the run's own outcome (§4 / I). These
 * functions therefore write directly — **never** `writeTransaction`, never a stamp. That is the
 * *named exception* the boundary's docstring asks a later stage to arrive with, and this is its
 * reason (Max's #78 ruling; David's, 2026-10-14).
 *
 * `descriptor` is a JSON **string**: `store` persists bytes and does not know the descriptor's shape,
 * so nothing here imports the AI boundary (NFR-A1 holds by construction).
 */

// A `type`, not an `interface`: a type alias of an object literal gets an implicit index signature,
// so the `.all()` row cast typechecks without an `as unknown` two-step (the shape `queue.ts` uses).
export type IdeaMechanism = {
  idea_id: string;
  descriptor: string;
  source_hash: string;
  extracted_at: string;
};

const COLUMNS = "idea_id, descriptor, source_hash, extracted_at";

/** The cached rows for these ideas — only the ids that have one. An empty id list reads nothing. */
export function readDescriptors(db: DatabaseSync, ideaIds: readonly string[]): IdeaMechanism[] {
  if (ideaIds.length === 0) return [];
  const placeholders = ideaIds.map(() => "?").join(", ");
  return db
    .prepare(`SELECT ${COLUMNS} FROM idea_mechanism WHERE idea_id IN (${placeholders})`)
    .all(...ideaIds) as IdeaMechanism[];
}

/** Write (or replace) one idea's descriptor — idempotent, one row per idea (`§2.3`). */
export function upsertDescriptor(
  db: DatabaseSync,
  input: { ideaId: string; descriptor: string; sourceHash: string },
): void {
  withRetry(() =>
    db
      .prepare(
        `INSERT INTO idea_mechanism (idea_id, descriptor, source_hash, extracted_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(idea_id) DO UPDATE SET
           descriptor = excluded.descriptor,
           source_hash = excluded.source_hash,
           extracted_at = excluded.extracted_at`,
      )
      .run(input.ideaId, input.descriptor, input.sourceHash, isoTimestamp()),
  );
}
