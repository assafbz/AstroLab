import { expect, test } from "vitest";

import type { InspireSeed } from "../api/types.ts";
import {
  HYPOTHESIS_MAX,
  addDomainTag,
  counterText,
  normalizeDomainTag,
  removeDomainTag,
  seedToDraft,
  validateCapture,
} from "./capture.ts";

const VALID = {
  hypothesis: "A single sentence",
  problem: "the friction",
  monetization: "the value angle",
  domain_tags: ["fintech"],
};

test("a complete draft has no errors", () => {
  expect(validateCapture(VALID)).toEqual({});
});

test("every mandatory field is required — and the error is keyed to its own field", () => {
  expect(validateCapture({ ...VALID, hypothesis: "" })).toEqual({
    hypothesis: "Hypothesis is required",
  });
  expect(validateCapture({ ...VALID, problem: "" })).toEqual({ problem: "Problem is required" });
  expect(validateCapture({ ...VALID, monetization: "" })).toEqual({
    monetization: "Monetization is required",
  });
  expect(validateCapture({ ...VALID, domain_tags: [] })).toEqual({
    domain_tags: "Add at least one domain",
  });
});

test("a whitespace-only mandatory field is empty, not present (Review Focus 3)", () => {
  expect(validateCapture({ ...VALID, hypothesis: "   " })).toEqual({
    hypothesis: "Hypothesis is required",
  });
  expect(validateCapture({ ...VALID, problem: "\n\t " })).toEqual({
    problem: "Problem is required",
  });
});

test("the hypothesis limit is 280 exactly — 281 is over (Review Focus 4)", () => {
  expect(HYPOTHESIS_MAX).toBe(280);
  expect(validateCapture({ ...VALID, hypothesis: "x".repeat(280) })).toEqual({});
  expect(validateCapture({ ...VALID, hypothesis: "x".repeat(281) })).toEqual({
    hypothesis: "Hypothesis exceeds 280 characters",
  });
});

test("a field that is both blank and over-long reports required, not over-long", () => {
  expect(validateCapture({ ...VALID, hypothesis: " ".repeat(400) })).toEqual({
    hypothesis: "Hypothesis is required",
  });
});

test("counterText is the mono `n / 280` the field shows", () => {
  expect(counterText(0)).toBe("0 / 280");
  expect(counterText(280)).toBe("280 / 280");
});

test("normalizeDomainTag trims, strips a leading #, and lowercases (Review Focus 5)", () => {
  expect(normalizeDomainTag(" #FinTech ")).toBe("fintech");
  expect(normalizeDomainTag("fin")).toBe("fin");
  expect(normalizeDomainTag("  ")).toBe("");
});

test("addDomainTag normalises before it compares, so #FinTech cannot duplicate fintech", () => {
  expect(addDomainTag(["fintech"], "#FinTech")).toEqual(["fintech"]);
  expect(addDomainTag([], "logistics")).toEqual(["logistics"]);
  expect(addDomainTag(["fin"], "logistics")).toEqual(["fin", "logistics"]);
});

test("addDomainTag ignores a blank or bare-# entry rather than storing an empty tag", () => {
  expect(addDomainTag([], "  ")).toEqual([]);
  expect(addDomainTag(["fin"], "#")).toEqual(["fin"]);
});

test("removeDomainTag drops exactly the named tag", () => {
  expect(removeDomainTag(["fin", "logistics"], "fin")).toEqual(["logistics"]);
  expect(removeDomainTag(["fin"], "absent")).toEqual(["fin"]);
});

/** §4.14 — the spark's seed payload (one field of it is `spark_id`, which the draft does not carry). */
const SEED: InspireSeed = {
  spark_id: "1a2b",
  direction: "Pair the transit lattice with audio",
  claim: "Scheduling and DSP share a shape.",
  what_it_takes: "Two weekends on the ingest path.",
  first_step: "Instrument the ingest path before the model runs.",
  domain_tags: ["transit", "audio-dsp"],
};

test("seedToDraft is §4.13's prefill: direction→hypothesis, claim→problem, monetization blank", () => {
  expect(seedToDraft(SEED)).toEqual({
    hypothesis: "Pair the transit lattice with audio",
    problem: "Scheduling and DSP share a shape.",
    // A spark carries no monetization, and one is not invented for it — the user supplies it (T16).
    monetization: "",
    domain_tags: ["transit", "audio-dsp"],
  });
});

test("seedToDraft takes the seed's union as given — the server deduped already, so no re-derivation", () => {
  // Not re-normalised, not re-deduped, not re-ordered: the two source ideas' union arrives folded and
  // in pair order (§3.3), and the client maps it, it does not recompute it.
  const seed: InspireSeed = { ...SEED, domain_tags: ["Transit", "audio-dsp", "zeta"] };
  expect(seedToDraft(seed).domain_tags).toEqual(["Transit", "audio-dsp", "zeta"]);
});

test("a seeded draft is valid exactly when the user has supplied the missing monetization (T16)", () => {
  // The prefill leaves one mandatory field empty by construction, so the seeded save is blocked until
  // the user fills it — the same §4.2 validation as a blank capture, no separate rule.
  expect(validateCapture(seedToDraft(SEED))).toEqual({
    monetization: "Monetization is required",
  });
  expect(validateCapture({ ...seedToDraft(SEED), monetization: "the value angle" })).toEqual({});
});
