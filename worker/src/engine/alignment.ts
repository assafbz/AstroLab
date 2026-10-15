import type { MechanismDescriptor } from "../provider/index.js";

/**
 * Axis 2's comparison — the **pure** descriptor similarity (`ARCHITECTURE.md` §3.3 step 2). No db, no
 * provider, no clock: given two descriptors it returns a number in `[0,1]`, and the gate is the only
 * caller. This is the *"deterministic similarity over the two descriptors (normalised field/token
 * match)"* §3.3 names — the spec stops there, so the one product-shaped choice on this axis (the
 * metric) is made here and nowhere else.
 *
 * ## The metric (W5 D1; ruled, and flip-able in review)
 *
 * The **uniform mean** of the per-field Jaccard token overlap over §3.3's four descriptor fields:
 * `(jac(verb) + jac(object_class) + jac(constraint) + jac(transferable_structure)) / 4`.
 *
 * - `normalise(s)` = lowercase → split on non-alphanumerics → drop empties → **dedupe** (a set).
 *   A token *set*, not a bag: repetition is not emphasis.
 * - `jac(A,B) = |A∩B| / |A∪B|`, with **both-empty ⇒ 0**. Jaccard (not Dice, not cosine) because it
 *   needs no vector and no length normalisation.
 *
 * A uniform mean is the simplest aggregate that is **symmetric**, **bounded**, and needs no weights
 * §3.3 never states; it also keeps the axes **orthogonal** — domain distance (W4) measures *domain*,
 * this measures *structure*. **Lexical and deterministic only**: no stemming, no stopwords, no
 * synonyms, no embeddings — an embedding metric is rejected both as a *single combined score* and as
 * an ANN/vector-store dependency (`docs/adr/0002-spark-engine.md`, *Alternatives considered*;
 * `docs/PRD.md` §3.3 item 7 forbids a vector store as an MVP requirement), and §3.3 step 2 names this
 * step a *deterministic* similarity.
 *
 * ## `both-empty ⇒ 0`, and why it is unreachable
 *
 * `parseDescriptor` (`provider/schema.ts`) rejects a blank field, so all four descriptor fields are
 * non-empty on every path the gate can see; this branch is **dead by construction**. It returns `0`
 * (not `1`) so that *if* the invariant ever loosens, the failure is **closed**: two ideas that say
 * nothing about a field share *no* evidence of a mechanism, and must not read as maximally aligned —
 * `1` there would let the gate manufacture a spark from two absences. It can never *inflate*
 * alignment, which is the only property that matters for a dead branch.
 *
 * ## What this is not
 *
 * W9 tunes the **threshold** (`min_alignment`), never this function — a metric change is a different
 * axis, not a calibration. `descriptorSimilarity` is one pure function behind a stable signature, so
 * a future weighted mean is a one-line change no caller sees.
 */

const FIELDS = ["verb", "object_class", "constraint", "transferable_structure"] as const;

/** Lowercase, split on anything that is not a letter or digit, drop empties, dedupe. */
function tokenise(text: string): Set<string> {
  const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  const set = new Set<string>();
  for (const token of tokens) if (token !== "") set.add(token);
  return set;
}

/**
 * Jaccard token overlap of two token sets, in `[0,1]`. Both-empty ⇒ `0` (see the module note) — the
 * guard exists only to keep `0/0` from becoming `NaN`.
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * The similarity of two mechanism descriptors, in `[0,1]` (`0` = no shared token in any field, `1` =
 * identical). Symmetric and deterministic. W5's gate compares this against `min_alignment`.
 */
export function descriptorSimilarity(a: MechanismDescriptor, b: MechanismDescriptor): number {
  let total = 0;
  for (const field of FIELDS) total += jaccard(tokenise(a[field]), tokenise(b[field]));
  return total / FIELDS.length;
}
