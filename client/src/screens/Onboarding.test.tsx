// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi, type Mock } from "vitest";

import { DOMAIN_CLUSTERS } from "../domain/taxonomy.ts";
import { Onboarding } from "./Onboarding.tsx";

const IDEA = {
  id: "9f1c",
  hypothesis: "A single sentence",
  problem: "p",
  monetization: "m",
  domain_tags: ["ai-ml"],
  lineage_kind: "ROOT",
  lineage_parent_id: null,
  status: "ACTIVE",
  visibility: "PRIVATE",
  current_version: 1,
  created_at: "2026-10-14T05:14:05Z",
  updated_at: "2026-10-14T05:14:05Z",
};

const SUMMARY = {
  resolved_domains: 2,
  provisional_domains: 3,
  target: 3,
  floor: 2,
  eligible: true,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The summary read and the capture write answer differently; both are stubbed by path. */
function stubFetch(summary: unknown = SUMMARY): FetchStub {
  const mock: FetchStub = vi.fn((url: string) => {
    if (url.startsWith("/v1/vault/summary")) return Promise.resolve(json(summary));
    return Promise.resolve(json(IDEA, 201));
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** The stubbed `fetch`, typed so the recorded `(url, init)` pair is readable at the assertion. */
type FetchStub = Mock<(url: string, init?: RequestInit) => Promise<Response>>;

const addIdea = () => fireEvent.click(screen.getByRole("button", { name: "Add idea" }));
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const chooseDomain = (value: string) =>
  fireEvent.change(screen.getByLabelText("Domain"), { target: { value } });

function fillValidDraft() {
  type("Core Hypothesis", "A single sentence");
  type("Problem Solved", "the friction");
  type("Monetization / Value Angle", "the value angle");
  chooseDomain("ai-ml");
}

/** The capture call the screen sent, if any. */
function captureCall(mock: FetchStub) {
  const call = mock.mock.calls.find(([url]) => url === "/v1/ideas");
  return call ? JSON.parse(String((call[1] as RequestInit | undefined)?.body)) : null;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("the readout and the chart are the summary's numbers — never a local tally (R1)", async () => {
  stubFetch();
  const { container } = render(<Onboarding />);

  // `resolved_domains` is 2 while `provisional_domains` is 3: a local tally would read `5 / 3`.
  const readout = await screen.findByLabelText("Domains covered");
  expect(within(readout).getByText("2 / 3")).toBeTruthy();
  expect(within(readout).queryByText("5 / 3")).toBeNull();
  // The chart is the readout's twin: one brass point per resolved domain, one pale per provisional.
  expect(container.querySelectorAll(".star--covered")).toHaveLength(2);
  expect(container.querySelectorAll(".star--provisional")).toHaveLength(3);
  expect(within(readout).getByText(/2 covered domains, 3 provisional/)).toBeTruthy();
});

test("the mark and the announcement print the readout's capped number — one displayed quantity", async () => {
  // `resolved: 5` clears a `target: 3`: the readout caps at the target, and so must the mark and the
  // sr announcement, or the screen shows `3 / 3` beside five points and "5 covered domains".
  stubFetch({ ...SUMMARY, resolved_domains: 5, eligible: true });
  const { container } = render(<Onboarding />);

  const readout = await screen.findByLabelText("Domains covered");
  expect(within(readout).getByText("3 / 3")).toBeTruthy();
  expect(container.querySelectorAll(".star--covered")).toHaveLength(3);
  expect(within(readout).getByText(/3 covered domains, 3 provisional/)).toBeTruthy();
  expect(within(readout).queryByText(/5 covered domains/)).toBeNull();
});

test("the picker offers every shipped cluster under its name", async () => {
  stubFetch();
  render(<Onboarding />);
  await screen.findByLabelText("Domains covered");

  const select = screen.getByLabelText("Domain");
  for (const cluster of DOMAIN_CLUSTERS) {
    expect(within(select).getByRole("option", { name: cluster.name })).toBeTruthy();
  }
  expect(within(select).getByRole("option", { name: "Other — free text" })).toBeTruthy();
});

test("a pick writes the cluster key, not the label, and is not provisional", async () => {
  const mock = stubFetch();
  render(<Onboarding />);
  await screen.findByLabelText("Domains covered");

  fillValidDraft();
  addIdea();

  await vi.waitFor(() => expect(captureCall(mock)).not.toBeNull());
  expect(captureCall(mock)).toMatchObject({ domain_tags: ["ai-ml"] });
  // `AI & ML` is not a tag: sending the label would leave the domain provisional forever.
  expect(captureCall(mock).domain_tags).not.toContain("AI & ML");
  expect(screen.queryByText("provisional")).toBeNull();
});

test("the Other lane is visibly provisional and writes what was typed", async () => {
  const mock = stubFetch();
  render(<Onboarding />);
  await screen.findByLabelText("Domains covered");

  type("Core Hypothesis", "A single sentence");
  type("Problem Solved", "the friction");
  type("Monetization / Value Angle", "the value angle");
  chooseDomain("__other");
  type("Your domain, in your own words", "#Urban Beekeeping");

  expect(screen.getByText("provisional")).toBeTruthy();
  expect(screen.getByText("urban beekeeping")).toBeTruthy();

  addIdea();
  await vi.waitFor(() => expect(captureCall(mock)).not.toBeNull());
  // The typed tag is written immediately, normalised by S2's rule — provisional is a read-time fact.
  expect(captureCall(mock)).toMatchObject({ domain_tags: ["urban beekeeping"] });
});

test("an empty mandatory field blocks the save and shows its own error (T02)", async () => {
  const mock = stubFetch();
  render(<Onboarding />);
  await screen.findByLabelText("Domains covered");

  addIdea();

  expect(screen.getByText("Hypothesis is required")).toBeTruthy();
  expect(screen.getByText("Problem is required")).toBeTruthy();
  expect(screen.getByText("Monetization is required")).toBeTruthy();
  expect(screen.getByText("Add at least one domain")).toBeTruthy();
  expect(captureCall(mock)).toBeNull();
});

test("a saved idea advances the prompt, blanks the form, and re-reads the summary", async () => {
  const mock = stubFetch();
  render(<Onboarding />);
  await screen.findByLabelText("Domains covered");
  expect(screen.getByText("An idea from your work")).toBeTruthy();

  fillValidDraft();
  addIdea();

  await vi.waitFor(() => expect(screen.getByText("A frustration nobody has fixed")).toBeTruthy());
  // T02 is S0 → S0: the draft is blank and the domain chip is gone.
  expect((screen.getByLabelText("Core Hypothesis") as HTMLInputElement).value).toBe("");
  expect(screen.queryByText("ai-ml")).toBeNull();
  // The readout is re-read from the server, not incremented in the client.
  expect(mock.mock.calls.filter(([url]) => url === "/v1/vault/summary")).toHaveLength(2);
});

test("a failed summary read composes a retry state instead of a bare line", async () => {
  let fail = true;
  const mock: FetchStub = vi.fn((url: string) => {
    if (url.startsWith("/v1/vault/summary") && fail) {
      fail = false;
      return Promise.resolve(json({ error: { code: "internal_error", message: "no" } }, 500));
    }
    return Promise.resolve(json(SUMMARY));
  });
  vi.stubGlobal("fetch", mock);

  render(<Onboarding />);

  const empty = await screen.findByLabelText("Progress unavailable");
  expect(within(empty).getByText(/out of reach/)).toBeTruthy();
  fireEvent.click(within(empty).getByRole("button", { name: "Try again" }));

  expect(await screen.findByText("2 / 3")).toBeTruthy();
});
