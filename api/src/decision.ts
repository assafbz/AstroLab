import type { DatabaseSync } from "node:sqlite";

import {
  isoTimestamp,
  LIVE_STATUS,
  recordDismissal,
  sparkForDecision,
  vaultMutation,
  type DecisionSpark,
  type SparkStatus,
} from "@astrolab/store";

import {
  ConflictError,
  derivedStatus,
  insertProvenance,
  insertRootIdea,
  NotFoundError,
  requireObjectBody,
  requiredText,
  ValidationError,
  type IdeaFields,
} from "./capture.js";

/**
 * The Decision API — `POST /v1/sparks/{id}/decision` (`docs/API.md` §4.13, §3.5; K4 `#38`).
 *
 * The one resolving write in the product: **ACCEPT** derives a ROOT idea from the spark's proposed
 * direction, **DISMISS** keeps the pairing as negative signal. Both are vault operations and both must
 * succeed with the AI down (`FLOW.md` §4.3; NFR-A1) — this module reaches no provider and no worker.
 *
 * ## Idempotency is the whole point (`FLOW.md` §2.2 / N4)
 *
 * A swipe and a button tap fire before the card leaves, and a retry after an interrupted commit
 * re-sends the same request; all three carry the client's `decision_id`, and all three must resolve to
 * **one** decision. So the recorded row for that key is answered first — **before** the
 * already-`RESOLVED` state check — or a retry on a spark the first attempt already resolved would
 * `409` instead of returning the first `Decision`. Precedence, in full:
 *
 * | # | condition | answer |
 * | :-- | :-- | :-- |
 * | 0 | a malformed body — the HTTP layer's `parseDecisionInput` | `422` |
 * | 1 | a recorded decision for this `decision_id`, **this** spark | `200`, unchanged |
 * | 2 | an unknown `{id}` | `404` §2 envelope |
 * | 3 | a recorded decision for this `decision_id`, a **different** spark | `409` |
 * | 4 | a spark that is not `OFFERED` | `409` |
 *
 * Steps 0→2→3→4 are the `422 → 404 → 409` order §4.2/§4.6/§4.7 established (the body contract first,
 * then the id, then the state); step 1 is hoisted above them all, which is the reading this endpoint
 * adds. Every state check runs **inside** the transaction, so a refused resolution writes nothing —
 * the `404`/`409` can never churn the vault.
 *
 * ## The concurrency the issue names is the store's (`FLOW.md` §2.2 / N4)
 *
 * Nothing here arbitrates a race. `vaultMutation` opens `BEGIN IMMEDIATE`, so two connections racing
 * on one `decision_id` are serialised before either reads: the loser's transaction starts after the
 * winner's commit, step 1 finds the committed row, and it answers `200` — never a `500`, and never a
 * second idea. There is deliberately no bespoke `SQLITE_CONSTRAINT` handler, because under
 * `BEGIN IMMEDIATE` the primary-key conflict is unreachable: the lookup and the insert are one
 * serialised transaction, and a guard that cannot fail in the state it forbids is not a guard.
 *
 * **The evidence is replay-shaped, not a race (the N4 residual, stated).** `node:sqlite` is synchronous
 * and so is `resolveDecision`, so no in-process test interleaves two connections: both the
 * two-connection test (`decision.test.ts`) and the `Promise.all` pair over HTTP (`server.test.ts`)
 * *replay* — one call commits, then the other runs and reads the row the first left behind. That
 * replay is exactly the property N4 needs (a **retry**, not a lock), and it is what the tests check:
 * delete step 1 and both redden on the key-conflict branch, reached only because the second connection
 * read the committed row. The lock half is SQLite's own `BEGIN IMMEDIATE`, and only a genuinely
 * concurrent caller — two OS processes on one file, which no test here is — would exercise it.
 * Recorded rather than left implied.
 *
 * ## The one product call (ruled: `K4 #38`'s plan, call 1)
 *
 * A spark carries no `monetization` (`ARCHITECTURE.md` §2.3), so a one-tap Good cannot supply all four
 * mandatory fields. The prefill — `direction→hypothesis`, `claim→problem`, `monetization` blank,
 * `domain_tags` = the pair's **deduped union** — executes `FLOW.md` §4.3 step 4 / T27, so *every*
 * one-tap ACCEPT lands `NEEDS_COMPLETION`: saved, flagged, excluded from selection, and nudged. That
 * is T27 by construction, not a defect. `FLOW.md` §6 Q1 still marks it owner-overridable; if that
 * flips, the change is the map below and `derivedStatus`, not the schema.
 */

/** §4.13's body: the client's idempotency key and the resolution it names. */
export interface DecisionInput {
  decision_id: string;
  kind: DecisionKind;
}

/**
 * The two kinds **this** endpoint accepts. `INSPIRED` is deliberately absent: it is the committed
 * seeded save's (`§4.2`, K5 `#39`), not a deck decision, and `docs/API.md` §4.13 names only two.
 */
export type DecisionKind = "ACCEPT" | "DISMISS";

/** `docs/API.md` §3.5 — the response, and the row it is read back from. */
export interface Decision {
  decision_id: string;
  spark_id: string;
  kind: "ACCEPT" | "DISMISS" | "INSPIRED";
  /** The ROOT `ACCEPT` created; `null` for `DISMISS` (and for `INSPIRED` before its save commits). */
  result_idea_id: string | null;
  /** `FLOW.md` §3's verbatim terminal status — never a bare `ACCEPTED`. */
  spark_status: SparkStatus;
  decided_at: string;
  undoable: boolean;
}

/** §3.5's resolution → the spark's terminal status. `FLOW.md` §3's three verbs, in one place. */
const SPARK_STATUS: Record<Decision["kind"], SparkStatus> = {
  ACCEPT: "RESOLVED-ACCEPTED",
  DISMISS: "RESOLVED-DISMISSED",
  INSPIRED: "RESOLVED-INSPIRED",
};

/**
 * §4.13's body, shape-checked before any row is read (`422`). `kind` is the enum §1 and §2 treat as a
 * mandatory field: an unknown value and a missing one are the same status, for two different reasons,
 * and the comparison is **case-sensitive** (`accept` is not `ACCEPT`).
 */
export function parseDecisionInput(body: unknown): DecisionInput {
  const raw = requireObjectBody(body);
  const decision_id = requiredText(raw, "decision_id");
  const kind = raw["kind"];
  if (kind !== "ACCEPT" && kind !== "DISMISS") {
    throw new ValidationError("kind must be 'ACCEPT' or 'DISMISS'");
  }
  return { decision_id, kind };
}

/**
 * Resolve one spark, or refuse — `docs/API.md` §4.13. One transaction for the whole thing: the derived
 * idea, its provenance, the spark's status and the `decision` row commit together or not at all.
 *
 * The stamp and the run come from `vaultMutation` (`@astrolab/store`) rather than a call here, so the
 * ARCH §4 trigger cannot be forgotten: `decision` is one of §4's four tables, so **both** paths — and
 * not only ACCEPT — are candidate-affecting writes. The body is synchronous by type, or the writes
 * would land outside the transaction and go unstamped.
 */
export function resolveDecision(db: DatabaseSync, sparkId: string, input: DecisionInput): Decision {
  return vaultMutation(db, () => {
    // The clock is read once, at the top: §3.5's `undoable` is a property of the *response time*, so
    // both branches below — the idempotent repeat and the fresh resolution — read it off the same pass.
    const now = isoTimestamp();

    // 1 — the key first. A recorded row for this `decision_id` **and this spark** is the retry, and it
    // answers the first `Decision` untouched; putting the state check first would `409` a legal retry.
    const prior = findDecision(db, input.decision_id);
    if (prior !== null && prior.spark_id === sparkId) return toDecision(db, prior, now);

    // 2 — §2: an unknown spark is `not_found`. The resolving read is status-blind, so a resolved spark
    // still reads here; only an id the vault never held is absent.
    const spark = sparkForDecision(db, sparkId);
    if (spark === null) throw new NotFoundError(`spark ${sparkId} not found`);

    // 3 — the key is already committed to a different spark. One client id must not alias two
    // decisions, and returning the first would silently answer for the wrong card.
    if (prior !== null) {
      throw new ConflictError(
        `decision_id ${input.decision_id} is already recorded for spark ${prior.spark_id}`,
      );
    }

    // 4 — only a live offer may resolve (`ARCHITECTURE.md` §3.5). Reaching here with a resolved spark
    // means a *different* key is asking to resolve it twice.
    if (spark.status !== LIVE_STATUS) {
      throw new ConflictError(`spark ${sparkId} is ${spark.status}`);
    }

    const resultIdeaId = input.kind === "ACCEPT" ? accept(db, spark, now) : null;
    if (input.kind === "DISMISS") recordDismissal(db, spark.pair_key);

    db.prepare(
      `INSERT INTO decision (id, spark_id, kind, result_idea_id, decided_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(input.decision_id, sparkId, input.kind, resultIdeaId, now);
    db.prepare(`UPDATE spark SET status = ? WHERE id = ?`).run(SPARK_STATUS[input.kind], sparkId);

    // Read the row back so the shape is built **once**, from the stored row — including its `rowid`,
    // which the "a later decision exists" arm needs and an inline object cannot carry.
    return toDecision(db, findDecision(db, input.decision_id) as DecisionRow, now);
  });
}

/**
 * `FLOW.md` §4.3 step 1–2: the ROOT idea from the spark's proposed direction, and its provenance to
 * **both** sources. `monetization` is blank because the spark has none — `docs/API.md` §4.13 asks the
 * spark to supply what it can and leaves the rest to T27's `NEEDS_COMPLETION`.
 */
function accept(db: DatabaseSync, spark: DecisionSpark, now: string): string {
  const fields: IdeaFields = {
    hypothesis: spark.direction,
    problem: spark.claim,
    monetization: "",
    domain_tags: spark.domain_tags,
  };
  const idea = insertRootIdea(db, fields, derivedStatus(fields), now);
  insertProvenance(db, idea.id, spark.idea_a_id, spark.id);
  insertProvenance(db, idea.id, spark.idea_b_id, spark.id);
  return idea.id;
}

/**
 * The `decision` row as stored (`docs/SCHEMA.md`; the DDL's CHECK is the vocabulary), plus its
 * `rowid` — `decided_at` is second-granular, so "the next decision" is ordered by the same monotonic
 * insertion order the run reads use (§4.9, §4.15).
 */
export interface DecisionRow {
  rowid: number;
  id: string;
  spark_id: string;
  kind: Decision["kind"];
  result_idea_id: string | null;
  decided_at: string;
}

/**
 * The `decision` row for an id, or `null` — `decision.ts` stays the owner of a `decision` row (§4.15's
 * handler reads this rather than re-deriving the shape, so the row and its `rowid` are read one way).
 */
export function findDecision(db: DatabaseSync, id: string): DecisionRow | null {
  const row = db
    .prepare(
      "SELECT rowid, id, spark_id, kind, result_idea_id, decided_at FROM decision WHERE id = ?",
    )
    .get(id) as DecisionRow | undefined;
  return row ?? null;
}

/**
 * §3.5's shape, from the row. `spark_status` is derived from `kind` rather than read back off the
 * spark, so the answer is the resolution's own and a repeat cannot describe it differently.
 *
 * `undoable` is `undoableAt`'s verdict **at response time** — §3.5's "reflects server-side
 * reversibility (§5.4) at response time". A fresh resolution is reversible (nothing has happened to
 * retire it) and so is a repeat inside the window; a repeat of a decision a later swipe, a closed
 * window, or an edit has retired is `false`. The window is the server policy §4.15 owns, and this is
 * the *same* export §4.15's handler consults, so the two surfaces cannot describe one state two ways.
 */
function toDecision(db: DatabaseSync, row: DecisionRow, now: string): Decision {
  return {
    decision_id: row.id,
    spark_id: row.spark_id,
    kind: row.kind,
    result_idea_id: row.result_idea_id,
    spark_status: SPARK_STATUS[row.kind],
    decided_at: row.decided_at,
    undoable: undoableAt(db, row, now),
  };
}

/**
 * The undo window — `docs/API.md` §4.15's *"server-side policy (`FLOW.md` §5.4 leaves its duration
 * unspecified)"*. Five minutes: long enough to catch a mis-swipe, short enough that the deck has
 * moved on. A named constant and **not** `config`, which is the gate-threshold surface (§3.4);
 * promote it only if the window should be operator-tunable.
 */
export const UNDO_WINDOW_SECONDS = 300;

/**
 * Why a decision is no longer reversible — `docs/API.md` §4.15 / §3.5. Four arms, in the precedence
 * §4.15 pins (a later decision, then the window, then the derived idea): a state the client must see
 * the same way whether it reads `undoable` or calls the route.
 */
export type UndoRefusal = "superseded" | "expired" | "edited" | "missing";

/**
 * The **one** reversibility predicate (§4.15 / §3.5, K6 `#40`). `null` means reversible; otherwise
 * the first arm that retires it:
 *
 * - `superseded` — a later `decision` exists. §5.4's *"no longer than until the next decision"* is the
 *   deck session's next swipe, either card, so the test is **global** and ordered by `rowid`
 *   (`decided_at` is second-granular and ties).
 * - `expired` — the window closed (`UNDO_WINDOW_SECONDS`).
 * - `edited` / `missing` — ACCEPT (and a committed seeded INSPIRED save) retracts its derived idea
 *   *"only if still unedited"* (§5.4): an idea past version 1 is edited, and one already gone leaves
 *   nothing to retract. A DISMISS created no idea, so neither arm applies to it.
 *
 * §4.13's `undoable` calls this through `toDecision`; §4.15's handler calls it too, so one state has
 * one answer. Kept out of the transaction-free read path deliberately: it reads the vault, so every
 * caller already holds a connection.
 */
export function undoRefusal(db: DatabaseSync, row: DecisionRow, now: string): UndoRefusal | null {
  const later = db.prepare("SELECT 1 FROM decision WHERE rowid > ? LIMIT 1").get(row.rowid);
  if (later !== undefined) return "superseded";
  if (Date.parse(now) - Date.parse(row.decided_at) > UNDO_WINDOW_SECONDS * 1000) return "expired";
  if (row.kind !== "DISMISS") {
    const idea = db
      .prepare("SELECT current_version FROM idea WHERE id = ?")
      .get(row.result_idea_id) as { current_version: number } | undefined;
    if (idea === undefined) return "missing";
    if (idea.current_version > 1) return "edited";
  }
  return null;
}

/** §3.5's `undoable`, as the boolean the response carries — `undoRefusal`'s null. */
export function undoableAt(db: DatabaseSync, row: DecisionRow, now: string): boolean {
  return undoRefusal(db, row, now) === null;
}
