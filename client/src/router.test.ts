import { describe, expect, test } from "vitest";

import {
  SCREENS,
  captureHref,
  forkHref,
  forkParentIdFromPath,
  ideaHref,
  ideaIdFromPath,
  iterateHref,
  iterateIdFromPath,
  matchScreen,
  routeHref,
  seedSparkIdFromPath,
  sparkHref,
  sparkIdFromPath,
} from "./router.ts";

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

describe("sparkIdFromPath", () => {
  test("resolves the id in a per-id path", () => {
    expect(sparkIdFromPath("/sparks/abc")).toBe("abc");
  });

  test("a trailing slash resolves, so a pasted `#/sparks/abc/` is not a not-found", () => {
    expect(sparkIdFromPath("/sparks/abc/")).toBe("abc");
  });

  test("a bare `/sparks` is not a route — S1 is the home, at `/`", () => {
    // Not an alias for the deck: `#/sparks` is unclaimed by `SCREENS`, and a path that is not in the
    // route table stays a not-found rather than quietly meaning S1 after all.
    expect(sparkIdFromPath("/sparks")).toBeNull();
    expect(sparkIdFromPath("/sparks/")).toBeNull();
  });

  test("a further segment is not a route — the server answers a not-found envelope too (§2)", () => {
    expect(sparkIdFromPath("/sparks/a/b")).toBeNull();
  });

  test("any other path is not a per-id route", () => {
    expect(sparkIdFromPath("/vault")).toBeNull();
    expect(sparkIdFromPath("/")).toBeNull();
    expect(sparkIdFromPath("")).toBeNull();
  });
});

test("sparkHref is the hash form of a per-id path, and round-trips through sparkIdFromPath", () => {
  expect(sparkHref("x")).toBe("#/sparks/x");
  expect(sparkIdFromPath(sparkHref("x").slice(1))).toBe("x");
});

describe("seedSparkIdFromPath", () => {
  test("resolves the id in a per-id path", () => {
    expect(seedSparkIdFromPath("/capture/abc")).toBe("abc");
  });

  test("a trailing slash resolves, so a pasted `#/capture/abc/` is not a not-found", () => {
    expect(seedSparkIdFromPath("/capture/abc/")).toBe("abc");
  });

  test("the bare S2 path has no id — the Add tab opens a blank capture, not a seeded one", () => {
    // `#/capture` is `SCREENS`' own S2 entry (a blank capture); the seeded one is a per-id route.
    expect(seedSparkIdFromPath("/capture")).toBeNull();
    expect(seedSparkIdFromPath("/capture/")).toBeNull();
  });

  test("a further segment is not a route — the server answers a not-found envelope too (§2)", () => {
    expect(seedSparkIdFromPath("/capture/a/b")).toBeNull();
  });

  test("any other path is not a per-id route", () => {
    expect(seedSparkIdFromPath("/sparks/abc")).toBeNull();
    expect(seedSparkIdFromPath("/")).toBeNull();
    expect(seedSparkIdFromPath("")).toBeNull();
  });
});

test("captureHref is the hash form of a per-id path, and round-trips through seedSparkIdFromPath", () => {
  expect(captureHref("x")).toBe("#/capture/x");
  expect(seedSparkIdFromPath(captureHref("x").slice(1))).toBe("x");
});

describe("forkParentIdFromPath / iterateIdFromPath (V9 #20)", () => {
  test("each resolves the id in its own per-id path", () => {
    expect(forkParentIdFromPath("/fork/abc")).toBe("abc");
    expect(iterateIdFromPath("/iterate/abc")).toBe("abc");
  });

  test("a trailing slash resolves — a pasted `#/fork/abc/` is not a not-found", () => {
    expect(forkParentIdFromPath("/fork/abc/")).toBe("abc");
    expect(iterateIdFromPath("/iterate/abc/")).toBe("abc");
  });

  test("the bare paths carry no id — S5 picks a parent, S6 asks which node", () => {
    expect(forkParentIdFromPath("/fork")).toBeNull();
    expect(forkParentIdFromPath("/fork/")).toBeNull();
    expect(iterateIdFromPath("/iterate")).toBeNull();
    expect(iterateIdFromPath("/iterate/")).toBeNull();
  });

  test("a further segment is not a route — the server answers a not-found envelope too (§2)", () => {
    expect(forkParentIdFromPath("/fork/a/b")).toBeNull();
    expect(iterateIdFromPath("/iterate/a/b")).toBeNull();
  });

  test("neither resolver claims the other's path", () => {
    expect(forkParentIdFromPath("/iterate/abc")).toBeNull();
    expect(iterateIdFromPath("/fork/abc")).toBeNull();
    expect(forkParentIdFromPath("/")).toBeNull();
    expect(iterateIdFromPath("")).toBeNull();
  });
});

test("forkHref / iterateHref are the hash forms, and round-trip through their resolvers", () => {
  expect(forkHref("x")).toBe("#/fork/x");
  expect(forkParentIdFromPath(forkHref("x").slice(1))).toBe("x");
  expect(iterateHref("x")).toBe("#/iterate/x");
  expect(iterateIdFromPath(iterateHref("x").slice(1))).toBe("x");
});
