// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { Sparks } from "./Sparks.tsx";

/** A payload the server could return: `resolved: 1` is below the floor, so `eligible` is false. */
const COLD = {
  resolved_domains: 1,
  provisional_domains: 2,
  target: 3,
  floor: 2,
  eligible: false,
};

const OPEN = { ...COLD, resolved_domains: 3, eligible: true };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(body: unknown, status = 200) {
  const mock = vi.fn(() => Promise.resolve(json(body, status)));
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("a vault below the floor lands S1 in E0: the mark, the reason, the widening CTA", async () => {
  stubFetch(COLD);
  render(<Sparks />);

  const cold = await screen.findByLabelText("Sparks need more domains");
  // The mark is S0's, not a copy: the same readout and the same points.
  expect(within(cold).getByText("1 / 3")).toBeTruthy();
  expect(cold.querySelectorAll(".star--covered")).toHaveLength(1);
  // The one-line reason and the single lever (`FLOW.md` §5.2 / `DESIGN.md` §9).
  expect(
    within(cold).getByText("Sparks pair distant domains — add ideas from another field."),
  ).toBeTruthy();
  const cta = within(cold).getByRole("link", { name: "Add idea" });
  expect(cta.getAttribute("href")).toBe("#/capture");
});

test("E0 is not an error state and never offers the deck", async () => {
  stubFetch(COLD);
  render(<Sparks />);

  await screen.findByLabelText("Sparks need more domains");
  expect(screen.queryByText(/Placeholder/)).toBeNull();
  // No failure copy: E0 is a breadth state, not a broken read (`DESIGN.md` §9).
  expect(screen.queryByText(/out of reach/)).toBeNull();
});

test("an eligible vault does not land E0 — the deck's seat holds until K2", async () => {
  stubFetch(OPEN);
  render(<Sparks />);

  expect(await screen.findByText(/Placeholder/)).toBeTruthy();
  expect(screen.queryByLabelText("Sparks need more domains")).toBeNull();
});

/**
 * The gate is the **server's** boolean. A payload whose count and `eligible` disagree — here a vault
 * the server calls eligible with a single resolved domain — must follow `eligible`, proving the
 * screen does not tally or re-derive.
 */
test("the E0 landing follows `eligible`, not a local count", async () => {
  stubFetch({ ...COLD, resolved_domains: 1, eligible: true });
  render(<Sparks />);

  expect(await screen.findByText(/Placeholder/)).toBeTruthy();
  expect(screen.queryByLabelText("Sparks need more domains")).toBeNull();
});

test("a failed summary read says so and retries — it never shows E0 as a guess", async () => {
  const mock = stubFetch({ error: "boom" }, 500);
  render(<Sparks />);

  expect(await screen.findByText("Sparks are out of reach.")).toBeTruthy();
  expect(screen.queryByLabelText("Sparks need more domains")).toBeNull();
  // The retry re-issues the read; the second answer is a cold vault, so E0 lands.
  mock.mockImplementation(() => Promise.resolve(json(COLD)));
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByLabelText("Sparks need more domains")).toBeTruthy();
});
