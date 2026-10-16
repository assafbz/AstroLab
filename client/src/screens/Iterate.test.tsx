// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { Iterate } from "./Iterate.tsx";

/** §3.1 — the node the editor edits. */
function idea(patch: Record<string, unknown> = {}) {
  return {
    id: "abc",
    hypothesis: "A single sentence",
    problem: "the friction",
    monetization: "the value angle",
    domain_tags: ["fintech"],
    lineage_kind: "ROOT",
    lineage_parent_id: null,
    status: "ACTIVE",
    visibility: "PRIVATE",
    current_version: 2,
    created_at: "2026-10-13T05:14:05Z",
    updated_at: "2026-10-13T06:14:05Z",
    ...patch,
  };
}

/** §4.5 — versions ascend and include the current one, so v1 is prior history. */
function version(patch: Record<string, unknown> = {}) {
  return {
    version: 1,
    hypothesis: "An earlier sentence",
    problem: "an earlier friction",
    monetization: "an earlier angle",
    domain_tags: ["transit"],
    created_at: "2026-10-13T05:14:05Z",
    ...patch,
  };
}

function detail(patch: Record<string, unknown> = {}) {
  return {
    idea: idea(),
    versions: [
      version(),
      version({
        version: 2,
        hypothesis: "A single sentence",
        problem: "the friction",
        monetization: "the value angle",
        domain_tags: ["fintech"],
      }),
    ],
    lineage: [],
    provenance: [],
    referenced_by: { forks: [], derived: [] },
    ...patch,
  };
}

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

const envelope = (code: string, message: string, status: number) =>
  json({ error: { code, message, details: null } }, status);

/** Render the editor over one read; the write is stubbed by the tests that make one. */
function renderIterate(body: unknown = detail(), id = "abc") {
  const fetchMock = stubFetch(() => Promise.resolve(json(body)));
  return { fetchMock, ...render(<Iterate id={id} />) };
}

/** The CTA — the screen's only button that carries a text label of its own. */
const cta = () => screen.getByRole("button", { name: /No changes yet|Save iteration/ });

beforeEach(() => {
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("the four fields are pre-filled from the current version, in Capture's order (T22, DESIGN §8)", async () => {
  renderIterate();

  const hypothesis = (await screen.findByLabelText("Core Hypothesis")) as HTMLInputElement;
  expect(hypothesis.value).toBe("A single sentence");
  expect(hypothesis.id).toBe("iterate-hypothesis");
  expect((screen.getByLabelText("Problem Solved") as HTMLInputElement).value).toBe("the friction");
  expect((screen.getByLabelText("Monetization / Value Angle") as HTMLInputElement).value).toBe(
    "the value angle",
  );
  // The editor's own chip, and v2's in the history: the four fields render in both places.
  expect(screen.getAllByText("fintech")).toHaveLength(2);
  // The same node S4 shows, and the same id it shows for it.
  expect(screen.getByText("abc")).toBeTruthy();
  // The live mono counter, the S2 rule (§3, T17).
  expect(screen.getByText("17 / 280")).toBeTruthy();
});

test("`No changes yet` — the CTA is disabled while the form matches the current version (DESIGN §8, T23)", async () => {
  renderIterate();

  await screen.findByLabelText("Core Hypothesis");
  expect(cta().textContent).toBe("No changes yet");
  expect((cta() as HTMLButtonElement).disabled).toBe(true);

  // Any keystroke opens it — the comparison is against the fields **as typed**, never trimmed, because
  // §4.6 stores the string the user wrote.
  fireEvent.change(screen.getByLabelText("Core Hypothesis"), {
    target: { value: "A single sentence." },
  });
  await waitFor(() => expect(cta().textContent).toBe("Save iteration"));
  expect((cta() as HTMLButtonElement).disabled).toBe(false);
});

test("a saved iteration posts §4.6's four fields and returns to S4 (T23)", async () => {
  const fetchMock = stubFetch((url) =>
    Promise.resolve(url.endsWith("/iterate") ? json(idea()) : json(detail())),
  );
  render(<Iterate id="abc" />);

  fireEvent.change(await screen.findByLabelText("Core Hypothesis"), {
    target: { value: "A sharper sentence" },
  });
  fireEvent.click(cta());

  await waitFor(() => expect(window.location.hash).toBe("#/ideas/abc"));

  const [url, init] = fetchMock.mock.calls.at(-1)!;
  expect(url).toBe("/v1/ideas/abc/iterate");
  expect(init!.method).toBe("POST");
  // Exactly `IdeaFields` — §4.6's request verbatim, no extra key to 422 on.
  expect(JSON.parse(init!.body as string)).toEqual({
    hypothesis: "A sharper sentence",
    problem: "the friction",
    monetization: "the value angle",
    domain_tags: ["fintech"],
  });
  // T23 — the same node, so the id in the route never changes; it is S4 that reads v N+1.
  expect(window.location.hash).not.toContain("/iterate");
});

test("an emptied mandatory field blocks the save inline — no request leaves the screen (T23)", async () => {
  const { fetchMock } = renderIterate();

  fireEvent.change(await screen.findByLabelText("Problem Solved"), { target: { value: "   " } });
  fireEvent.click(cta());

  expect(await screen.findByText("Problem is required")).toBeTruthy();
  // The read is the only call: a blocked save is the *save* being blocked, not a `422` round-trip.
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(window.location.hash).toBe("");
});

test("the history is a flat list of versions — current marked, no lineage vocabulary (DESIGN §8, L1)", async () => {
  const { container } = renderIterate();

  await screen.findByLabelText("Core Hypothesis");
  const rows = [...container.querySelectorAll(".history__row")];
  expect(rows).toHaveLength(2);
  // Flat and read-only: no chain node, no link, no marker — that vocabulary is S4's LIVING LINEAGE.
  expect(container.querySelector(".chain")).toBeNull();
  expect(container.querySelectorAll(".history__link")).toHaveLength(0);

  // The current version is marked, and only it.
  expect(screen.getAllByText("current")).toHaveLength(1);
  expect((rows[1] as HTMLElement).className).toContain("history__row--current");
  expect(within(rows[1] as HTMLElement).getByText("current")).toBeTruthy();
  // Each row carries its version number, and opens onto its own field values.
  expect(within(rows[0] as HTMLElement).getByText(/^v1 ·/)).toBeTruthy();
  expect(within(rows[0] as HTMLElement).getByText("an earlier friction")).toBeTruthy();
  expect(within(rows[0] as HTMLElement).getByText("transit")).toBeTruthy();
});

test("a first iteration's history is a one-row list, never an empty state (DESIGN §8)", async () => {
  const { container } = renderIterate(detail({ versions: [version({ version: 1 })] }));

  await screen.findByLabelText("Core Hypothesis");
  expect([...container.querySelectorAll(".history__row")]).toHaveLength(1);
  expect(screen.queryByText(/no history/i)).toBeNull();
  expect(container.querySelector(".empty")).toBeNull();
});

test("an unknown id is the missing state with a way back — `not_found` is not an error to retry", async () => {
  stubFetch(() => Promise.resolve(envelope("not_found", "no such idea", 404)));
  render(<Iterate id="gone" />);

  expect(await screen.findByText("This idea is not here.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Back to the vault" }).getAttribute("href")).toBe(
    "#/vault",
  );
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

test("leaving with an unsaved refinement asks first, and the node is not mutated implicitly (DESIGN §8)", async () => {
  renderIterate();

  fireEvent.change(await screen.findByLabelText("Core Hypothesis"), {
    target: { value: "Something else entirely" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));

  const confirm = await screen.findByRole("alertdialog");
  expect(within(confirm).getByText("Discard your changes?")).toBeTruthy();

  // Keeping the edits closes the confirm and stays on S6 — nothing navigated, nothing saved.
  fireEvent.click(within(confirm).getByRole("button", { name: "Keep editing" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(window.location.hash).toBe("");
  expect((screen.getByLabelText("Core Hypothesis") as HTMLInputElement).value).toBe(
    "Something else entirely",
  );

  // Discarding is the way out, and it goes back to the node's own detail.
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Discard changes",
    }),
  );
  expect(window.location.hash).toBe("#/ideas/abc");
});

test("an unchanged form leaves without a confirm — there is nothing to discard", async () => {
  renderIterate();

  fireEvent.click(await screen.findByRole("button", { name: "Back" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(window.location.hash).toBe("#/ideas/abc");
});

test("a failed save is non-destructive: the typing stays, and only a retryable failure offers Retry (T29)", async () => {
  const fetchMock = stubFetch((url) => {
    if (url.endsWith("/iterate")) {
      return Promise.resolve(envelope("internal_error", "that didn't go through", 502));
    }
    return Promise.resolve(json(detail()));
  });
  render(<Iterate id="abc" />);

  fireEvent.change(await screen.findByLabelText("Core Hypothesis"), {
    target: { value: "A sharper sentence" },
  });
  fireEvent.click(cta());

  const notice = await screen.findByRole("alert");
  expect(notice.textContent).toContain("that didn't go through");
  // The typing is never lost — the draft is exactly what the failed save carried.
  expect((screen.getByLabelText("Core Hypothesis") as HTMLInputElement).value).toBe(
    "A sharper sentence",
  );
  // `internal_error` is retryable, so the same request can be re-issued (T29).
  const retry = within(notice).getByRole("button", { name: "Retry" });
  fireEvent.click(retry);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
});
