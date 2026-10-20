import { expect, test } from "vitest";

import { FAILURE_TAG, failureTag, parseRunFailure, RUN_FAILURE_CAUSES } from "./failure.js";

/**
 * The run-failure vocabulary round-trips (`core/src/failure.ts`; L3 · #166, T4).
 *
 * The tag is written into `spark_run.error` by the engine and read back by the vault, in different
 * modules and different lanes — so the property that matters is that the two halves cannot drift: every
 * cause the writer can emit is a cause the reader recognises, and nothing else is.
 */

test("the writer and the reader agree on every cause, by construction", () => {
  // The anti-drift check: one loop over the vocabulary, both directions. A cause added to the type but
  // forgotten in `RUN_FAILURE_CAUSES` (or spelled differently in either half) fails here.
  for (const cause of RUN_FAILURE_CAUSES) {
    expect(failureTag(cause), cause).toBe(`${FAILURE_TAG}${cause}`);
    expect(parseRunFailure(`${failureTag(cause)}: something went wrong`), cause).toBe(cause);
    expect(parseRunFailure(failureTag(cause)), cause).toBe(cause);
  }
  expect(new Set(RUN_FAILURE_CAUSES).size).toBe(RUN_FAILURE_CAUSES.length);
});

test("a row with no tag parses as no cause — 'we do not know' is a distinct answer", () => {
  expect(parseRunFailure(null)).toBeNull();
  expect(parseRunFailure("")).toBeNull();
  expect(parseRunFailure("boom")).toBeNull();
  expect(parseRunFailure("OPENROUTER_API_KEY is not set")).toBeNull();
  // A discarded run's informational note rides the same column (`queue.ts`) and is not a failure.
  expect(parseRunFailure("discarded: superseded by revision 2")).toBeNull();
  // A tag nobody defined is unknown, not "unavailable": the reader never guesses.
  expect(parseRunFailure("failure:gremlins: the gremlins got in")).toBeNull();
});

test("the tag is a prefix on the row's text, so the human message survives it", () => {
  const tagged = `${failureTag("no-key")}: no API key is set`;
  expect(tagged.startsWith("failure:no-key")).toBe(true);
  expect(tagged).toContain("no API key is set");
});
