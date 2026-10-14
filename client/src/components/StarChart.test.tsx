// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import { StarChart } from "./StarChart.tsx";

afterEach(cleanup);

const SUMMARY = {
  resolved_domains: 2,
  provisional_domains: 3,
  target: 3,
  floor: 2,
  eligible: true,
};

/** The mark renders the summary's own numbers — the server payload, never a local count (R1). */
test("the mark draws one brass point per resolved domain and one pale per provisional", () => {
  const { container } = render(<StarChart summary={SUMMARY} />);

  const readout = screen.getByLabelText("Domains covered");
  expect(within(readout).getByText("2 / 3")).toBeTruthy();
  expect(container.querySelectorAll(".star--covered")).toHaveLength(2);
  expect(container.querySelectorAll(".star--provisional")).toHaveLength(3);
  expect(within(readout).getByText(/2 covered domains, 3 provisional/)).toBeTruthy();
});

/** `resolved > target` caps: readout, bar and points print one number, not three. */
test("a vault past the target caps the readout and the points together", () => {
  const { container } = render(<StarChart summary={{ ...SUMMARY, resolved_domains: 5 }} />);

  const readout = screen.getByLabelText("Domains covered");
  expect(within(readout).getByText("3 / 3")).toBeTruthy();
  expect(container.querySelectorAll(".star--covered")).toHaveLength(3);
  expect(container.querySelectorAll(".progress__seg--filled")).toHaveLength(3);
  expect(within(readout).queryByText(/5 covered domains/)).toBeNull();
});
