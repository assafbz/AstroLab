import type { CaptureInput, Idea, VaultSummary } from "../api/types.ts";
import { createIdea } from "../api/ideas.ts";
import { normalizeDomainTag, validateCapture, type CaptureErrors } from "./capture.ts";
import type { DomainCluster } from "./taxonomy.ts";

/**
 * S0's own rules (`FLOW.md` §2.1/S0, §4.2 T02/T04; `PRD.md` §3.4 item 1) — pure, so the screen is a
 * renderer. Three things live here and nothing else:
 *
 * 1. **the cross-domain prompt cycle** — one prompt at a time (`PRD.md` §3.4 item 1);
 * 2. **the domain lane** — a pick from the shipped taxonomy, or the `Other → free text` escape, whose
 *    **typed** lane is provisional (`FLOW.md` §6 Q6 → r3.3);
 * 3. **the progress readout** — read from the summary's payload, never counted here.
 *
 * Validation is **not** re-implemented: S0's mandatory set is S2's four fields with S2's rule
 * (`FLOW.md` T02), so `validateCapture` is reused verbatim — see `validateOnboardingIdea`.
 */

/**
 * The prompts, in the spec's order (`PRD.md` §3.4 item 1): *"an idea from your work", "a frustration
 * nobody has fixed", "a domain you have never worked in"* — the stitch §7 titles are the rendered
 * form. There are **three**, the same number as the `x/3` target, so one prompt per covered domain at
 * the target.
 */
export const ONBOARDING_PROMPTS: readonly string[] = [
  "An idea from your work",
  "A frustration nobody has fixed",
  "An idea from a domain you've never touched",
];

/** The prompt for a cycle index — advances one per saved idea and wraps after the third. */
export function promptFor(index: number): string {
  const prompts = ONBOARDING_PROMPTS;
  return prompts[((index % prompts.length) + prompts.length) % prompts.length]!;
}

/** Which lane a domain came from. Only the lane decides the provisional flag (see the module note). */
export type DomainLane = "picked" | "typed";

export interface DomainChoice {
  /** What goes on the wire as a `domain_tag`. */
  tag: string;
  lane: DomainLane;
}

/**
 * A pick from the taxonomy. **The tag is the cluster `key`, never its `name`** — `store/seed/README.md`
 * rule 2: the loader registers each cluster's key (and only the key) as a tag in its own cluster, and
 * *"the `name:` label … is never registered as a tag: normalising a label mints rows like `ai-&-ml`"*.
 * A pick is therefore **resolved by construction**, with no AI on the path (R1).
 */
export function chooseCluster(cluster: DomainCluster): DomainChoice {
  return { tag: cluster.key, lane: "picked" };
}

/**
 * The `Other → free text` escape. The tag is written **immediately** with the capture — "provisional"
 * is not a stored state; it is what the summary computes at read time for a tag absent from
 * `domain_map` (`docs/API.md` §3.2, `ARCHITECTURE.md` §3.2). Normalised by the **same** rule S2/S3
 * use, so the Vault filter's exact match (`docs/API.md` §4.4) and the summary's exact match can both
 * see it. A blank (or bare `#`) entry yields `null` — nothing to add.
 */
export function chooseFreeText(raw: string): DomainChoice | null {
  const tag = normalizeDomainTag(raw);
  return tag === "" ? null : { tag, lane: "typed" };
}

/** The visible provisional flag: a property of the **lane**, not a per-tag lookup. */
export function isProvisional(choice: DomainChoice): boolean {
  return choice.lane === "typed";
}

export interface OnboardingIdea {
  hypothesis: string;
  problem: string;
  monetization: string;
  /** `null` until a pick or a typed entry lands — the domain is mandatory (`FLOW.md` T02). */
  domain: DomainChoice | null;
}

/**
 * S2's validator, applied to S0's draft (`FLOW.md` T02's "mandatory-field validation as in S2").
 * No copy and no extraction: the four fields and the rule are identical, so the shared module is
 * called as it is. The domain enters as the one-element array S2's `domain_tags` rule already checks.
 */
export function validateOnboardingIdea(idea: OnboardingIdea): CaptureErrors {
  return validateCapture({
    hypothesis: idea.hypothesis,
    problem: idea.problem,
    monetization: idea.monetization,
    domain_tags: idea.domain ? [idea.domain.tag] : [],
  });
}

/** S0's draft as the frozen §4.2 request. A blank capture sends the seeded pair as `null`. */
export function toCaptureInput(idea: OnboardingIdea): CaptureInput {
  return {
    hypothesis: idea.hypothesis,
    problem: idea.problem,
    monetization: idea.monetization,
    domain_tags: idea.domain ? [idea.domain.tag] : [],
    origin_spark_id: null,
    decision_id: null,
  };
}

/** The save. T02 is `S0 → S0`: the idea is created and the user stays on onboarding. */
export function saveOnboardingIdea(idea: OnboardingIdea): Promise<Idea> {
  return createIdea(toCaptureInput(idea));
}

/** The `domains covered x / 3` readout's two numbers. */
export interface Progress {
  covered: number;
  target: number;
}

/**
 * The readout, read **only** from the summary's payload:
 *
 * - the numerator is `resolved_domains` — *"summary returns `domains covered` = the **resolved**
 *   cluster count"* (`ARCHITECTURE.md` §3.2), the same quantity the engine's E0 check reads, so the
 *   readout and O4's gate cannot disagree (R1);
 * - the denominator is the payload's `target` — a literal `3` here would be a second, drifting
 *   vocabulary;
 * - `provisional_domains` is deliberately **not** read: a typed lane never counts toward the gate;
 * - the numerator is capped at the target, because the target is a goal — `5 / 3` has no
 *   representation and the bar has three segments.
 */
export function progress(summary: VaultSummary): Progress {
  return { covered: Math.min(summary.resolved_domains, summary.target), target: summary.target };
}
