import { expect, test } from "vitest";

import type { Idea } from "../types.js";
import { completionPrompt, draftFromIdea, missingFields, needsCompletion } from "./completion.js";

/**
 * The completion rule (K8 `#42`) — the client mirror of the server's `derivedStatus`
 * (`api/src/decision.ts:205`). These assert the **rule**, not a screen: which fields an idea still
 * owes, and the sentence that says so.
 */

function idea(patch: Partial<Idea> = {}): Idea {
  return {
    id: "9f1c",
    hypothesis: "A single sentence",
    problem: "the friction",
    monetization: "the value angle",
    domain_tags: ["fintech"],
    lineage_kind: "ROOT",
    lineage_parent_id: null,
    status: "ACTIVE",
    visibility: "PRIVATE",
    current_version: 1,
    created_at: "2026-10-13T05:14:05Z",
    updated_at: "2026-10-13T05:14:05Z",
    ...patch,
  };
}

test("a spark-derived idea owes exactly `monetization` — a spark carries none (§4.13)", () => {
  // The shape ACCEPT actually mints: direction→hypothesis, claim→problem, the tags carried, and no
  // monetization. `derivedStatus` reads the same four fields.
  const derived = idea({ monetization: "", status: "NEEDS_COMPLETION" });
  expect(missingFields(derived)).toEqual(["monetization"]);
  expect(completionPrompt(derived)).toBe(
    "Add the monetization / value angle to put it back in play.",
  );
});

test("a wholly empty idea owes all four, in the contract's order", () => {
  const blank = idea({
    hypothesis: "",
    problem: "",
    monetization: "",
    domain_tags: [],
    status: "NEEDS_COMPLETION",
  });
  expect(missingFields(blank)).toEqual(["hypothesis", "problem", "monetization", "domain_tags"]);
  expect(completionPrompt(blank)).toBe(
    "Add the core hypothesis, the problem solved, the monetization / value angle and a domain " +
      "to put it back in play.",
  );
});

test("emptiness is judged on the trimmed value, as the server does (§4.2's `requiredText`)", () => {
  const padded = idea({ monetization: "   ", status: "NEEDS_COMPLETION" });
  expect(missingFields(padded)).toEqual(["monetization"]);
});

test("a complete idea owes nothing — the prompt is `null`, never an empty sentence", () => {
  const complete = idea();
  expect(missingFields(complete)).toEqual([]);
  expect(completionPrompt(complete)).toBeNull();
});

test("`needsCompletion` keeps the read's order — the client does not re-sort (§4.4)", () => {
  const owed = idea({ id: "a", status: "NEEDS_COMPLETION" });
  const active = idea({ id: "b" });
  const owed2 = idea({ id: "c", status: "NEEDS_COMPLETION" });
  expect(needsCompletion([owed, active, owed2]).map((i) => i.id)).toEqual(["a", "c"]);
  expect(needsCompletion([active])).toEqual([]);
});

test("`draftFromIdea` carries the idea's own four fields — the completion edit starts from them", () => {
  const derived = idea({ monetization: "", status: "NEEDS_COMPLETION" });
  expect(draftFromIdea(derived)).toEqual({
    hypothesis: "A single sentence",
    problem: "the friction",
    monetization: "",
    domain_tags: ["fintech"],
  });
});
