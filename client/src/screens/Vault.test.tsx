// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { Vault } from "./Vault.tsx";

const IDEA = {
  id: "9f1c",
  hypothesis: "A single sentence",
  problem: "p",
  monetization: "m",
  domain_tags: ["fin"],
  lineage_kind: "ROOT",
  lineage_parent_id: null,
  status: "ACTIVE",
  visibility: "PRIVATE",
  current_version: 1,
  created_at: "2026-10-13T05:14:05Z",
  updated_at: "2026-10-13T05:14:05Z",
};

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock);
  return mock;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const okList = (ideas: unknown[]) => () => Promise.resolve(json({ ideas }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("an empty vault composes an empty state with an Add idea CTA — never a bare 'No ideas yet' (T19)", async () => {
  stubFetch(okList([]));
  render(<Vault />);

  const cta = await screen.findByRole("link", { name: /add idea/i });
  expect(cta.getAttribute("href")).toBe("#/capture");
  expect(screen.queryByText("No ideas yet")).toBeNull();
  expect(screen.getByText(/Every idea starts as a hypothesis/i)).toBeTruthy();
});

test("a loaded idea links to its detail (T21)", async () => {
  stubFetch(okList([IDEA]));
  render(<Vault />);

  const card = await screen.findByRole("link", { name: /A single sentence/ });
  expect(card.getAttribute("href")).toBe("#/ideas/9f1c");
});

test("a needs-completion card carries T27's prompt — the badge names it, the prompt names the fix", async () => {
  stubFetch(okList([{ ...IDEA, status: "NEEDS_COMPLETION", monetization: "" }]));
  render(<Vault />);

  const card = await screen.findByRole("link", { name: /A single sentence/ });
  expect(within(card).getByText("Needs completion")).toBeTruthy();
  expect(
    within(card).getByText("Add the monetization / value angle to put it back in play."),
  ).toBeTruthy();
  // The prompt is prose inside the card's own link — never a nested control (§4.4 is a list, not a form).
  expect(within(card).queryByRole("button")).toBeNull();
  expect(within(card).queryByRole("link", { name: /complete/i })).toBeNull();
});

test("an active card carries no prompt — the incomplete case is the only one that prompts", async () => {
  stubFetch(okList([IDEA]));
  render(<Vault />);

  const card = await screen.findByRole("link", { name: /A single sentence/ });
  expect(within(card).queryByText(/to put it back in play/)).toBeNull();
});

test("an empty filtered result names the filter and offers to clear it (T20)", async () => {
  stubFetch((url) =>
    url.includes("domain=fin") ? Promise.resolve(json({ ideas: [] })) : okList([IDEA])(),
  );
  render(<Vault />);
  await screen.findByRole("link", { name: /A single sentence/ });

  fireEvent.click(screen.getByRole("button", { name: "fin" }));

  expect(await screen.findByText("No ideas in fin.")).toBeTruthy();
  const clear = screen.getByRole("button", { name: /clear/i });
  fireEvent.click(clear);
  expect(await screen.findByRole("link", { name: /A single sentence/ })).toBeTruthy();
});

test("the domain palette comes from the first unfiltered load (D6), not from the filtered result", async () => {
  stubFetch((url) =>
    url.includes("domain=") ? Promise.resolve(json({ ideas: [] })) : okList([IDEA])(),
  );
  render(<Vault />);
  await screen.findByRole("link", { name: /A single sentence/ });

  fireEvent.click(screen.getByRole("button", { name: "fin" }));
  await screen.findByText("No ideas in fin.");

  // The filtered response is empty; the chip must not vanish with it.
  expect(screen.getByRole("button", { name: "fin" })).toBeTruthy();
});

test("a lineage filter re-queries with the enum value the contract expects (T20)", async () => {
  const fetchMock = stubFetch(okList([IDEA]));
  render(<Vault />);
  await screen.findByRole("link", { name: /A single sentence/ });

  fireEvent.click(screen.getByRole("button", { name: "FORK" }));

  await waitFor(() => expect(fetchMock.mock.calls.at(-1)![0]).toBe("/v1/ideas?lineage=FORK"));
});

test("a load failure is a non-destructive error with Retry — the loaded list is not wiped (T29)", async () => {
  let failing = false;
  const fetchMock = stubFetch(() =>
    failing ? Promise.reject(new TypeError("offline")) : okList([IDEA])(),
  );
  render(<Vault />);
  await screen.findByRole("link", { name: /A single sentence/ });

  // A re-query fails *after* a good load: the error is additive, not a wipe (NFR-D1).
  failing = true;
  fireEvent.click(screen.getByRole("button", { name: "FORK" }));

  expect(await screen.findByText(/could not reach the vault/i)).toBeTruthy();
  expect(screen.getByRole("link", { name: /A single sentence/ })).toBeTruthy();

  failing = false;
  const before = fetchMock.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
});

test("the first render is a skeletal shimmer (DESIGN.md §4) — not a spinner, and not an empty state", () => {
  stubFetch(() => new Promise<Response>(() => {}));
  const { container } = render(<Vault />);

  expect(container.querySelector(".card--shimmer")).toBeTruthy();
  expect(screen.queryByRole("link", { name: /add idea/i })).toBeNull();
});
