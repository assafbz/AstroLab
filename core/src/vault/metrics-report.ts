import type { SqliteConnection } from "../store/connection.js";

import { vaultSummary } from "./vault-summary.js";

/**
 * EV2 (`#44`) — **the metrics readout** (`docs/PRD.md` §5, `docs/PRD.md:160–164`).
 *
 * Five families, the five the PRD names: the North Star Metric (**sparks accepted per active user per
 * month**), vault **diversity** (distinct domains per user), onboarding **activation** (the gate / the
 * target), **lineage** activity (forks + iterations per user) and **retention** (weekly return).
 *
 * **Queries, deliberately not a route** — the same fence EV1 (`#43`) set and stated on its thread
 * (*"EV2 `#44` will want the same fence"*): the MVP's surface is frozen (`docs/API.md`), the issue asks
 * for *"queries (documented, …)"*, and an in-app readout is its own item. Every function here is
 * read-only, `api`-local SQL over the F3 tables, and reaches no provider. **It is a separate module
 * from `metrics.ts`, not an addition to it**: that module's docstring scopes it to NFR-Q1's single
 * instrument (`idea.new_domain`), and the five families below carry no instrument of their own — they
 * are aggregations over the rows the rest of the vault already writes.
 *
 * ## Call 1 — what "an active user" means, since no column carries one
 *
 * The MVP vault is **single-tenant**: neither `idea` nor `decision` carries an owner and there is no
 * `user` table (`docs/SCHEMA.md` §1). The unit of account is therefore the **active user-month** — a
 * `YYYY-MM` (UTC) in which the vault recorded **≥ 1 decision of any kind** (`ACCEPT` / `DISMISS` /
 * `INSPIRED`; `FLOW.md` §4.3). For the one tenant the count is `1`, so "per active user" normalizes by
 * `1` and the NSM is its numerator (`acceptedByMonth`, `metrics.ts`); the denominator is produced
 * anyway (`activeUserMonths`), so the readout survives a second tenant with no redefinition. This is
 * the definition `#44` asks to be documented.
 *
 * ## Call 2 — what "a weekly return" means, since there is no event log
 *
 * No session or event table exists, so a "return" cannot be observed directly. A return is defined as
 * **a week in which ≥ 1 decision was recorded** — a **proxy** over the only activity trace the schema
 * keeps (the `decision` table), not a session measure. The week key is `strftime('%Y-W%W', stamp)`:
 * SQLite's **Monday-based week-of-year, `00`–`53`** (SQLite has no ISO-8601 `%V`), so the key is
 * spelled `YYYY-Www` and its `ww` can be `00`. A week with no row is **absent**, not zero — the same
 * convention `metrics.ts` states for months. `weeklyRetention` also reports the window's week count so
 * the rate is a stated division rather than an implied one.
 *
 * ## Call 3 — an iteration is not a `lineage_kind`
 *
 * `0004` retired `ITERATION` from `lineage_kind` (`docs/SCHEMA.md` §1c); an iteration is a new
 * `idea_version` row on the **same** node and creates no edge (`iterate.ts`, `FLOW.md` §2.3 L1). So
 * `lineageActivityByMonth` reads a **fork** from `idea.lineage_kind = 'FORK'` and an **iteration** from
 * `idea_version` where `version > 1` — `version = 1` is the row's birth, not a turn of the flywheel —
 * each bucketed by the row's own `created_at`.
 *
 * ## What is re-derived and what is not
 *
 * `distinctDomainsPerUser` and `onboardingActivation` read `vaultSummary` rather than restating its
 * `COUNT(DISTINCT cluster_id)` SQL: that module is the one authority for "how many domains does this
 * vault carry, and does it clear the gate" (`vault-summary.ts`), and a second copy of the statement is
 * exactly the drift the repo treats as a defect. What these two add is the PRD's *shape* — a domain
 * **count** for diversity, and the **gate/target** pair with its rate for activation.
 */

/** One month bucket — `month` is a `YYYY-MM` UTC key, `count` the rows whose stamp falls in it. */
export interface MonthlyCount {
  month: string;
  count: number;
}

/** One month's lineage volume: `forks` from `idea`, `iterations` from `idea_version`. */
export interface LineageActivityMonth {
  month: string;
  forks: number;
  iterations: number;
}

/** One week's activity: `week` is a `YYYY-Www` key, `decisions` the decisions recorded in it. */
export interface WeeklyActivity {
  week: string;
  decisions: number;
}

/** The weekly-retention readout: the weeks that moved, over the weeks the window spans. */
export interface RetentionReadout {
  weeks: WeeklyActivity[];
  active_weeks: number;
  weeks_spanned: number;
  /** `active_weeks / weeks_spanned`, and `0` when the window spans no week (an empty range). */
  rate: number;
}

/** Distinct domains carried by the one vault, split as `vault-summary.ts` splits them. */
export interface DiversityPerUser {
  resolved: number;
  provisional: number;
  total: number;
}

/** The onboarding reading: the gate (`≥ 2`) and the target (`≥ 3`) over the vault's resolved count. */
export interface OnboardingActivation {
  resolved_domains: number;
  floor: number;
  target: number;
  cleared_gate: boolean;
  met_target: boolean;
}

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * `metrics.ts`'s rule, restated here for its own module — a malformed bound is a **loud** failure, not
 * a silent empty report (`substr(stamp, 1, 7) >= 'x'` is a valid comparison that returns nothing).
 * `[from, to)` ordering is *not* validated: a reversed range is a legitimate empty window.
 */
function requireMonthKey(value: string, name: string): string {
  if (!MONTH_KEY.test(value)) {
    throw new RangeError(`${name} must be a YYYY-MM month key (UTC), got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Months that recorded **any** decision — the "active user-month" set (`Call 1`), with its volume. */
export function activeUserMonths(db: SqliteConnection, from: string, to: string): MonthlyCount[] {
  requireMonthKey(from, "from");
  requireMonthKey(to, "to");
  return db
    .prepare(
      `SELECT substr(decided_at, 1, 7) AS month, COUNT(*) AS count
         FROM decision
        WHERE substr(decided_at, 1, 7) >= ? AND substr(decided_at, 1, 7) < ?
        GROUP BY month ORDER BY month ASC`,
    )
    .all(from, to) as unknown as MonthlyCount[];
}

/**
 * **Diversity** (`PRD.md` §5) — distinct domains represented per user. Resolved clusters plus
 * provisional (unmapped) tags, which `vault-summary.ts` counts as one domain each until the worker
 * resolves them; the sum is the vault's breadth in its own vocabulary, and `total` is the single
 * number the metric names.
 */
export function distinctDomainsPerUser(db: SqliteConnection): DiversityPerUser {
  const summary = vaultSummary(db);
  return {
    resolved: summary.resolved_domains,
    provisional: summary.provisional_domains,
    total: summary.resolved_domains + summary.provisional_domains,
  };
}

/**
 * **Onboarding activation** (`PRD.md` §5) — the gate is **≥ 2 distinct resolved domains** and the
 * target is **≥ 3** (`vault-summary.ts`'s `FLOOR` / `TARGET`). One vault has one answer, so the
 * "percentage of new users" the PRD quotes is `1` or `0` here; the two booleans are what a single
 * vault can state, and they are read off the same two numbers the gate itself uses.
 */
export function onboardingActivation(db: SqliteConnection): OnboardingActivation {
  const summary = vaultSummary(db);
  return {
    resolved_domains: summary.resolved_domains,
    floor: summary.floor,
    target: summary.target,
    cleared_gate: summary.resolved_domains >= summary.floor,
    met_target: summary.resolved_domains >= summary.target,
  };
}

/**
 * **Lineage activity** (`PRD.md` §5) — forks and iterations per user, per month (`Call 3`). The two
 * counts come from different tables and are merged on the month key; a month present in either read is
 * emitted, with `0` for the half it has no row for, so a month that only iterated still appears.
 */
export function lineageActivityByMonth(
  db: SqliteConnection,
  from: string,
  to: string,
): LineageActivityMonth[] {
  requireMonthKey(from, "from");
  requireMonthKey(to, "to");
  const forks = db
    .prepare(
      `SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS count
         FROM idea
        WHERE lineage_kind = 'FORK'
          AND substr(created_at, 1, 7) >= ? AND substr(created_at, 1, 7) < ?
        GROUP BY month`,
    )
    .all(from, to) as unknown as MonthlyCount[];
  const iterations = db
    .prepare(
      `SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS count
         FROM idea_version
        WHERE version > 1
          AND substr(created_at, 1, 7) >= ? AND substr(created_at, 1, 7) < ?
        GROUP BY month`,
    )
    .all(from, to) as unknown as MonthlyCount[];

  const merged = new Map<string, LineageActivityMonth>();
  for (const row of forks)
    merged.set(row.month, { month: row.month, forks: row.count, iterations: 0 });
  for (const row of iterations) {
    const current = merged.get(row.month) ?? { month: row.month, forks: 0, iterations: 0 };
    current.iterations = row.count;
    merged.set(row.month, current);
  }
  return [...merged.values()].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}

/**
 * **Retention** (`PRD.md` §5) — `Call 2`'s proxy: the weeks in `[from, to)` that recorded ≥ 1
 * decision, over the weeks the window spans. `weeks_spanned` is counted from the same `%W` key the
 * rows use (a recursive walk over the window's days, `COUNT(DISTINCT …)`), so the numerator and the
 * denominator are one convention and the rate cannot exceed `1` — every decision in `[from, to)` shares
 * a key with some day of the same window. An empty window (`from >= to`; month keys compare
 * chronologically) spans no week and reports `rate: 0` rather than a division by zero.
 */
export function weeklyRetention(db: SqliteConnection, from: string, to: string): RetentionReadout {
  requireMonthKey(from, "from");
  requireMonthKey(to, "to");
  const weeks = db
    .prepare(
      `SELECT strftime('%Y-W%W', decided_at) AS week, COUNT(*) AS decisions
         FROM decision
        WHERE substr(decided_at, 1, 7) >= ? AND substr(decided_at, 1, 7) < ?
        GROUP BY week ORDER BY week ASC`,
    )
    .all(from, to) as unknown as WeeklyActivity[];
  // An empty window (`from >= to` — month keys compare chronologically) spans no week. Without the
  // guard the recursive CTE's base row would make a reversed range report `1`, and the rate a
  // plausible-looking fraction over a window that does not exist.
  const weeksSpanned =
    from < to
      ? (
          db
            .prepare(
              `WITH RECURSIVE span(d) AS (
                 SELECT date(? || '-01')
                  UNION ALL
                 SELECT date(d, '+1 day') FROM span WHERE d < date(? || '-01', '-1 day')
               )
               SELECT COUNT(DISTINCT strftime('%Y-W%W', d)) AS weeks FROM span`,
            )
            .get(from, to) as { weeks: number }
        ).weeks
      : 0;
  const active = weeks.length;
  return {
    weeks,
    active_weeks: active,
    weeks_spanned: weeksSpanned,
    rate: weeksSpanned === 0 ? 0 : active / weeksSpanned,
  };
}
