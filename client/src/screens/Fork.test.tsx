// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { Fork } from "./Fork.tsx";

/** §3.1 — the parent the branch comes from. */
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
    current_version: 1,
    created_at: "2026-10-13T05:14:05Z",
    updated_at: "2026-10-13T05:14:05Z",
    ...patch,
  };
}

/** §4.5 — the parent's read; only `idea` is read by S5. */
function detail(patch: Record<string, unknown> = {}) {
  return {
    idea: idea(),
    versions: [],
    lineage: [],
    provenance: [],
    referenced_by: { forks: [], derived: [] },
    ...patch,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const envelope = (code: string, message: string, status: number) =>
  json({ error: { code, message, details: null } }, status);

/**
 * §4.5 is `GET /v1/ideas/<id>`, §4.4 is `GET /v1/ideas`, and §4.7 is `POST /v1/ideas/<id>/fork` — one
 * stub that tells them apart, so a test can drive any of the three without a pile of variants.
 */
function stubVault(options: { parent?: unknown; ideas?: unknown[]; fork?: unknown } = {}) {
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && url.endsWith("/fork")) {
      return Promise.resolve(
        options.fork instanceof Response ? options.fork : json(options.fork ?? idea(), 201),
      );
    }
    if (url.endsWith("/ideas")) {
      return Promise.resolve(json({ ideas: options.ideas ?? [idea()] }));
    }
    return Promise.resolve(
      options.parent instanceof Response ? options.parent : json(options.parent ?? detail()),
    );
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** The DomainsField's free-entry control — the one way to type a domain the vault does not carry. */
function addDomain(tag: string) {
  fireEvent.change(screen.getByLabelText("Domain tag(s)"), { target: { value: tag } });
  fireEvent.click(screen.getByRole("button", { name: "+ add domain" }));
}

beforeEach(() => {
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("the seeded route reads the parent and shows it dimmed, labelled PARENT (§6, T24)", async () => {
  stubVault();
  render(<Fork parentId="abc" />);

  const parent = await screen.findByLabelText("Parent idea");
  expect(within(parent).getByText("PARENT")).toBeTruthy();
  expect(within(parent).getByText("A single sentence")).toBeTruthy();
  expect(within(parent).getByText("fintech")).toBeTruthy();
  // The parent is read, never edited: §4.7 copies its three text fields server-side.
  expect(within(parent).queryByRole("textbox")).toBeNull();
  // §6's one helper line under the delta field.
  expect(screen.getByText("Say what changes. The parent stays intact.")).toBeTruthy();
});

test("the suggestion row offers the vault's domains minus the parent's — and nothing is required (§6)", async () => {
  stubVault({
    ideas: [idea({ domain_tags: ["fintech"] }), idea({ id: "b", domain_tags: ["health-data"] })],
  });
  render(<Fork parentId="abc" />);

  // `health-data` is the vault's and not the parent's, which is exactly the difference §4.7 asks for.
  const suggestion = await screen.findByRole("button", { name: "health-data" });
  expect(suggestion.getAttribute("aria-pressed")).toBe("false");
  // The parent's own tag is not offered as a suggestion — it would be refused as a same-domain fork.
  expect(screen.queryByRole("button", { name: "fintech" })).toBeNull();
  expect(screen.getByText(/Pick a domain you haven’t used/)).toBeTruthy();

  // Tapping one fills the fork's domain, and the record card states what will be written.
  fireEvent.click(suggestion);
  await waitFor(() => expect(screen.getByRole("button", { name: "health-data" })).toBeTruthy());
  expect(screen.getByText(/Fork of abc · domain #health-data/)).toBeTruthy();
});

test("a same-domain attempt offers Iterate instead of forking — no request leaves the screen (T25, §4.7)", async () => {
  const fetchMock = stubVault();
  render(<Fork parentId="abc" />);

  fireEvent.change(await screen.findByLabelText("Mutation delta"), {
    target: { value: "Forking this into a compliance scheduler" },
  });
  addDomain("fintech");

  fireEvent.click(screen.getByRole("button", { name: "Create fork" }));

  const offer = await screen.findByRole("link", { name: "Iterate instead" });
  expect(offer.getAttribute("href")).toBe("#/iterate/abc");
  // Two reads, no write: the rule is applied before the request, not discovered by a `409`.
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(window.location.hash).toBe("");
});

test("a server 409 draws the same Iterate offer — the race the rule exists for (T25)", async () => {
  const fetchMock = stubVault({
    fork: envelope("conflict", "idea abc already carries this domain set — iterate instead", 409),
  });
  render(<Fork parentId="abc" />);

  fireEvent.change(await screen.findByLabelText("Mutation delta"), {
    target: { value: "Forking this into a compliance scheduler" },
  });
  addDomain("compliance");
  fireEvent.click(screen.getByRole("button", { name: "Create fork" }));

  // Same answer, whichever side caught it — one offer, not two ways of saying it.
  expect((await screen.findByRole("link", { name: "Iterate instead" })).getAttribute("href")).toBe(
    "#/iterate/abc",
  );
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test("Create fork posts exactly §4.7's two fields and lands on the new node's detail (T25)", async () => {
  const fetchMock = stubVault({ fork: idea({ id: "new", lineage_kind: "FORK" }) });
  render(<Fork parentId="abc" />);

  fireEvent.change(await screen.findByLabelText("Mutation delta"), {
    target: { value: "Forking this into a compliance scheduler" },
  });
  addDomain("compliance");
  fireEvent.click(screen.getByRole("button", { name: "Create fork" }));

  await waitFor(() => expect(window.location.hash).toBe("#/ideas/new"));

  const [url, init] = fetchMock.mock.calls.at(-1)!;
  expect(url).toBe("/v1/ideas/abc/fork");
  expect(init!.method).toBe("POST");
  // The frozen two — no text key: the fork's hypothesis/problem/monetization are the parent's, copied
  // server-side, and a third key here would be a `422`.
  expect(JSON.parse(init!.body as string)).toEqual({
    mutation_delta: "Forking this into a compliance scheduler",
    domain_tags: ["compliance"],
  });
});

test("an empty delta or no domain blocks the fork inline — no request leaves the screen (T25)", async () => {
  const fetchMock = stubVault();
  render(<Fork parentId="abc" />);

  fireEvent.click(await screen.findByRole("button", { name: "Create fork" }));

  expect(await screen.findByText("The mutation delta is required")).toBeTruthy();
  expect(screen.getByText("Add at least one domain")).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(window.location.hash).toBe("");
});

test("an unknown parent is the missing state with a way back — `not_found` is not an error to retry", async () => {
  stubVault({ parent: envelope("not_found", "no such idea", 404) });
  render(<Fork parentId="gone" />);

  expect(await screen.findByText("This idea is not here.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Back to the vault" }).getAttribute("href")).toBe(
    "#/vault",
  );
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

test("a bare #/fork composes the parent picker over §4.4 — one card per idea, each into the seeded route (E3)", async () => {
  const fetchMock = stubVault({
    ideas: [idea({ id: "abc" }), idea({ id: "def", hypothesis: "Another sentence" })],
  });
  render(<Fork />);

  expect(await screen.findByRole("link", { name: /A single sentence/ })).toBeTruthy();
  const cards = screen.getAllByRole("link");
  expect(cards.map((card) => card.getAttribute("href"))).toEqual(["#/fork/abc", "#/fork/def"]);
  // It reads the vault's own list and nothing else — no second idea read exists in the client.
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(String(fetchMock.mock.calls[0]![0])).toBe("/v1/ideas");
});

test("an empty vault on the picker is a composed invitation, never a blank list (T19's rule, E3)", async () => {
  stubVault({ ideas: [] });
  render(<Fork />);

  expect(await screen.findByText("Nothing to fork yet.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Add idea" }).getAttribute("href")).toBe("#/capture");
});
