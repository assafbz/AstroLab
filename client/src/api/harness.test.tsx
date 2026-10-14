// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";

/**
 * Proves the DOM harness itself — jsdom plus `@testing-library/react` — renders, before any
 * product test leans on it. This asserts the toolchain, not a product behaviour (D2).
 */
test("the DOM harness renders and reflects the tree", () => {
  render(<p>ok</p>);
  expect(screen.getByText("ok")).toBeTruthy();
});
