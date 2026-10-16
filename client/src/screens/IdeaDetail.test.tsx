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

test("Iterate and Fork are two route changes — never a transport of their own (T22, T24)", async () => {
  renderDetail(detail());

  await screen.findByRole("heading", { level: 1, name: "A fork of the root" });
  // T22 is S4 → S6 and T24 is S4 → S5: both are links the shell resolves (`forkHref` / `iterateHref`),
  // so this screen carries no fork/iterate request of its own.
  expect(screen.getByRole("link", { name: "Iterate" }).getAttribute("href")).toBe(
    "#/iterate/child",
  );
  expect(screen.getByRole("link", { name: "Fork" }).getAttribute("href")).toBe("#/fork/child");
});

test("a fork child whose parent was deleted shows the tombstone — the reference, never resolved (V8 #19 carry)", async () => {
  // §4.8: the child keeps `lineage_parent_id`; §4.5's walk stops, so the chain reads `[]`. Rendering
  // that as-is would claim this idea was always a root.
  const { container } = renderDetail(detail({ lineage: [] }));

  await screen.findByRole("heading", { level: 1, name: "A fork of the root" });
  const nodes = [...container.querySelectorAll(".chain__node")];
  expect(nodes).toHaveLength(2);

  const tombstone = nodes[0] as HTMLElement;
  expect(tombstone.className).toContain("chain__node--tombstone");
  expect(within(tombstone).getByText("root")).toBeTruthy();
  // Shown, never resolved: the id is the only thing left of the parent, and a link would 404.
  expect(within(tombstone).queryByRole("link")).toBeNull();
  expect((nodes[1] as HTMLElement).className).toContain("chain__node--current");
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

test("a needs-completion idea prompts with the field it owes, behind one press — K8 #42", async () => {
  renderDetail(
    detail({
      idea: idea({ id: "child", monetization: "", status: "NEEDS_COMPLETION" }),
      lineage: [],
    }),
  );

  const panel = await screen.findByRole("region", { name: "Needs completion" });
  expect(
    within(panel).getByText("Add the monetization / value angle to put it back in play."),
  ).toBeTruthy();
  expect(within(panel).getByRole("button", { name: "Complete" })).toBeTruthy();
  // The read view is untouched: the four fields are read-only until the edit is opened (stitch §5).
  expect(within(panel).queryByLabelText("Monetization / Value Angle")).toBeNull();
});

test("an active idea shows no completion panel — the prompt is the incomplete case only", async () => {
  const { container } = renderDetail(detail());

  await screen.findByRole("heading", { level: 1, name: "A fork of the root" });
  expect(container.querySelector(".complete")).toBeNull();
  expect(screen.queryByText(/to put it back in play/)).toBeNull();
});

test("Complete → fill → save posts §4.6 and the re-read clears the prompt (T27)", async () => {
  const owed = idea({ id: "child", monetization: "", status: "NEEDS_COMPLETION" });
  const cleared = { ...owed, monetization: "the value angle", status: "ACTIVE" };
  const bodies: unknown[] = [];
  let reads = 0;
  stubFetch((url, init) => {
    if (url.includes("/iterate")) {
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(json(cleared));
    }
    reads += 1;
    return Promise.resolve(json(detail({ idea: reads === 1 ? owed : cleared, lineage: [] })));
  });
  render(<IdeaDetail id="child" />);

  const panel = await screen.findByRole("region", { name: "Needs completion" });
  fireEvent.click(within(panel).getByRole("button", { name: "Complete" }));

  fireEvent.change(screen.getByLabelText("Monetization / Value Angle"), {
    target: { value: "the value angle" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save completion" }));

  // §4.6's request is the four mandatory fields verbatim — the idea's own values, plus the one filled.
  await waitFor(() => expect(bodies).toHaveLength(1));
  expect(bodies[0]).toEqual({
    hypothesis: owed.hypothesis,
    problem: owed.problem,
    monetization: "the value angle",
    domain_tags: owed.domain_tags,
  });

  // The committed save **re-reads** §4.5: the idea answers `ACTIVE`, so the prompt is gone.
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Needs completion" })).toBeNull(),
  );
  expect(screen.queryByText(/needs completion/i)).toBeNull();
});

test("saving a still-incomplete draft shows the inline error and writes nothing (T17's rule, reused)", async () => {
  const owed = idea({ id: "child", monetization: "", status: "NEEDS_COMPLETION" });
  let writes = 0;
  stubFetch((url) => {
    if (url.includes("/iterate")) {
      writes += 1;
      return Promise.resolve(json(owed));
    }
    return Promise.resolve(json(detail({ idea: owed, lineage: [] })));
  });
  render(<IdeaDetail id="child" />);

  const panel = await screen.findByRole("region", { name: "Needs completion" });
  fireEvent.click(within(panel).getByRole("button", { name: "Complete" }));
  fireEvent.click(screen.getByRole("button", { name: "Save completion" }));

  expect(await screen.findByText("Monetization is required")).toBeTruthy();
  expect(writes).toBe(0);
});

test("a rejected save surfaces the envelope and keeps the draft (T29)", async () => {
  const owed = idea({ id: "child", monetization: "", status: "NEEDS_COMPLETION" });
  stubFetch((url) =>
    url.includes("/iterate")
      ? Promise.resolve(envelope("validation_failed", "monetization must not be empty", 422))
      : Promise.resolve(json(detail({ idea: owed, lineage: [] }))),
  );
  render(<IdeaDetail id="child" />);

  const panel = await screen.findByRole("region", { name: "Needs completion" });
  fireEvent.click(within(panel).getByRole("button", { name: "Complete" }));
  fireEvent.change(screen.getByLabelText("Monetization / Value Angle"), {
    target: { value: "m" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save completion" }));

  expect(await screen.findByText("monetization must not be empty")).toBeTruthy();
  expect((screen.getByLabelText("Monetization / Value Angle") as HTMLInputElement).value).toBe("m");
});
