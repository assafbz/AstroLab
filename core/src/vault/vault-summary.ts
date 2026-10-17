import type { SqliteConnection } from "../store/connection.js";

/**
 * The vault summary — `GET /v1/vault/summary` (`docs/API.md` §4.3, §3.2; `docs/ARCHITECTURE.md` §3.2).
 *
 * **Two deterministic counts, from `domain_map` alone** — this module is the whole of the vault path
 * that answers S0's progress readout, and it can reach no provider: its only import is the SQLite type,
 * and `vault-summary.test.ts` fails the suite if a specifier that could reach a transport appears.
 *
 * - `resolved_domains` — distinct clusters covered by a tag present in `domain_map`.
 * - `provisional_domains` — distinct unmapped tags, each its own cluster.
 *
 * The count is **monotone non-decreasing** under the worker's normalisation: a provisional tag is
 * collapsed into a cluster by one write to `domain_map`, and nothing here can split one.
 */

/** The spark floor and the product target, as the contract fixes them (`FLOW.md` §5.2; `PRD.md` §5). */
export const FLOOR = 2;
export const TARGET = 3;

/** docs/API.md §3.2 — the keys are the contract's, not the module's shorthand. */
export interface VaultSummary {
  resolved_domains: number;
  provisional_domains: number;
  target: number;
  floor: number;
  eligible: boolean;
}

/**
 * **One statement, so the pair is one snapshot.** Two `SELECT`s could straddle a commit under WAL and
 * answer `resolved` from one vault state and `provisional` from another; a single statement is one read
 * snapshot by construction, so no transaction wrapper is needed (V2 needed one because it read five
 * times, not because reads are dangerous).
 *
 * `COUNT(DISTINCT …)` ignores NULLs, so the resolved arm needs no extra guard while the provisional arm
 * counts only rows the `LEFT JOIN` could not match. The match is **exact**: `domain_map.tag` is read as
 * stored, and capture stores each tag raw (`ARCHITECTURE.md` §3.2) — so a differently-spelled tag stays
 * provisional until the worker writes that exact spelling back. A normaliser here would be a second,
 * unstated vocabulary and would break the monotone rule.
 */
const SUMMARY_SQL = `SELECT COUNT(DISTINCT m.cluster_id) AS resolved_domains,
       COUNT(DISTINCT CASE WHEN m.cluster_id IS NULL THEN j.value END) AS provisional_domains
  FROM idea, json_each(idea.domain_tags) AS j
  LEFT JOIN domain_map m ON m.tag = j.value`;

export function vaultSummary(db: SqliteConnection): VaultSummary {
  const row = db.prepare(SUMMARY_SQL).get() as {
    resolved_domains: number;
    provisional_domains: number;
  };
  return {
    resolved_domains: row.resolved_domains,
    provisional_domains: row.provisional_domains,
    target: TARGET,
    floor: FLOOR,
    // §3.2's rule, exactly as frozen: the S0→S1 spread gate. E0 is the *engine's* state
    // (`FLOW.md` §4.1) and is computed in one place for `GET /v1/sparks/state` — never derived here.
    eligible: row.resolved_domains >= FLOOR,
  };
}
