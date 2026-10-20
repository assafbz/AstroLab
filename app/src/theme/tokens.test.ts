import { expect, test } from "vitest";

import { tokens } from "./tokens";

/**
 * The token table is a **contract**, so it is pinned here rather than trusted (`DESIGN.md` §2).
 *
 * Two things this test exists to catch, and each has its own assertion:
 *
 * 1. **A drifted value.** The expected map below is written out from `DESIGN.md` §2 verbatim; a token
 *    edited in `tokens.ts` to a near-miss hex fails here.
 * 2. **A drifted *set*.** `expect(tokens).toMatchObject(expected)` alone would pass if a name were
 *    *deleted*, and would pass if a name were *added*. So the key sets are compared as an equality:
 *    every §2 token must exist, and nothing that is not a §2 token may sit in the map. That is the
 *    same non-vacuity shape the repo's guards use — a check that quietly scans less is the failure.
 *
 * **A deviation is a task, not a typo.** If an RN platform cannot honour a value as written, the
 * exception is added here as a named case (e.g. *"RN: no `letterSpacing` on Android"*), not applied
 * silently in `tokens.ts`.
 */

/** `DESIGN.md` §2, one entry per row of the palette table (plus the *Geometry* values below it). */
const DESIGN_SECTION_2 = {
  canvas: "#080A12",
  card: "#10131F",
  raised: "#1E2336",
  hairline: "#2A3049",
  ink: "#EAEDF7",
  muted: "#A9B0C8",
  dim: "#7C87A3",
  faint: "#5C6684",
  primary: "#D69A4E",
  brassHighlight: "#F1CB8C",
  brassDeep: "#7E5218",
  indigo: "#4A55A0",
  outline: "#39405E",
  nav: "#0A0C15",
  destructive: "#E5484D",
  // "Label on brass: #0A0C15" — the one label value §2 fixes for the brass fill.
  onPrimary: "#0A0C15",
} as const;

/** §2 *Geometry*: 8px corners; §5: 44px minimum tap target. */
const DESIGN_GEOMETRY = { radius: 8, targetMin: 44 } as const;

test("every DESIGN.md §2 token carries its table value", () => {
  expect(tokens).toMatchObject(DESIGN_SECTION_2);
  expect(tokens).toMatchObject(DESIGN_GEOMETRY);
});

test("the token set is exactly §2 — nothing missing, nothing extra", () => {
  const expected = [...Object.keys(DESIGN_SECTION_2), ...Object.keys(DESIGN_GEOMETRY)].sort();
  expect(Object.keys(tokens).sort()).toEqual(expected);
});

test("the geometry values are the system numbers, not look-alikes", () => {
  expect(tokens.radius).toBe(8);
  expect(tokens.targetMin).toBe(44);
});
