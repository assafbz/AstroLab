import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { SWIPE_DISTANCE_PX, swipeKind } from "./deck-interaction.ts";

/**
 * §5.5's parity, at the two places it can break: the **gesture's mapping** (right = ACCEPT, left =
 * DISMISS, a short drag = nothing) and the **card's call sites** — the structural half, which says the
 * card has exactly one way to resolve and no reachable resolution API of its own.
 *
 * The *behavioural* half of parity — that a swipe right and a `Good` press hand the seam **identical
 * arguments** — needs a rendered card and lives in `SparkCard.test.tsx`. Between the two, a divergence
 * cannot pass: the behavioural test reddens if the payloads differ, and the structural one reddens if a
 * second dispatch exists at all.
 */

const CARD_PATH = fileURLToPath(new URL("../components/SparkCard.tsx", import.meta.url));
const CARD_SOURCE = readFileSync(CARD_PATH, "utf8");
const DETAIL_PATH = fileURLToPath(new URL("../screens/SparkDetail.tsx", import.meta.url));
const DETAIL_SOURCE = readFileSync(DETAIL_PATH, "utf8");

test("the gesture's axis: right is ACCEPT, left is DISMISS (§2.2)", () => {
  expect(swipeKind(0, 200)).toBe("ACCEPT");
  expect(swipeKind(200, 0)).toBe("DISMISS");
});

test("a drag under the threshold resolves nothing — `null` is “no gesture”, not a kind", () => {
  expect(swipeKind(100, 100 + SWIPE_DISTANCE_PX - 1)).toBeNull();
  expect(swipeKind(100, 100 - (SWIPE_DISTANCE_PX - 1))).toBeNull();
});

test("the threshold is inclusive: exactly the distance is a swipe", () => {
  // The boundary is stated once so a later tweak cannot quietly move it to an exclusive read.
  expect(swipeKind(0, SWIPE_DISTANCE_PX)).toBe("ACCEPT");
  expect(swipeKind(0, -SWIPE_DISTANCE_PX)).toBe("DISMISS");
});

test("the card resolves through exactly one call site — a second, inline dispatch reddens this", () => {
  // The seam is *wired* — otherwise "exactly one" would be satisfied by zero and this guard vacuous.
  expect(CARD_SOURCE).toMatch(/onResolve\s*:/);

  const sites = CARD_SOURCE.match(/onResolve\s*\(/g) ?? [];
  // Plant: give the swipe handler its own `onResolve(...)` beside the shared `dispatch` → 2 → red.
  expect(sites).toHaveLength(1);
});

test("the card reaches no resolution API — the call is K4's, the card only holds the seam", () => {
  // "The adapter has no DB access" was asserted in prose once and never checked; this is the checked
  // form for this card. Only a *value* import can post anything, so a `type`-only `../api/` import is
  // fine and any other is not.
  const apiImports = [
    ...CARD_SOURCE.matchAll(/^import\s+(type\s+)?[^;]*from\s+"\.\.\/api\/[^"]+";/gm),
  ];
  for (const match of apiImports) {
    expect(match[1]).toBe("type ");
  }
});

test("S1b resolves through exactly one call site too — the same shape K7 plugs into per screen", () => {
  // The seam is *wired* here as well: "exactly one" must not be satisfiable by zero.
  expect(DETAIL_SOURCE).toMatch(/onResolve\s*\??\s*:/);

  const sites = DETAIL_SOURCE.match(/(?<![.\w])resolve\s*\(/g) ?? [];
  // Plant: give one button its own `resolve(...)` beside the shared `dispatch` → 2 → red.
  expect(sites).toHaveLength(1);
});

test("S1b reaches no decision API — the call module is K7 #41's, the screen holds the seam", () => {
  // The detail legitimately reads §4.12, so unlike the card it does import a §api/ value. The guard is
  // therefore the allow-list: the read, the error type, and the shapes. A `decisions.ts` (K7's module)
  // arriving here reddens this.
  const apiImports = [
    ...DETAIL_SOURCE.matchAll(/^import\s+(?:type\s+)?[^;]*from\s+"\.\.\/api\/([^"]+)";/gm),
  ];
  expect(apiImports.map((match) => match[1]).sort()).toEqual([
    "client.ts",
    "sparks.ts",
    "types.ts",
  ]);
});
