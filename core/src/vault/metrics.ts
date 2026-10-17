import type { SqliteConnection } from "../store/connection.js";

/**
 * The NFR-Q1 queries — EV1 (`#43`), half two (`docs/PRD.md` §5 / NFR-Q1: *"accepted sparks, and how
 * many landed in a new domain"*).
 *
 * Three **queries**, deliberately not a route: the MVP's surface is frozen (`docs/API.md`), and both
 * `#43` and `#44` ask for *"a reporting query"* / *"queries (documented, …)"*. An in-app readout is its
 * own item. Every one of them is read-only and reaches no provider — `api`-local SQL over the F3
 * tables, so this module imports nothing but the SQLite type.
 *
 * ## The bucket convention, stated once
 *
 * Every function bucketed here takes `[from, to)`: two **month keys** in `YYYY-MM`, UTC, `from`
 * inclusive and `to` exclusive. A month key is the timestamp's own first seven characters
 * (`substr(stamp, 1, 7)`) — the store's stamps are the ISO second-resolution UTC strings
 * `isoTimestamp` writes and `export.test.ts` pins, so the key is exact rather than parsed, and
 * lexicographic order on `YYYY-MM` is chronological order. A month with no rows is **absent**, not
 * zero: emitting the calendar would need a generator the caller may not want, and the caller knows the
 * range it asked for.
 *
 * ## What is never inferred
 *
 * The instrument is `idea.new_domain` (`0006`), `NULL` = **"not recorded"**. Every count below takes
 * `= 1` and never `!= 1`, so a row whose value was never written is excluded rather than read as `0` —
 * the difference between "this idea did not widen the vault" and "nobody asked". §4.13's ACCEPT is the
 * writer that leaves `NULL`, because its root's tags are the source pair's union and the reading there
 * is constant-false; `store/src/domain-map.ts` carries the proof.
 */

/** One month bucket: `month` is a `YYYY-MM` UTC key, `count` the rows whose stamp falls in it. */
export interface MonthlyCount {
  month: string;
  count: number;
}

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * A malformed bound is a **loud** failure rather than an empty report. `substr(stamp, 1, 7) >= 'x'` is a
 * perfectly valid comparison that silently returns nothing, so a caller who passed an instant
 * (`2026-10-16T00:00:00Z`) instead of a month would get a plausible-looking zero. `[from, to)` ordering
 * is *not* validated: reversed bounds are a legitimate empty range, not an error.
 */
function requireMonthKey(value: string, name: string): string {
  if (!MONTH_KEY.test(value)) {
    throw new RangeError(`${name} must be a YYYY-MM month key (UTC), got ${JSON.stringify(value)}`);
  }
  return value;
}

/** The three functions differ only in their statement; the binding and the shape are shared. */
function monthly(db: SqliteConnection, sql: string, from: string, to: string): MonthlyCount[] {
  requireMonthKey(from, "from");
  requireMonthKey(to, "to");
  return db.prepare(sql).all(from, to) as unknown as MonthlyCount[];
}

/**
 * §4.13's **accepted sparks**, bucketed by the month the decision was taken (`decision.decided_at`).
 * `kind = 'ACCEPT'` exactly: a `DISMISS` keeps a pairing as negative signal and creates no idea, and an
 * `INSPIRED` save is §4.2's captured idea, not an acceptance — neither is a spark that "landed".
 *
 * The cohort is the **accept**, not the follow-through: this is the denominator of the ratio below, and
 * it is stable under everything that happens to the root afterwards (an iterate, or a delete).
 */
export function acceptedByMonth(db: SqliteConnection, from: string, to: string): MonthlyCount[] {
  return monthly(
    db,
    `SELECT substr(decided_at, 1, 7) AS month, COUNT(*) AS count
       FROM decision
      WHERE kind = 'ACCEPT' AND substr(decided_at, 1, 7) >= ? AND substr(decided_at, 1, 7) < ?
      GROUP BY month ORDER BY month ASC`,
    from,
    to,
  );
}

/**
 * **Ideas that widened the vault**, bucketed by the month the idea row was written
 * (`idea.created_at`) — every idea, whatever minted it: a capture, a fork, an iterate that moved a node
 * into a fresh domain (the row's `created_at` is its birth, so an iterate counts in the month the *idea*
 * was created, not the month of the widening).
 *
 * This is the widest of the three and the only one that sees a **fork**'s widening at all: a fork is a
 * different `idea` row, and `acceptedLandingNewDomainByMonth` reads the accepted root alone.
 */
export function newDomainByMonth(db: SqliteConnection, from: string, to: string): MonthlyCount[] {
  return monthly(
    db,
    `SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS count
       FROM idea
      WHERE new_domain = 1 AND substr(created_at, 1, 7) >= ? AND substr(created_at, 1, 7) < ?
      GROUP BY month ORDER BY month ASC`,
    from,
    to,
  );
}

/**
 * **NFR-Q1's literal sentence** — of the sparks accepted in a month, how many landed in a new domain —
 * and the payoff of storing the flag on `idea` rather than on `decision`: the join is the follow-through
 * relation (`decision.result_idea_id` → `idea.id`) that a `decision`-stored flag could not express.
 *
 * Two consequences of that shape, both intended and both stated:
 *
 * - **The bucket is the accept month** (`d.decided_at`), while `i.new_domain` is read **as of report
 *   time**. A root born `NEEDS_COMPLETION` that a later month's iterate moves into a fresh domain
 *   therefore enters an **earlier** bucket than the write that flipped it. That is the cohort reading —
 *   "the sparks accepted in M, and what became of them" — not a claim about when the widening happened;
 *   `newDomainByMonth` is the month-of-widening view. A recorded `1` is **durable** (§4.6 writes it
 *   monotonically), so a cohort's landing count does not fall away when a root is later edited or
 *   re-saved — the only exit is the row itself disappearing.
 * - **A root deleted since its accept is absent here and counted by `acceptedByMonth`.** An inner join
 *   is the only honest option: the flag lived on a row that no longer exists, so the instrument cannot
 *   speak for it, and inventing a `0` would understate the landing rate instead of recording that the
 *   cohort lost a member.
 *
 * `new_domain = 1` (never `!= 1`) excludes the `NULL`s — §4.13 mints every root with an unrecorded flag,
 * so the ratio this feeds is *recorded* landings over *all* accepted sparks, and the gap between the
 * two is the unrecorded set rather than a silent zero.
 */
export function acceptedLandingNewDomainByMonth(
  db: SqliteConnection,
  from: string,
  to: string,
): MonthlyCount[] {
  return monthly(
    db,
    `SELECT substr(d.decided_at, 1, 7) AS month, COUNT(*) AS count
       FROM decision AS d JOIN idea AS i ON i.id = d.result_idea_id
      WHERE d.kind = 'ACCEPT' AND i.new_domain = 1
        AND substr(d.decided_at, 1, 7) >= ? AND substr(d.decided_at, 1, 7) < ?
      GROUP BY month ORDER BY month ASC`,
    from,
    to,
  );
}
