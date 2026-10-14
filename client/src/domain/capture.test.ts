import { expect, test } from "vitest";

import {
  HYPOTHESIS_MAX,
  addDomainTag,
  counterText,
  normalizeDomainTag,
  removeDomainTag,
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
