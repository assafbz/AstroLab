import type { Idea } from "../api/types.ts";
import { emptyMandatoryFields, type CaptureDraft } from "./capture.ts";

/**
 * K8 `#42` — the **completion** rule (`FLOW.md` T27, §4.3 step 4).
 *
 * A spark-derived idea cannot always be prefilled: a spark carries no `monetization`, so §4.13's ACCEPT
 * lands it `NEEDS_COMPLETION` (`derivedStatus`, `api/src/decision.ts:205`), held out of candidate
 * selection by the W7 gate until the user supplies what is missing. §4.6's iterate now clears the flag
 * by **re-deriving** the status from the four fields, so this module's one job is to say, client-side,
 * *what is still owed* — the prompt's wording, and nothing the server has not already decided.
 *
 * It is a **mirror, not an authority** (the same posture `capture.ts` takes): the server owns the
 * status, and the two must agree. `completionPrompt` returns `null` exactly when the four fields are
 * all supplied — the same test the server makes — so a screen cannot prompt for a field the server
 * would call present, or stay silent about one it would call absent.
 */

/** The four mandatory fields (`PRD.md` §2), keyed as `CaptureDraft` spells them. */
export type MissingField = keyof CaptureDraft;

/** The field names the screens already use (`stitch-prompts.md` §3, §5), as the prompt reads them. */
const LABELS: Record<MissingField, string> = {
  hypothesis: "the core hypothesis",
  problem: "the problem solved",
  monetization: "the monetization / value angle",
  domain_tags: "a domain",
};

/** The idea's own four fields, verbatim — the draft a completion edit starts from (§4.6's request). */
export function draftFromIdea(idea: Idea): CaptureDraft {
  return {
    hypothesis: idea.hypothesis,
    problem: idea.problem,
    monetization: idea.monetization,
    domain_tags: idea.domain_tags,
  };
}

/**
 * The mandatory fields this idea has **not** supplied, in the contract's order. Empty when the idea is
 * complete — in which case it is not `NEEDS_COMPLETION` at all, and no screen should prompt for it.
 */
export function missingFields(idea: Idea): MissingField[] {
  return emptyMandatoryFields(draftFromIdea(idea));
}

/**
 * The `NEEDS_COMPLETION` ideas in a read, **in the read's order** (§4.4 is `created_at DESC, id DESC`
 * — the client does not re-sort, so "newest owed" is the first element).
 */
export function needsCompletion(ideas: Idea[]): Idea[] {
  return ideas.filter((idea) => idea.status === "NEEDS_COMPLETION");
}

/**
 * The **polish prompt** for one idea — what to supply, in the screens' own words — or `null` when
 * nothing is owed. T27's *"nudged, not blocked"* is this sentence: the idea is saved and readable, and
 * the prompt names the next move rather than gating anything.
 */
export function completionPrompt(idea: Idea): string | null {
  const missing = missingFields(idea);
  if (missing.length === 0) return null;
  return `Add ${list(missing.map((field) => LABELS[field]))} to put it back in play.`;
}

/** `a` · `a and b` · `a, b and c` — a sentence, not a comma splice. */
function list(items: string[]): string {
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]!}`;
}
