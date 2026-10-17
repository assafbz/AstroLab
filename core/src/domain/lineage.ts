import type { Idea } from "../types.js";

/**
 * The lineage chain's **tombstone** rule (V8 `#19`'s follow-up, on S4).
 *
 * §4.5's `lineage` is the **live** ancestor chain, root-first. A parent that no longer exists ends the
 * walk (`api/src/ideas.ts` `ancestorChain` breaks rather than failing), so a fork child whose parent was
 * deleted reads `lineage: []` while its `lineage_parent_id` still names the parent — §4.8's *"fork
 * children keep their parent reference"*, the dangling ref the contract tolerates on purpose.
 *
 * D5's rule, applied to the chain: **render the reference, never resolve it and never drop it.** A
 * chain that quietly became a one-node chain would read as "this idea was always a root", which is a
 * different claim from "its parent is gone" — and the user's own vault history is exactly what the
 * chain is for.
 */

/**
 * The parent id the chain cannot resolve — the tombstone node — or `null` when the chain is whole: a
 * `ROOT`, or a `FORK` whose immediate parent is present among the ancestors.
 *
 * It compares against the whole chain rather than only its last element because a *complete* chain is
 * the only live case: §4.5's walk stops at the first missing parent, so a chain that does not carry
 * this node's parent is missing it, and no deeper ancestor can stand in.
 */
export function danglingParentId(idea: Idea, lineage: Idea[]): string | null {
  const parent = idea.lineage_parent_id;
  if (parent === null) return null;
  return lineage.some((ancestor) => ancestor.id === parent) ? null : parent;
}
