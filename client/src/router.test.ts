import { describe, expect, test } from "vitest";

import { SCREENS, ideaHref, ideaIdFromPath, matchScreen, routeHref } from "./router.ts";

const HOME = SCREENS.find((s) => s.id === "S1")!;

test("S0–S6 are present, in order, with distinct paths", () => {
  expect(SCREENS.map((s) => s.id)).toEqual(["S0", "S1", "S2", "S3", "S4", "S5", "S6"]);
  expect(new Set(SCREENS.map((s) => s.path)).size).toBe(SCREENS.length);
});

describe("matchScreen", () => {
  test.each(SCREENS)("resolves $id at $path", (expected) => {
    expect(matchScreen(expected.path)).toBe(expected);
  });

  test("the bare hash is the home — S1 (Sparks), per DESIGN.md §5", () => {
    expect(matchScreen("")).toBe(HOME);
  });

  test("`/` is the home — S1 (Sparks), not S0 (onboarding)", () => {
    expect(matchScreen("/")).toBe(HOME);
  });

  test("a trailing slash resolves, so a pasted URL is not a not-found", () => {
    expect(matchScreen("/vault/")).toBe(SCREENS.find((s) => s.id === "S3"));
  });

  test("an unknown path is a not-found, not the home", () => {
    expect(matchScreen("/nope")).toBeUndefined();
  });
});

test("routeHref is the hash form of the path", () => {
  expect(SCREENS.map(routeHref)).toEqual([
    "#/onboarding",
    "#/",
    "#/capture",
    "#/vault",
    "#/ideas",
    "#/fork",
    "#/iterate",
  ]);
});

describe("ideaIdFromPath", () => {
  test("resolves the id in a per-id path", () => {
    expect(ideaIdFromPath("/ideas/abc")).toBe("abc");
  });

  test("a trailing slash resolves, so a pasted `#/ideas/abc/` is not a not-found", () => {
    expect(ideaIdFromPath("/ideas/abc/")).toBe("abc");
  });

  test("the bare S4 path has no id — it is the S4 landing, not a detail", () => {
    expect(ideaIdFromPath("/ideas")).toBeNull();
    expect(ideaIdFromPath("/ideas/")).toBeNull();
  });

  test("a further segment is not a route — the server calls `/ideas/a/b` not_found too (docs/API.md §6)", () => {
    expect(ideaIdFromPath("/ideas/a/b")).toBeNull();
  });

  test("any other path is not a per-id route", () => {
    expect(ideaIdFromPath("/vault")).toBeNull();
    expect(ideaIdFromPath("")).toBeNull();
  });
});

test("ideaHref is the hash form of a per-id path, and round-trips through ideaIdFromPath", () => {
  expect(ideaHref("x")).toBe("#/ideas/x");
  expect(ideaIdFromPath(ideaHref("x").slice(1))).toBe("x");
});
