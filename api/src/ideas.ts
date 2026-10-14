import type { DatabaseSync } from "node:sqlite";

import { ValidationError } from "./capture.js";
import { toIdea, type Idea, type IdeaRow } from "./idea.js";

/**
 * The vault **read** path (`docs/API.md` §4.4, §4.5): `GET /v1/ideas` and `GET /v1/ideas/{id}`.
 *
 * Two properties hold here and are tested, not assumed:
 * - **Provenance ≠ lineage.** `provenance` is its own array and never feeds `lineage` — a seeded idea
 *   has provenance and *no* lineage parent (`docs/API.md` §5 invariant 3).
 * - **The absent case is empty, never an error.** An idea with no provenance, no ancestors and no
 *   reverse references answers `200` with empty arrays (`docs/API.md` §4.5; the V2 ruling).
 *
 * No path here can reach the provider (`docs/ARCHITECTURE.md` §3.2, §4): both endpoints are reads.
 */

/** `GET /v1/ideas` filters (`docs/API.md` §4.4). `null` = the contract's "no restriction". */
export interface VaultFilters {
  domain: string | null;
  lineage: Idea["lineage_kind"] | null;
  status: Idea["status"] | null;
}

/** docs/API.md §3.1 — the enums, as the contract spells them. */
const LINEAGE_KINDS = ["ROOT", "ITERATION", "FORK"] as const;
const STATUSES = ["ACTIVE", "NEEDS_COMPLETION"] as const;

/**
 * `docs/API.md` §4.4 + §1. An absent key means no restriction; a key that is present with an empty
 * value, or with a value outside its enum, is `422 validation_failed` — the contract's "unknown enum
 * value" rule, applied to the filters' own vocabulary. **Unknown parameter names are ignored** (§1)
 * and a repeated key takes its first occurrence, both as recorded in §6.
 */
export function parseVaultFilters(query: URLSearchParams): VaultFilters {
  return {
    domain: optionalText(query, "domain"),
    lineage: optionalEnum(query, "lineage", LINEAGE_KINDS),
    status: optionalEnum(query, "status", STATUSES),
  };
}

/**
 * `docs/API.md` §4.4. One query, filters AND-composed, ordered `created_at DESC, id DESC` (§6) — the
 * `id` tiebreak because `isoTimestamp` truncates to the second, so two ideas really can share one.
 *
 * The `domain` filter matches the tag **exactly**: `json_each` walks the stored JSON array, so `fin`
 * does not match `fintech` the way a `LIKE` would.
 */
export function listIdeas(db: DatabaseSync, filters: VaultFilters): Idea[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filters.lineage !== null) {
    where.push("lineage_kind = ?");
    params.push(filters.lineage);
  }
  if (filters.status !== null) {
    where.push("status = ?");
    params.push(filters.status);
  }
  if (filters.domain !== null) {
    where.push("EXISTS (SELECT 1 FROM json_each(idea.domain_tags) AS j WHERE j.value = ?)");
    params.push(filters.domain);
  }
  const sql = `SELECT * FROM idea ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY created_at DESC, id DESC`;
  // `node:sqlite` types `.all()` as rows of `SQLOutputValue`; the select above fixes the shape, so this
  // is a narrowing, not a guess — `as unknown as` is the cast that does not require an index signature.
  return (db.prepare(sql).all(...params) as unknown as IdeaRow[]).map(toIdea);
}

function optionalText(query: URLSearchParams, key: string): string | null {
  if (!query.has(key)) return null;
  const value = query.get(key) ?? "";
  if (value === "") throw new ValidationError(`${key} must not be empty when present`);
  return value;
}

function optionalEnum<T extends string>(
  query: URLSearchParams,
  key: string,
  allowed: readonly T[],
): T | null {
  const value = optionalText(query, key);
  if (value === null) return null;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`${key} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}
