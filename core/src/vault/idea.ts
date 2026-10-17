/**
 * The `Idea` resource (`docs/API.md` §3.1) and the one row mapper both the write path (`capture.ts`)
 * and the read path (`ideas.ts`) use. It is a **shape**, not a validator: what makes a capture body
 * valid stays in `capture.ts` (`docs/API.md` §4.2).
 */

/** docs/API.md §3.1 — the response body of a capture, a list row, and a detail node alike. */
export interface Idea {
  id: string;
  hypothesis: string;
  problem: string;
  monetization: string;
  domain_tags: string[];
  lineage_kind: "ROOT" | "FORK";
  lineage_parent_id: string | null;
  status: "ACTIVE" | "NEEDS_COMPLETION";
  visibility: "PRIVATE";
  current_version: number;
  created_at: string;
  updated_at: string;
}

/** The `idea` row as stored: `domain_tags` is a JSON array in a TEXT column (docs/SCHEMA.md §2.1). */
export interface IdeaRow {
  id: string;
  hypothesis: string;
  problem: string;
  monetization: string;
  domain_tags: string;
  lineage_kind: Idea["lineage_kind"];
  lineage_parent_id: string | null;
  status: Idea["status"];
  visibility: Idea["visibility"];
  current_version: number;
  created_at: string;
  updated_at: string;
}

export function toIdea(row: IdeaRow): Idea {
  return {
    id: row.id,
    hypothesis: row.hypothesis,
    problem: row.problem,
    monetization: row.monetization,
    domain_tags: JSON.parse(row.domain_tags) as string[],
    lineage_kind: row.lineage_kind,
    lineage_parent_id: row.lineage_parent_id,
    status: row.status,
    visibility: row.visibility,
    current_version: row.current_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
