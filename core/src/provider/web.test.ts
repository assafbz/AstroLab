import { expect, test } from "vitest";

import { NATIVE_ONLY_CAUSE, webReachFor } from "./web.js";

/**
 * The web target's reach table (`provider/web.ts`; L3 · #166, T3). The claim the app leans on: for any
 * provider it is asked about, it gets either the headers a browser must send or a **reason** it cannot
 * be called from a browser — never silence, which is how a CORS block becomes "no connection".
 */

test("the wired provider needs nothing special from a browser", () => {
  expect(webReachFor("openrouter")).toEqual({ headers: {} });
});

test("a provider that needs a browser opt-in carries the header, and the known ones are named", () => {
  // The name is the point: it tells the provider you accept that a browser-held key is exposed.
  expect(webReachFor("anthropic")).toEqual({
    headers: { "anthropic-dangerous-direct-browser-access": "true" },
  });
  expect(webReachFor("openai")).toEqual({ headers: {} });
  // Tolerant of how a setting is typed in, and still the same verdict.
  expect(webReachFor("  Anthropic ")).toEqual(webReachFor("anthropic"));
});

test("an unknown provider is native-only, with the reason a surface can print", () => {
  const reach = webReachFor("some-new-provider");
  expect("nativeOnly" in reach).toBe(true);
  expect("nativeOnly" in reach && reach.nativeOnly).toMatch(/no browser path is known/);
  expect("nativeOnly" in reach && reach.nativeOnly).toContain("some-new-provider");
  // …and the arm it maps to is the vocabulary's, not a new word invented here.
  expect(NATIVE_ONLY_CAUSE).toBe("cors-blocked");
});
