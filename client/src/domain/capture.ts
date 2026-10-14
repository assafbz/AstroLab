/**
 * Capture's validation and domain-tag handling (`docs/API.md` §4.2; `FLOW.md` T17).
 *
 * **This is UX parity, not authority.** The server enforces the invariants (`docs/API.md` §0 last
 * line); this module exists so the inline error appears under the field the moment Save is pressed,
 * instead of arriving a round-trip later as a `422`. The two must agree, so the rules below mirror
 * `api/src/capture.ts` exactly — trimming for emptiness, measuring the hypothesis as typed.
 */

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

/** The three required *text* fields; `domain_tags` is an array and is checked separately below. */
type RequiredTextField = "hypothesis" | "problem" | "monetization";

const REQUIRED: Array<[RequiredTextField, string]> = [
  ["hypothesis", "Hypothesis is required"],
  ["problem", "Problem is required"],
  ["monetization", "Monetization is required"],
];

export function validateCapture(draft: CaptureDraft): CaptureErrors {
  const errors: CaptureErrors = {};

  for (const [field, message] of REQUIRED) {
    // Emptiness is judged on the trimmed value: whitespace-only is a missing field, not a present
    // one — a naive `!== ""` check would let `"   "` through and the server would answer `422`
    // with no inline error having shown (Review Focus 3; `api/src/capture.ts` `requiredText`).
    if (draft[field].trim() === "") errors[field] = message;
  }

  // The length is the value *as typed*, matching the server, which measures the untrimmed string.
  if (!errors.hypothesis && draft.hypothesis.length > HYPOTHESIS_MAX) {
    errors.hypothesis = `Hypothesis exceeds ${HYPOTHESIS_MAX} characters`;
  }

  if (draft.domain_tags.length === 0) errors.domain_tags = "Add at least one domain";

  return errors;
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
