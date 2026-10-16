/**
 * Capture's validation and domain-tag handling (`docs/API.md` §4.2; `FLOW.md` T17).
 *
 * **This is UX parity, not authority.** The server enforces the invariants (`docs/API.md` §0 last
 * line); this module exists so the inline error appears under the field the moment Save is pressed,
 * instead of arriving a round-trip later as a `422`. The two must agree, so the rules below mirror
 * `api/src/capture.ts` exactly — trimming for emptiness, measuring the hypothesis as typed.
 */

import type { InspireSeed } from "../api/types.ts";

/** `docs/API.md` §4.2 — the hypothesis limit, mirroring the server's `MAX_HYPOTHESIS_LENGTH`. */
export const HYPOTHESIS_MAX = 280;

export interface CaptureDraft {
  hypothesis: string;
  problem: string;
  monetization: string;
  domain_tags: string[];
}

/** Keys are present only on failure; `{}` means the draft is valid (`FLOW.md` T17). */
export interface CaptureErrors {
  hypothesis?: string;
  problem?: string;
  monetization?: string;
  domain_tags?: string;
}

/**
 * §4.2's mandatory set — the four fields, with the inline message each carries when absent. **One
 * table**, so `validateCapture` and `emptyMandatoryFields` cannot disagree about what "mandatory"
 * means; the emptiness test itself is `isAbsent` below.
 */
const MANDATORY: ReadonlyArray<{ field: keyof CaptureDraft; message: string }> = [
  { field: "hypothesis", message: "Hypothesis is required" },
  { field: "problem", message: "Problem is required" },
  { field: "monetization", message: "Monetization is required" },
  { field: "domain_tags", message: "Add at least one domain" },
];

/**
 * Absent = empty on the trimmed value for the three text fields, and no tag for `domain_tags`.
 * Whitespace-only is a missing field, not a present one — a naive `!== ""` check would let `"   "`
 * through and the server would answer `422` with no inline error having shown (Review Focus 3;
 * `api/src/capture.ts` `requiredText`).
 */
function isAbsent(draft: CaptureDraft, field: keyof CaptureDraft): boolean {
  return field === "domain_tags" ? draft.domain_tags.length === 0 : draft[field].trim() === "";
}

/**
 * The mandatory fields that are **absent**, in the contract's order. This is the client mirror of the
 * server's `derivedStatus` (`api/src/decision.ts:205`): the same four-field completeness test, which
 * is what decides `ACTIVE` vs `NEEDS_COMPLETION` and therefore what a completion prompt names
 * (§4.6, K8 `#42`). It is deliberately *not* `validateCapture`: that also fails a 281-character
 * hypothesis, which is a fixable draft error, not a field the user has not supplied.
 */
export function emptyMandatoryFields(draft: CaptureDraft): Array<keyof CaptureDraft> {
  return MANDATORY.filter(({ field }) => isAbsent(draft, field)).map(({ field }) => field);
}

export function validateCapture(draft: CaptureDraft): CaptureErrors {
  const errors: CaptureErrors = {};

  for (const { field, message } of MANDATORY) {
    if (isAbsent(draft, field)) errors[field] = message;
  }

  // The length is the value *as typed*, matching the server, which measures the untrimmed string —
  // and it is only reached when the field is present, so an empty one keeps its "required" message.
  if (!errors.hypothesis && draft.hypothesis.length > HYPOTHESIS_MAX) {
    errors.hypothesis = `Hypothesis exceeds ${HYPOTHESIS_MAX} characters`;
  }

  return errors;
}

/**
 * The **seeded prefill** — §4.14's seed mapped onto the four fields Capture has (T09/T16; `FLOW.md`
 * §2.2's INSPIRE row; `docs/stitch-prompts.md` §3). Pure: the screen renders this.
 *
 * Four of the seed's six fields land, and the two that do not are deliberate:
 *
 * - `direction → hypothesis`, `claim → problem` — the spark's idea and its why.
 * - `monetization` is **blank**: a spark carries none, and inventing one would be the client supplying
 *   a value the user owns (`PRD.md` §2 makes it theirs), so the seeded save is blocked until they fill
 *   it — the same §4.2 validation as a blank capture, no separate rule.
 * - `domain_tags` is taken **as given** — the server already folded the two source ideas' union, deduped
 *   and in pair order (§3.3), so re-normalising or re-deduping here would be a second, disagreeing copy
 *   of a rule the store owns.
 * - `what_it_takes` / `first_step` have **no Capture field** to seed, so they are not carried, and no
 *   read-only block is invented to hold them: `FLOW.md` §2.2/§4.3 name no destination for them (#119).
 */
export function seedToDraft(seed: InspireSeed): CaptureDraft {
  return {
    hypothesis: seed.direction,
    problem: seed.claim,
    monetization: "",
    domain_tags: seed.domain_tags,
  };
}

/** The live mono counter (`FLOW.md` T17; `DESIGN.md` §3). */
export function counterText(length: number): string {
  return `${length} / ${HYPOTHESIS_MAX}`;
}

/**
 * One tag, canonical for the wire: trimmed, a leading `#` dropped, lowercased. The Vault filter
 * matches a tag *exactly* (`docs/API.md` §4.4), so `fin` and `fintech` are different domains and a
 * stored `#FinTech` could never match a `fintech` chip — normalising here is what keeps the client's
 * own filter agreeing with the server (Review Focus 5).
 */
export function normalizeDomainTag(raw: string): string {
  return raw.trim().replace(/^#+/, "").trim().toLowerCase();
}

/** Add one tag, normalised; a blank (or bare `#`) entry is ignored, and a duplicate is not stored. */
export function addDomainTag(tags: string[], raw: string): string[] {
  const tag = normalizeDomainTag(raw);
  if (tag === "" || tags.includes(tag)) return tags;
  return [...tags, tag];
}

export function removeDomainTag(tags: string[], tag: string): string[] {
  return tags.filter((existing) => existing !== tag);
}
