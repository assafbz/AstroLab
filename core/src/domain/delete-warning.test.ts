import { expect, test } from "vitest";

import { deleteWarning } from "./delete-warning.js";

test("with no references the confirm is plain and has no details", () => {
  expect(deleteWarning({ forks: [], derived: [] })).toEqual({
    summary: "Delete this idea?",
    details: [],
  });
});

test("fork children are named, and the tolerance is stated — none of them is deleted (T26)", () => {
  const warning = deleteWarning({ forks: ["f1", "f2"], derived: [] });

  expect(warning.details).toHaveLength(1);
  expect(warning.details[0]).toContain("f1");
  expect(warning.details[0]).toContain("f2");
  expect(warning.details[0]).toContain("dangling parent reference");
});

test("a provenance-source reference is named too — the tombstone direction is stated, never dropped (Review Focus 1)", () => {
  const warning = deleteWarning({ forks: [], derived: ["d1"] });

  expect(warning.details).toHaveLength(1);
  expect(warning.details[0]).toContain("d1");
  expect(warning.details[0]).toContain("provenance");
});

test("both directions compose, forks first", () => {
  const warning = deleteWarning({ forks: ["f1"], derived: ["d1"] });

  expect(warning.details).toHaveLength(2);
  expect(warning.details[0]).toContain("f1");
  expect(warning.details[1]).toContain("d1");
});
