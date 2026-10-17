import { expect, test } from "vitest";

import type { Idea } from "../types.js";
import { danglingParentId } from "./lineage.js";

/** §3.1, with the fields a test overrides. */
function idea(patch: Record<string, unknown> = {}): Idea {
  return {
    id: "child",
    hypothesis: "A fork of the root",
    problem: "the friction",
    monetization: "the value angle",
    domain_tags: ["fintech"],
    lineage_kind: "FORK",
    lineage_parent_id: "root",
    status: "ACTIVE",
    visibility: "PRIVATE",
    current_version: 1,
    created_at: "2026-10-13T05:14:05Z",
    updated_at: "2026-10-13T05:14:05Z",
    ...patch,
  } as Idea;
}

test("a root has nothing dangling — `lineage_parent_id` is null, not a missing parent", () => {
  expect(danglingParentId(idea({ lineage_kind: "ROOT", lineage_parent_id: null }), [])).toBeNull();
});

test("a fork whose parent is in the chain is whole — no tombstone", () => {
  const parent = idea({ id: "root", lineage_kind: "ROOT", lineage_parent_id: null });
  expect(danglingParentId(idea(), [parent])).toBeNull();
});

test("a longer chain that carries the immediate parent is whole too", () => {
  const root = idea({ id: "root", lineage_kind: "ROOT", lineage_parent_id: null });
  const parent = idea({ id: "mid", lineage_parent_id: "root" });
  expect(danglingParentId(idea({ lineage_parent_id: "mid" }), [root, parent])).toBeNull();
});

test("a deleted parent leaves the id dangling — the tombstone, not a one-node chain", () => {
  // §4.8 — the child keeps `lineage_parent_id`; the read's walk stops, so `lineage` is `[]` (§4.5).
  // Rendering that as-is would say "this idea was always a root", which is a different claim.
  expect(danglingParentId(idea(), [])).toBe("root");
});

test("the tombstone names the parent even when a *grandparent* survived", () => {
  const grandparent = idea({ id: "nana", lineage_kind: "ROOT", lineage_parent_id: null });
  expect(danglingParentId(idea({ lineage_parent_id: "mid" }), [grandparent])).toBe("mid");
});
