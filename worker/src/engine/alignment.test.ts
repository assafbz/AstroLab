import { describe, expect, test } from "vitest";

import type { MechanismDescriptor } from "../provider/index.js";
import { descriptorSimilarity } from "./alignment.js";

/**
 * The pure descriptor similarity (W5 D1; `ARCHITECTURE.md` §3.3 step 2). No db, no provider — the four
 * properties W9's calibration will rest on (symmetric, bounded, deterministic, field-orthogonal) and
 * the two empty-field branches, which are unreachable by construction and asserted anyway so a future
 * loosening of `parseDescriptor` fails *closed* (see `alignment.ts`).
 */

function descriptor(over: Partial<MechanismDescriptor> = {}): MechanismDescriptor {
  return {
    verb: "route",
    object_class: "traffic",
    constraint: "peak load",
    transferable_structure: "overflow rerouted into a parallel channel",
    ...over,
  };
}

describe("descriptorSimilarity — W5 D1", () => {
  test("identical descriptors score 1", () => {
    expect(descriptorSimilarity(descriptor(), descriptor())).toBe(1);
  });

  test("descriptors sharing no token in any field score 0", () => {
    const far = descriptor({
      verb: "photosynthesise",
      object_class: "sunlight",
      constraint: "winter darkness",
      transferable_structure: "stored energy released across seasons",
    });
    expect(descriptorSimilarity(descriptor(), far)).toBe(0);
  });

  test("is symmetric", () => {
    const a = descriptor();
    const b = descriptor({ verb: "route", object_class: "packets", constraint: "congestion" });
    expect(descriptorSimilarity(a, b)).toBe(descriptorSimilarity(b, a));
  });

  test("is bounded to [0,1]", () => {
    const others = [
      descriptor(),
      descriptor({ verb: "route" }),
      descriptor({ object_class: "packets" }),
      descriptor({ verb: "photosynthesise", object_class: "sunlight" }),
    ];
    for (const other of others) {
      const score = descriptorSimilarity(descriptor(), other);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  test("is case-, punctuation- and whitespace-insensitive", () => {
    expect(descriptorSimilarity(descriptor({ verb: "Route" }), descriptor({ verb: "route" }))).toBe(
      1,
    );
    expect(
      descriptorSimilarity(
        descriptor({ constraint: "peak-load  spikes" }),
        descriptor({ constraint: "peak load spikes" }),
      ),
    ).toBe(1);
  });

  test("treats a token set as a set — repetition is not emphasis", () => {
    expect(
      descriptorSimilarity(descriptor({ verb: "route route" }), descriptor({ verb: "route" })),
    ).toBe(1);
  });

  test("field-orthogonality: differing only in `verb` scores exactly (0+1+1+1)/4", () => {
    const other = descriptor({ verb: "photosynthesise" });
    expect(descriptorSimilarity(descriptor(), other)).toBe(0.75);
  });

  test("both-empty field contributes 0 (unreachable by construction; fails closed)", () => {
    // Every field empty on both sides would be 0, and one field empty on both sides drags the mean.
    const blank: MechanismDescriptor = {
      verb: "",
      object_class: "",
      constraint: "",
      transferable_structure: "",
    };
    expect(descriptorSimilarity(blank, blank)).toBe(0);
    expect(
      descriptorSimilarity(descriptor({ constraint: "" }), descriptor({ constraint: "" })),
    ).toBe(0.75);
  });

  test("one-empty field contributes 0", () => {
    expect(descriptorSimilarity(descriptor({ constraint: "" }), descriptor())).toBe(0.75);
  });

  test("is deterministic — two calls return the same number", () => {
    const a = descriptor();
    const b = descriptor({ object_class: "packets", transferable_structure: "queue overflow" });
    expect(descriptorSimilarity(a, b)).toBe(descriptorSimilarity(a, b));
  });
});
