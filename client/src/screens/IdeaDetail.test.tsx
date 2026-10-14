// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { IdeaDetail } from "./IdeaDetail.tsx";

/** §3.1, with the fields a test overrides. */
function idea(patch: Record<string, unknown> = {}) {
  return {
    id: "root",
    hypothesis: "Root hypothesis",
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

const CHILD = idea({
  id: "child",
  hypothesis: "A fork of the root",
  lineage_kind: "FORK",
  lineage_parent_id: "root",
});

const ROOT_ANCESTOR = idea({ id: "root", hypothesis: "Root hypothesis" });

/** §4.5 — the five reads, in one snapshot. */
function detail(patch: Record<string, unknown> = {}) {
  return {
    idea: CHILD,
    versions: [
      {
        version: 1,
        hypothesis: "A fork of the root",
        problem: "the friction",
        monetization: "the value angle",
        domain_tags: ["fintech"],
        created_at: "2026-10-13T05:14:05Z",
      },
    ],
    lineage: [ROOT_ANCESTOR],
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

const renderDetail = (body: unknown, id = "child") => {
  stubFetch(() => Promise.resolve(json(body)));
  return render(<IdeaDetail id={id} />);
};

beforeEach(() => {
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("renders the four fields, the domain chips and the lineage chain root-first (T21)", async () => {
  const { container } = renderDetail(detail());

  expect(await screen.findByRole("heading", { level: 1, name: "A fork of the root" })).toBeTruthy();
  expect(screen.getByText("the friction")).toBeTruthy();
  expect(screen.getByText("the value angle")).toBeTruthy();
  expect(screen.getByText("fintech")).toBeTruthy();

  const nodes = [...container.querySelectorAll(".chain__node")];
  expect(nodes).toHaveLength(2);
  // Root-first, ending at this idea: the ancestor, then the node itself.
  expect(
    within(nodes[0] as HTMLElement)
      .getByRole("link")
      .getAttribute("href"),
  ).toBe("#/ideas/root");
  expect((nodes[1] as HTMLElement).className).toContain("chain__node--current");
});

test("a root idea's chain is its own node — a one-node chain, never a bare 'no lineage'", async () => {
  const { container } = renderDetail(detail({ idea: ROOT_ANCESTOR, lineage: [] }));

  await screen.findByRole("heading", { level: 1, name: "Root hypothesis" });
  const nodes = [...container.querySelectorAll(".chain__node")];
  expect(nodes).toHaveLength(1);
  expect((nodes[0] as HTMLElement).className).toContain("chain__node--current");
  expect(screen.queryByText(/no lineage/i)).toBeNull();
});

test("provenance renders the ids the contract returned, muted — even when one names a tombstone (D5, #80 carry)", async () => {
  renderDetail(detail({ provenance: [{ source_idea_id: "gone-1", spark_id: "spark-1" }] }));

  const ref = await screen.findByText("gone-1");
  expect(ref.closest(".provenance")).toBeTruthy();
  expect(ref.className).toContain("mono");
  // The spark id is recorded beside it; neither is resolved to a title.
  expect(screen.getByText("spark-1")).toBeTruthy();
});

test("an idea with no provenance renders no provenance block at all — absent is not an empty state", async () => {
  const { container } = renderDetail(detail({ provenance: [] }));

  await screen.findByRole("heading", { level: 1, name: "A fork of the root" });
  expect(container.querySelector(".provenance")).toBeNull();
});

test("the T26 confirm names the affected ids in both directions — forks and derived (Review Focus 1)", async () => {
  renderDetail(detail({ referenced_by: { forks: ["f1", "f2"], derived: ["d1"] } }));
  await screen.findByRole("heading", { level: 1, name: "A fork of the root" });

  fireEvent.click(screen.getByRole("button", { name: "Delete idea" }));

  const confirm = screen.getByRole("alertdialog");
  expect(within(confirm).getByText("Delete this idea?")).toBeTruthy();
  expect(confirm.textContent).toContain("f1");
  expect(confirm.textContent).toContain("f2");
  expect(confirm.textContent).toContain("d1");
  expect(confirm.textContent).toMatch(/dangling parent reference/i);
  expect(confirm.textContent).toMatch(/provenance/i);
});

test("confirming delete sends DELETE and returns to the vault (T26)", async () => {
  const fetchMock = stubFetch(() => Promise.resolve(json(detail())));
  render(<IdeaDetail id="child" />);
  await screen.findByRole("heading", { level: 1, name: "A fork of the root" });

  fireEvent.click(screen.getByRole("button", { name: "Delete idea" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete for good" }));

  await waitFor(() => expect(window.location.hash).toBe("#/vault"));
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  expect(url).toBe("/v1/ideas/child");
  expect(init!.method).toBe("DELETE");
});

test("a failing delete surfaces the envelope — never a blank (D7; the route answers 404 until V5 #16)", async () => {
  stubFetch((url, init) =>
    Promise.resolve(
      init?.method === "DELETE"
        ? envelope("not_found", "no idea with that id", 404)
        : json(detail({ referenced_by: { forks: ["f1"], derived: [] } })),
    ),
  );
  render(<IdeaDetail id="child" />);
  await screen.findByRole("heading", { level: 1, name: "A fork of the root" });

  fireEvent.click(screen.getByRole("button", { name: "Delete idea" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete for good" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("no idea with that id");
  // The idea is still on screen: a failed delete does not navigate, and does not wipe the view.
  expect(screen.getByRole("heading", { level: 1, name: "A fork of the root" })).toBeTruthy();
  expect(window.location.hash).not.toBe("#/vault");
});

test("a not_found on the id composes 'this idea no longer exists' with a Vault link — not a crash (T29)", async () => {
  stubFetch(() => Promise.resolve(envelope("not_found", "no idea with that id", 404)));
  render(<IdeaDetail id="child" />);

  expect(await screen.findByText(/no longer exists/i)).toBeTruthy();
  const link = screen.getByRole("link", { name: /vault/i });
  expect(link.getAttribute("href")).toBe("#/vault");
});

test("the first render is a skeletal shimmer — not a spinner (DESIGN.md §4)", () => {
  stubFetch(() => new Promise<Response>(() => {}));
  const { container } = render(<IdeaDetail id="child" />);

  expect(container.querySelector(".card--shimmer")).toBeTruthy();
});
