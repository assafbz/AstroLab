import type { SqliteConnection } from "./connection.js";

import { withRetry } from "./retry.js";

/**
 * The two gate thresholds (`ARCHITECTURE.md` §3.4): `min_domain_distance` and `min_alignment`.
 *
 * §3.4 says the cut-offs *"live in `config`, seeded with defaults and tuned empirically … changing a
 * threshold never changes the schema or the API."* This module is the whole of that surface: a read
 * that validates, a write, and an **insert-only** seed. The `config` table already exists
 * (`0001_init`), so W5 adds **no migration** — seeding is data, not DDL.
 *
 * ## The write is non-stamping, deliberately (the `idea_mechanism` / `domain_map` exception)
 *
 * `config` is not one of §4's trigger tables (`idea` / `idea_version` / `provenance_edge` /
 * `decision`), so `seedGateConfig` / `setConfig` write directly through `withRetry`, never through
 * `vaultMutation`. A stamp here would advance `vault_meta.revision` inside the run reading the
 * thresholds and make that run discard its own outcome (Max's #78 ruling). Guarded where the write
 * lives: `core/test/config.test.ts` fails if a seed or a set bumps the revision or writes a run.
 *
 * ## Seeding is insert-only, and that is the point
 *
 * `seedGateConfig` is `INSERT … ON CONFLICT(key) DO NOTHING` — it runs at boot (the app's composition
 * root, L2; v1's `api/src/index.ts` and `worker/src/boot.ts`, beside `seedDomainTaxonomy`) and must be
 * **safe to run on every boot**. A
 * `DO UPDATE` would silently revert an operator's tuning on the next restart, which is the exact
 * thing §3.4's *"tuned empirically"* forbids. Insert-only means the first boot writes the default and
 * every later boot leaves whatever is there alone. `setConfig` is the explicit overwrite.
 *
 * ## A missing value is a default; a malformed one is a loud error
 *
 * `readGateConfig` fills an **absent** key from the code default but throws `InvalidConfigError` on a
 * value that does not parse. It never falls back to the default on a malformed value: running the
 * engine on a threshold the operator did not choose, and surfacing that as nothing, is the silent
 * failure this module exists to prevent. Read **per gate run**, so a change takes effect without a
 * redeploy.
 *
 * ## The shipped defaults, and what each one is
 *
 * - **`min_domain_distance = 1` — spec-derived.** §3.5 drops the *cliché* quadrant (high alignment,
 *   **low distance**) *by the gate*. A same-domain pair is `distance === 0` (`domain.ts`), and the
 *   gate's comparator passes the distance axis iff `distance === null || distance >= min`, so a
 *   default of `0` would let every same-domain, high-alignment pair through — the cliché quadrant.
 *   `FLOW.md` §4.1 — *"only *same-domain* pairs are cliché-suppressed"* — pins the ceiling at `1`:
 *   `2` would also suppress 1-hop (adjacent-cluster) pairs, which are **not** same-domain, and would
 *   falsify E0 on exactly the two-adjacent-cluster vault its floor describes. So the spec forces
 *   **exactly `1`** — a floor, not a midpoint, and **not tunable in the MVP** (raising it is an edit
 *   to §4.1, not a tuning value). **`0` stays valid but is a *spec override*, not tuning**: it
 *   disables the §3.5 cliché guard, so read it as *"cliché guard disabled (§3.5 override) —
 *   same-cluster pairs are eligible"*. It is **not** the default.
 * - **`min_alignment = 0.02` — the W9 τ\*, seeded for coverage (a deliberate C3 amendment).** W9
 *   (#34) measured the metric on the calibration vault and found `alignment`'s attainable maximum is
 *   `0.125` (`ARCHITECTURE.md` §12 item 2 · issue #106) — so the former provisional `0.5` could never
 *   gate anything, and the gate was **dark**. `0.02` is the **widened** sweep's floor
 *   (`W9_WIDE_TAUS`, `worker/src/engine/calibration/w9-run.ts` — below the ratified `W9_TAUS` range)
 *   and the lowest τ on which the bar's yield condition (C4: ≥ 5 good) holds: 67 surfaced · 21 good ·
 *   precision **0.31**. The owner chose it on 2026-10-15 ("B alone"). It **amends** the precision
 *   condition (C3: ≥ 80%) rather than passing it — precision is **uncertified** until a scorer
 *   reproduces itself (`W9_CALIBRATION.md` §2, the `instrument` label) — so never read it as
 *   *"clears C3 ∧ C4"*. The bar's own selector still enforces C3, so `selectTau` returns `null` on
 *   this vault while this constant is `0.02`: the seed is the owner's pinned value, **not** the rule's
 *   output. The axis keeps its downstream backstop (an over-*low* floor only spends W6 calls, and W6
 *   rejects noise anyway); the over-*high* direction — the gate offering nothing, indistinguishable
 *   from *"no aligned pairs exist"* — is exactly what the old provisional `0.5` produced.
 *   **Insert-only, like the distance axis:** a store already seeded under `0.5` keeps it until an
 *   operator calls `setConfig`, so this default reaches **new** stores only.
 */

/** The two thresholds the gate compares against, parsed and validated. */
export interface GateConfig {
  /** `≥ 0` integer, spec-bounded to `1`. `0` = cliché guard disabled (§3.5 override, see the module note). */
  minDomainDistance: number;
  /**
   * A real in `[0,1]`. The shipped default is the W9 τ\* (`0.02`) — a C3 amendment seeded for
   * coverage, not a provisional value (see the module note).
   */
  minAlignment: number;
}

export const MIN_DOMAIN_DISTANCE_KEY = "min_domain_distance";
export const MIN_ALIGNMENT_KEY = "min_alignment";

/**
 * The code-held defaults (§3.4), seeded insert-only. `min_domain_distance` is spec-derived;
 * `min_alignment` is the W9 τ\*.
 */
export const GATE_CONFIG_DEFAULTS: GateConfig = { minDomainDistance: 1, minAlignment: 0.02 };

/** A stored threshold that does not parse. Loud by design — never a silent fallback to the default. */
export class InvalidConfigError extends Error {
  constructor(key: string, value: string, why: string) {
    super(`config.${key} = ${JSON.stringify(value)} is invalid: ${why}`);
    this.name = "InvalidConfigError";
  }
}

function parseDomainDistance(raw: string): number {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(n) || n < 0) {
    throw new InvalidConfigError(MIN_DOMAIN_DISTANCE_KEY, raw, "expected an integer ≥ 0");
  }
  return n;
}

function parseAlignment(raw: string): number {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n < 0 || n > 1) {
    throw new InvalidConfigError(MIN_ALIGNMENT_KEY, raw, "expected a real in [0,1]");
  }
  return n;
}

/** Each key's parser, so `readGateConfig` and `setConfig` validate the same way. */
const PARSERS: Record<string, (raw: string) => number> = {
  [MIN_DOMAIN_DISTANCE_KEY]: parseDomainDistance,
  [MIN_ALIGNMENT_KEY]: parseAlignment,
};

/**
 * The two thresholds, read together. An **absent** key reads as its code default; a **present but
 * malformed** value throws `InvalidConfigError`.
 */
export function readGateConfig(db: SqliteConnection): GateConfig {
  const rows = db
    .prepare("SELECT key, value FROM config WHERE key IN (?, ?)")
    .all(MIN_DOMAIN_DISTANCE_KEY, MIN_ALIGNMENT_KEY) as Array<{ key: string; value: string }>;
  const stored = new Map(rows.map((row) => [row.key, row.value]));

  const distanceRaw = stored.get(MIN_DOMAIN_DISTANCE_KEY);
  const alignmentRaw = stored.get(MIN_ALIGNMENT_KEY);
  return {
    minDomainDistance:
      distanceRaw === undefined
        ? GATE_CONFIG_DEFAULTS.minDomainDistance
        : parseDomainDistance(distanceRaw),
    minAlignment:
      alignmentRaw === undefined ? GATE_CONFIG_DEFAULTS.minAlignment : parseAlignment(alignmentRaw),
  };
}

/**
 * Seed the shipped defaults **insert-only** — a no-op on any key already present, so a tuned value
 * survives every later boot. Called beside `seedDomainTaxonomy` at both boot sites.
 */
export function seedGateConfig(db: SqliteConnection): void {
  withRetry(() => {
    const insert = db.prepare(
      "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
    );
    insert.run(MIN_DOMAIN_DISTANCE_KEY, String(GATE_CONFIG_DEFAULTS.minDomainDistance));
    insert.run(MIN_ALIGNMENT_KEY, String(GATE_CONFIG_DEFAULTS.minAlignment));
  });
}

/**
 * Overwrite one threshold — the explicit tuning path (§3.4). Validates a **known** key before writing
 * so a malformed value never reaches the table; an unknown key is stored verbatim (the table is
 * generic, and a future setting should not need this module changed).
 */
export function setConfig(db: SqliteConnection, key: string, value: string): void {
  PARSERS[key]?.(value);
  withRetry(() =>
    db
      .prepare(
        `INSERT INTO config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value),
  );
}
