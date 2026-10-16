import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { SWIPE_DISTANCE_PX, TAP_SLOP_PX, isTap, swipeKind } from "./deck-interaction.ts";

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
const SPARKS_PATH = fileURLToPath(new URL("../screens/Sparks.tsx", import.meta.url));
const SPARKS_SOURCE = readFileSync(SPARKS_PATH, "utf8");

/** The `../api/<file>` specifiers a screen's source imports — the shape every allow-list below reads. */
function apiImports(source: string): string[] {
  return [...source.matchAll(/^import\s+(?:type\s+)?[^;]*from\s+"\.\.\/api\/([^"]+)";/gm)].map(
    (match) => match[1]!,
  );
}

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

test("a tap is a press that stayed put on **both** axes — T08's opening gesture", () => {
  expect(isTap(10, 10, 10, 10)).toBe(true);
  expect(isTap(10, 10, 10 + TAP_SLOP_PX - 1, 10 + TAP_SLOP_PX - 1)).toBe(true);
  // The one that would bite: a scroll is long on `y` and short on `x`, and the deck *and the list*
  // scroll — a tap judged on `x` alone would open a detail on every scroll release.
  expect(isTap(10, 10, 10, 10 + TAP_SLOP_PX)).toBe(false);
  expect(isTap(10, 10, 10 + TAP_SLOP_PX, 10)).toBe(false);
});

test("the tap slop is exclusive: exactly the slop has travelled, so it is not a tap", () => {
  // Pinned, like the swipe threshold, so a later tweak cannot quietly move the boundary.
  expect(isTap(0, 0, TAP_SLOP_PX, 0)).toBe(false);
  expect(isTap(0, 0, TAP_SLOP_PX - 1, 0)).toBe(true);
});

test("the card resolves through exactly one call site — a second, inline dispatch reddens this", () => {
  // The seam is *wired* — otherwise "exactly one" would be satisfied by zero and this guard vacuous.
  expect(CARD_SOURCE).toMatch(/onResolve\s*:/);

  const sites = CARD_SOURCE.match(/onResolve\s*\(/g) ?? [];
  // Plant: give the swipe handler its own `onResolve(...)` beside the shared `dispatch` → 2 → red.
  expect(sites).toHaveLength(1);
});

test("#129 — the card opens through exactly one call site — a second, inline `onOpen` reddens this", () => {
  // Wired — the guard must not be satisfiable by zero. T08's open leaves the card two ways (the
  // pointer tap and the heading button), but through the one `open()` helper.
  expect(CARD_SOURCE).toMatch(/onOpen\s*\?:/);

  const sites = CARD_SOURCE.match(/onOpen\?\.\(/g) ?? [];
  // Plant: give the heading button its own inline `onOpen?.(spark.id)` beside `open()` → 2 → red.
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

test("S1b's api imports are an allow-list — the read, the shapes, the error type, the transport (K7)", () => {
  // The detail legitimately reads §4.12 and, as of K7 `#41`, posts §4.13 through the transport the
  // previous list named as the one that would redden it. So the list gains `decisions.ts` rather than
  // being deleted; anything beyond these four is a screen reaching an API of its own.
  // Residual: name-based — it reads the *specifier*, not whether the module does what its name says.
  expect(apiImports(DETAIL_SOURCE).sort()).toEqual([
    "client.ts",
    "decisions.ts",
    "sparks.ts",
    "types.ts",
  ]);
});

test("the deck and S1b resolve through one module — two screens, one shape (§5.5, K7)", () => {
  // Each screen wires its **own** resolver (so §4.10's re-read stays in the screen that owns the deck),
  // and the seam is `void` — so the two must come from the same module or the commands could drift into
  // two payloads, the divergence §5.5's parity forbids.
  const seamImport = /^import\s+[^;]*from\s+"\.\.\/domain\/decision\.ts";$/m;
  expect(SPARKS_SOURCE).toMatch(seamImport);
  expect(DETAIL_SOURCE).toMatch(seamImport);
  // Residual: name-based. It proves both screens import that module; that each *calls* its `resolve`
  // through one call site is what the two `resolve(` counts above (and the screen tests) hold.
});

test("a vault screen reaches no engine or run module — its request never waits on a run (K7 #41)", () => {
  // The criterion's *"no vault request waits on a run"*. It is a property of the **files**, so it is
  // checked here rather than asserted in prose: none of S2/S3/S4 — nor the S5/S6 screens V9 `#20` adds,
  // which write §4.7/§4.6 — may import the engine surface (`api/sparks.ts`: §4.9/§4.10/§4.11/§4.16) or
  // the run policy (`domain/run-trigger.ts`, `domain/deck-stream.ts`). Vault writes are vault writes and
  // must succeed with the AI down (NFR-A1).
  const vaultScreens = [
    "Capture.tsx",
    "Vault.tsx",
    "IdeaDetail.tsx",
    "Iterate.tsx",
    "Fork.tsx",
  ].map((name) => ({
    name,
    source: readFileSync(fileURLToPath(new URL(`../screens/${name}`, import.meta.url)), "utf8"),
  }));
  // Non-vacuity: it must actually be looking at the five files — a walk that read nothing, or that
  // silently skipped the screen this lane added, would pass this guard for the wrong reason.
  expect(vaultScreens.map((screen) => screen.name)).toEqual([
    "Capture.tsx",
    "Vault.tsx",
    "IdeaDetail.tsx",
    "Iterate.tsx",
    "Fork.tsx",
  ]);

  for (const screen of vaultScreens) {
    expect(screen.source).toMatch(/^import\s/m);
    expect(apiImports(screen.source)).not.toContain("sparks.ts");
    expect(screen.source).not.toMatch(/from\s+"\.\.\/domain\/(run-trigger|deck-stream)\.ts";/m);
  }
});
