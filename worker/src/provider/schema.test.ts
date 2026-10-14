import { describe, expect, test } from "vitest";

import {
  ADJUDICATION_SCHEMA,
  DESCRIPTOR_SCHEMA,
  parseAdjudication,
  parseDescriptor,
} from "./schema.js";
import { InvalidOutputError } from "./types.js";

const descriptor = {
  verb: "batch",
  object_class: "perishable goods",
  constraint: "fixed shelf life",
  transferable_structure: "queue by expiry",
};

const draft = {
  shared_mechanism: "expiry-ordered scheduling",
  direction: "Expiry-ranked work queues for engineering tickets",
  claim: "Both domains order work by a hard deadline nobody controls",
  what_it_takes: "A deadline field and a scheduler that reads it",
  first_step: "Add a due-by column to the ticket schema",
};

describe("parseDescriptor — ARCHITECTURE.md §3.3 step 1", () => {
  test("accepts the four fields", () => {
    expect(parseDescriptor(descriptor)).toEqual(descriptor);
  });

  test("ignores extra keys rather than failing on them", () => {
    // `additionalProperties: false` asks the model not to send them; an extra field is harmless to
    // storage (we read the four we know), where a missing or blank one would corrupt a descriptor.
    expect(parseDescriptor({ ...descriptor, confidence: 0.9 })).toEqual(descriptor);
  });

  test("throws InvalidOutputError when a field is missing", () => {
    const { constraint, ...missing } = descriptor;

    expect(() => parseDescriptor(missing)).toThrow(InvalidOutputError);
    expect(constraint).toBeTruthy(); // the field really was removed
  });

  test("throws when a field is blank", () => {
    expect(() => parseDescriptor({ ...descriptor, verb: "   " })).toThrow(InvalidOutputError);
  });

  test("throws when a field is not a string", () => {
    expect(() => parseDescriptor({ ...descriptor, verb: 7 })).toThrow(InvalidOutputError);
  });

  test("throws when the value is not an object", () => {
    expect(() => parseDescriptor("verb: batch")).toThrow(InvalidOutputError);
    expect(() => parseDescriptor(null)).toThrow(InvalidOutputError);
  });
});

describe("parseAdjudication — ARCHITECTURE.md §3.3 step 3", () => {
  test("returns the draft when every field is non-empty", () => {
    expect(parseAdjudication(draft)).toEqual({
      mechanism: draft.shared_mechanism,
      direction: draft.direction,
      claim: draft.claim,
      what_it_takes: draft.what_it_takes,
      first_step: draft.first_step,
    });
  });

  test("returns null for a declared rejection — a real answer, not an error", () => {
    const rejected = Object.fromEntries(Object.keys(draft).map((key) => [key, null]));

    expect(parseAdjudication(rejected)).toBeNull();
  });

  test("throws when the rejection is partial", () => {
    // A half-null response is neither a spark nor a refusal; treating it as either would be a guess.
    expect(() => parseAdjudication({ ...draft, first_step: null })).toThrow(InvalidOutputError);
  });

  test("throws when a field is missing outright — a dropped field is not a refusal", () => {
    // Conflating "missing" with "null" would turn a model that dropped a field into a silent
    // "no spark here", i.e. suppressed noise, instead of a failed call.
    expect(() => parseAdjudication({})).toThrow(InvalidOutputError);
  });

  test("throws when a field is blank", () => {
    expect(() => parseAdjudication({ ...draft, claim: "" })).toThrow(InvalidOutputError);
  });

  test("throws when a field has the wrong type", () => {
    expect(() => parseAdjudication({ ...draft, direction: ["nope"] })).toThrow(InvalidOutputError);
  });

  test("throws when the value is not an object", () => {
    expect(() => parseAdjudication(undefined)).toThrow(InvalidOutputError);
  });
});

describe("the schemas the model is asked to fill", () => {
  test("both are strict objects requiring exactly their fields", () => {
    for (const [schema, fields] of [
      [DESCRIPTOR_SCHEMA, ["verb", "object_class", "constraint", "transferable_structure"]],
      [
        ADJUDICATION_SCHEMA,
        ["shared_mechanism", "direction", "claim", "what_it_takes", "first_step"],
      ],
    ] as const) {
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect([...schema.required].sort()).toEqual([...fields].sort());
      expect(Object.keys(schema.properties).sort()).toEqual([...fields].sort());
    }
  });
});
