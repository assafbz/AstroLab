import { expect, test } from "vitest";

import type { VaultSummary } from "../types.js";
import { spreadGate } from "./spread-gate.js";

const SUMMARY: VaultSummary = {
  resolved_domains: 2,
  provisional_domains: 3,
  target: 3,
  floor: 2,
  eligible: true,
};

/**
 * The discriminating pair: the gate must follow the **server's** `eligible`, not a local re-derivation
 * of it. If `spreadGate` recomputed `resolved_domains >= floor`, both of these flip — so a green run
 * here is the R1 identity, not a coincidence of agreement.
 */
test("the gate is the server's eligible — it does not re-derive it from the count", () => {
  expect(spreadGate({ ...SUMMARY, eligible: true, resolved_domains: 0 })).toBe(true);
  expect(spreadGate({ ...SUMMARY, eligible: false, resolved_domains: 3 })).toBe(false);
});

/** With the server's own arithmetic, both directions still hold — the floor, not the target. */
test("the floor is the server's: below it closed, at it open, and the target never gates", () => {
  expect(spreadGate({ ...SUMMARY, eligible: false, resolved_domains: 1 })).toBe(false);
  expect(spreadGate({ ...SUMMARY, eligible: true, resolved_domains: 2 })).toBe(true);
  expect(spreadGate({ ...SUMMARY, eligible: true, resolved_domains: 5, target: 3 })).toBe(true);
});

/** A typed (provisional) lane never clears the floor on its own; `≥ 3` is progress, never a gate. */
test("provisional domains and the target never move the gate", () => {
  const closed = { ...SUMMARY, eligible: false, resolved_domains: 1, provisional_domains: 9 };
  expect(spreadGate(closed)).toBe(false);
  // Raising the target (the `x / 3` goal) must not close a vault the server calls eligible.
  expect(spreadGate({ ...SUMMARY, eligible: true, target: 12 })).toBe(true);
});
