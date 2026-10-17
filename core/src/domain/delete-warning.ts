/**
 * The T26 delete confirm's copy (`FLOW.md` §2.1 T26; `docs/API.md` §4.8).
 *
 * Deleting is **orphan-with-warning**: the server does not block, so the warning is the whole
 * safety mechanism and it has to name what it orphans. Both directions of the #80 carry are stated
 * here — a fork child keeps a dangling parent reference, and an idea this one is a provenance source
 * for keeps a dangling provenance reference. Neither is deleted, so neither is a reason to block; the
 * line exists so the user is not surprised later.
 *
 * The ids are rendered as the contract returns them, never resolved — the same rule as the detail
 * screen (D5), and the only honest option for a reference that names a tombstone.
 */
export interface DeleteWarning {
  summary: string;
  /** One line per affected direction; empty when nothing references the idea. */
  details: string[];
}

export function deleteWarning(refs: { forks: string[]; derived: string[] }): DeleteWarning {
  const details: string[] = [];

  if (refs.forks.length > 0) {
    details.push(`Fork children keep a dangling parent reference: ${refs.forks.join(", ")}.`);
  }
  if (refs.derived.length > 0) {
    details.push(
      `Spark-derived ideas keep a dangling provenance reference: ${refs.derived.join(", ")}.`,
    );
  }

  return { summary: "Delete this idea?", details };
}
