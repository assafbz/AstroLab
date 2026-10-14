import { describe, expect, test } from "vitest";

import { ADJUDICATION_SYSTEM, EXTRACTION_SYSTEM, TAG_NORMALISATION_SYSTEM } from "./prompts.js";
import { ADJUDICATION_SCHEMA, DESCRIPTOR_SCHEMA, TAG_SCHEMA, type JsonSchema } from "./schema.js";

/**
 * The prompt *names* the fields the model must fill; the schema *enforces* them. The two can drift
 * silently: add a `required` field and the model is never told about it, so every call comes back
 * invalid and the run fails — a configuration bug that reads like a provider outage.
 *
 * David's review of #78 flagged the gap. This closes the harmful direction — a required field the prompt
 * never mentions. The reverse (prose naming a field the schema dropped) is harmless, and too fuzzy to
 * assert: the prompts are sentences, not lists.
 */
describe("the prompt and the schema cannot drift", () => {
  test("every field the schema requires is named in the system prompt", () => {
    // Every (schema, prompt) pair on the adapter. A third operation (W4's tag normalisation) joins them:
    // this list must grow with the adapter, or the new pair drifts unguarded (Max's #85 review).
    const pairs: Array<[JsonSchema, string, string]> = [
      [DESCRIPTOR_SCHEMA, EXTRACTION_SYSTEM, "extraction"],
      [ADJUDICATION_SCHEMA, ADJUDICATION_SYSTEM, "adjudication"],
      [TAG_SCHEMA, TAG_NORMALISATION_SYSTEM, "tag normalisation"],
    ];

    const missing = pairs.flatMap(([schema, system, name]) =>
      schema.required
        .filter((field) => !system.includes(field))
        .map((field) => `${name}: ${field}`),
    );

    expect(missing).toEqual([]);
  });

  test("the check is not vacuous — there are required fields to name", () => {
    expect(DESCRIPTOR_SCHEMA.required.length).toBeGreaterThan(0);
    expect(ADJUDICATION_SCHEMA.required.length).toBeGreaterThan(0);
    expect(TAG_SCHEMA.required.length).toBeGreaterThan(0);
  });
});
