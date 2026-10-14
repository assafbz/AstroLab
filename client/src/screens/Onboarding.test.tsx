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

/** The summary read, the run trigger and the capture write answer differently; each is stubbed by path. */
function stubFetch(summary: unknown = SUMMARY): FetchStub {
  const mock: FetchStub = vi.fn((url: string) => {
    if (url.startsWith("/v1/vault/summary")) return Promise.resolve(json(summary));
    if (url === "/v1/sparks/run")
      return Promise.resolve(json({ run_id: "r-1", vault_revision: 1 }, 202));
    return Promise.resolve(json(IDEA, 201));
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** The run-trigger calls the screen sent, in order. */
function runCalls(mock: FetchStub) {
  return mock.mock.calls.filter(([url]) => url === "/v1/sparks/run");
}

const seeSparks = () => fireEvent.click(screen.getByRole("link", { name: "See your sparks" }));
const skip = () => fireEvent.click(screen.getByRole("link", { name: "skip for now" }));

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

/**
 * The exits (`FLOW.md` T03/T04). `See your sparks` is the gate; `Skip` is unconditional. Both are
 * anchors onto S1 (`#/`) — the route `router.ts` already owns, so neither invents one.
 */
test("the gate's CTA appears iff the server says eligible; Skip is always there", async () => {
  stubFetch();
  render(<Onboarding />);
  await screen.findByLabelText("Domains covered");

  expect(screen.getByRole("link", { name: "See your sparks" }).getAttribute("href")).toBe("#/");
  expect(screen.getByRole("link", { name: "skip for now" }).getAttribute("href")).toBe("#/");
});

test("a vault below the floor gets Skip and no gate CTA", async () => {
  stubFetch({ ...SUMMARY, resolved_domains: 1, eligible: false });
  render(<Onboarding />);
  await screen.findByLabelText("Domains covered");

  expect(screen.queryByRole("link", { name: "See your sparks" })).toBeNull();
  expect(screen.getByRole("link", { name: "skip for now" })).toBeTruthy();
});

/** The gate follows `eligible`, not a local count: this payload is the discriminating pair. */
test("the CTA follows the server's eligible, not the payload's count", async () => {
  stubFetch({ ...SUMMARY, resolved_domains: 0, eligible: true });
  render(<Onboarding />);
  await screen.findByLabelText("Domains covered");

  expect(screen.getByRole("link", { name: "See your sparks" })).toBeTruthy();
});

/** An unread / unreachable summary is never a guessed gate: the CTA is absent, Skip still works. */
test("no gate CTA while the summary is unknown — it is absent, never guessed", async () => {
  const mock: FetchStub = vi.fn(() =>
    Promise.resolve(json({ error: { code: "internal_error", message: "no" } }, 500)),
  );
  vi.stubGlobal("fetch", mock);

  render(<Onboarding />);
  await screen.findByLabelText("Progress unavailable");

  expect(screen.queryByRole("link", { name: "See your sparks" })).toBeNull();
  expect(screen.getByRole("link", { name: "skip for now" })).toBeTruthy();
});

/**
 * T04's side effect (`FLOW.md` §4.2; `docs/API.md` §4.16). The run fires on the exit the user chose —
 * the CTA press — and the trigger is fire-and-forget, so the anchor keeps its own navigation.
 */
test("pressing the gate CTA kicks the run once — T04's side effect, on the chosen exit", async () => {
  const mock = stubFetch();
  const { container } = render(<Onboarding />);
  await screen.findByLabelText("Domains covered");

  seeSparks();

  await vi.waitFor(() => expect(runCalls(mock)).toHaveLength(1));
  const [url, init] = runCalls(mock)[0]!;
  expect(url).toBe("/v1/sparks/run");
  expect(init!.method).toBe("POST");
  // §4.16 reads no body — the trigger must not send one.
  expect(init!.body).toBeUndefined();
  // Fire-and-forget, not an in-place action: the CTA is still the S1 anchor it always was.
  expect(container.querySelector(".exits a")!.getAttribute("href")).toBe("#/");
});

/** T03 has no side effect — a run fired from `Skip` would be a run the user did not choose. */
test("Skip never kicks a run", async () => {
  const mock = stubFetch();
  render(<Onboarding />);
  await screen.findByLabelText("Domains covered");

  skip();

  // Give any errant fire a chance to land before asserting its absence.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(runCalls(mock)).toHaveLength(0);
});

/** The trigger is the press, never the mount — an auto-run on the S0→S1 exit would fire for Skip too. */
test("rendering S0 alone fires no run — the trigger is the press", async () => {
  const mock = stubFetch();
  render(<Onboarding />);
  await screen.findByLabelText("Domains covered");

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(runCalls(mock)).toHaveLength(0);
});

/**
 * Fire-and-forget (NFR-P1; `docs/API.md` §4.16 — *"the request never waits"*). The CTA stays the anchor
 * it always was: the handler fires the run and returns, leaving the anchor's own `href="#/"` navigation
 * intact. A handler that took over navigation — `preventDefault()` then navigating only after the POST
 * settles — would make the exit wait on the engine, and does not.
 */
test("the trigger is fire-and-forget — the CTA's own navigation is not intercepted", async () => {
  const mock = stubFetch();
  const { container } = render(<Onboarding />);
  await screen.findByLabelText("Domains covered");

  const anchor = container.querySelector(".exits a")!;
  const press = new MouseEvent("click", { bubbles: true, cancelable: true });
  anchor.dispatchEvent(press);

  // The anchor navigates itself; the handler fired the run without taking over navigation.
  expect(press.defaultPrevented).toBe(false);
  expect(anchor.getAttribute("href")).toBe("#/");
  await vi.waitFor(() => expect(runCalls(mock)).toHaveLength(1));
});

/** The single-flight guard (`domain/run-trigger.ts`) holds at the screen: a double-press sends one POST. */
test("a double-press of the CTA sends one run", async () => {
  const pending = new Promise<Response>(() => {});
  const mock: FetchStub = vi.fn((url: string) => {
    if (url.startsWith("/v1/vault/summary")) return Promise.resolve(json(SUMMARY));
    if (url === "/v1/sparks/run") return pending;
    return Promise.resolve(json(IDEA, 201));
  });
  vi.stubGlobal("fetch", mock);

  render(<Onboarding />);
  await screen.findByLabelText("Domains covered");

  seeSparks();
  seeSparks();
  seeSparks();

  expect(runCalls(mock)).toHaveLength(1);
});
