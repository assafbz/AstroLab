import { expect, test } from "vitest";

import type { VaultSummary } from "../api/types.ts";
import {
  ONBOARDING_PROMPTS,
  chooseCluster,
  chooseFreeText,
  isProvisional,
  progress,
  promptFor,
  toCaptureInput,
  validateOnboardingIdea,
  type OnboardingIdea,
} from "./onboarding.ts";

const COMPLETE: OnboardingIdea = {
  hypothesis: "A single sentence",
  problem: "the friction",
  monetization: "the value angle",
  domain: { tag: "ai-ml", lane: "picked" },
};

const SUMMARY: VaultSummary = {
  resolved_domains: 2,
  provisional_domains: 3,
  target: 3,
  floor: 2,
  eligible: true,
};

test("the prompt cycle advances one per idea and wraps after the third", () => {
  expect(ONBOARDING_PROMPTS).toHaveLength(3);
  expect(promptFor(0)).toBe("An idea from your work");
  expect(promptFor(1)).toBe("A frustration nobody has fixed");
  expect(promptFor(2)).toBe("An idea from a domain you've never touched");
  // The third prompt is the target's last domain, so the fourth cycle restarts rather than running out.
  expect(promptFor(3)).toBe(promptFor(0));
});

test("a pick writes the cluster key — never its label", () => {
  const choice = chooseCluster({ key: "ai-ml", name: "AI & ML" });
  expect(choice).toEqual({ tag: "ai-ml", lane: "picked" });
  // The label is display-only: `AI & ML` is not a clean slug and is never registered as a tag
  // (`store/seed/README.md` rule 2), so sending it would leave the idea's domain provisional forever.
  expect(choice.tag).not.toBe("AI & ML");
  expect(isProvisional(choice)).toBe(false);
});

test("the Other lane is typed, provisional, and normalised by S2's rule", () => {
  const choice = chooseFreeText("  #Machine Learning ");
  expect(choice).toEqual({ tag: "machine learning", lane: "typed" });
  expect(isProvisional(choice!)).toBe(true);
});

test("a blank Other entry adds nothing", () => {
  expect(chooseFreeText("")).toBeNull();
  expect(chooseFreeText("   ")).toBeNull();
  expect(chooseFreeText("#")).toBeNull();
});

test("validation is S2's, applied to S0's four mandatory fields", () => {
  expect(
    validateOnboardingIdea({ hypothesis: "", problem: "", monetization: "", domain: null }),
  ).toEqual({
    hypothesis: "Hypothesis is required",
    problem: "Problem is required",
    monetization: "Monetization is required",
    domain_tags: "Add at least one domain",
  });
  expect(validateOnboardingIdea(COMPLETE)).toEqual({});
  // Whitespace-only is a missing field, and the length is measured as typed — both S2's rules.
  expect(validateOnboardingIdea({ ...COMPLETE, hypothesis: "   " }).hypothesis).toBe(
    "Hypothesis is required",
  );
  expect(validateOnboardingIdea({ ...COMPLETE, hypothesis: "x".repeat(281) }).hypothesis).toBe(
    "Hypothesis exceeds 280 characters",
  );
});

test("a picked domain enters the capture as its one-element tag list, blank-seeded", () => {
  expect(toCaptureInput(COMPLETE)).toEqual({
    hypothesis: "A single sentence",
    problem: "the friction",
    monetization: "the value angle",
    domain_tags: ["ai-ml"],
    origin_spark_id: null,
    decision_id: null,
  });
  // No domain at all cannot survive validation, but the request it would produce is the empty list.
  expect(toCaptureInput({ ...COMPLETE, domain: null }).domain_tags).toEqual([]);
});

test("the readout is the summary's resolved count over the summary's target", () => {
  // `provisional_domains` is 3 and `resolved + provisional` is 5: neither may move the readout.
  expect(progress(SUMMARY)).toEqual({ covered: 2, target: 3 });
});

test("the readout's denominator is the payload's target, not a literal", () => {
  expect(progress({ ...SUMMARY, target: 4 })).toEqual({ covered: 2, target: 4 });
});

test("the readout is capped at the target — progress cannot overshoot a goal", () => {
  expect(progress({ ...SUMMARY, resolved_domains: 5 })).toEqual({ covered: 3, target: 3 });
});
