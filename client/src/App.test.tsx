// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { App } from "./App.tsx";

const IDEA = {
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
};

const SPARK_DETAIL = {
  id: "abc",
  direction: "Pair the transit lattice with audio",
  claim: "Scheduling and DSP share a shape.",
  first_step: "Instrument the ingest path before the model runs.",
  what_it_takes: "Two weekends on the ingest path.",
  domain_tags: ["transit"],
  created_at: "2026-10-13T05:14:05Z",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The Vault list and the idea detail read differently; stub by path. */
function stubFetch() {
  const mock = vi.fn((url: string) => {
    if (url.startsWith("/v1/sparks/")) return Promise.resolve(json(SPARK_DETAIL));
    if (url.startsWith("/v1/ideas/")) {
      return Promise.resolve(
        json({
          idea: IDEA,
          versions: [],
          lineage: [],
          provenance: [],
          referenced_by: { forks: [], derived: [] },
        }),
      );
    }
    return Promise.resolve(json({ ideas: [IDEA] }));
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** Render the shell at a hash path. */
function renderAt(hash: string) {
  window.location.hash = hash;
  stubFetch();
  return render(<App />);
}

beforeEach(() => {
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("#/capture renders S2 Capture, not the placeholder", () => {
  renderAt("#/capture");

  expect(screen.getByRole("heading", { level: 1, name: "Capture" })).toBeTruthy();
  expect(screen.queryByText(/not built yet/i)).toBeNull();
});

test("#/capture/<id> renders the seeded S2 Capture, before matchScreen — the Capture tab stays lit (T09)", async () => {
  window.location.hash = "#/capture/abc";
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/inspire")) {
        // §4.14 — the seed the seeded capture prefills from.
        return Promise.resolve(
          json({
            spark_id: "abc",
            direction: "Pair the transit lattice with audio",
            claim: "Scheduling and DSP share a shape.",
            what_it_takes: "Two weekends on the ingest path.",
            first_step: "Instrument the ingest path before the model runs.",
            domain_tags: ["transit"],
          }),
        );
      }
      return Promise.resolve(json({ error: { code: "not_found", message: "no route" } }, 404));
    }),
  );
  render(<App />);

  // The per-id seeded route is resolved *before* `matchScreen` — without that it falls through to the
  // shell's not-found — and it renders the same S2, so the Capture tab stays the active one.
  expect(await screen.findByText("FROM A SPARK")).toBeTruthy();
  expect(screen.getByRole("heading", { level: 1, name: "Capture" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Capture" }).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByText(/not built yet/i)).toBeNull();
});

test("#/vault renders S3 Vault, not the placeholder", async () => {
  renderAt("#/vault");

  expect(await screen.findByRole("heading", { level: 1, name: "Vault" })).toBeTruthy();
  expect(screen.getByRole("link", { name: /A single sentence/ }).getAttribute("href")).toBe(
    "#/ideas/abc",
  );
});

test("#/ideas/<id> renders S4 Idea Detail with the Vault tab active (D8)", async () => {
  renderAt("#/ideas/abc");

  expect(await screen.findByRole("heading", { level: 1, name: "A single sentence" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Vault" }).getAttribute("aria-current")).toBe("page");
});

test("a bare #/ideas composes a 'choose an idea' landing, never blank (D10)", () => {
  renderAt("#/ideas");

  expect(screen.getByText("Choose an idea.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Go to the vault" }).getAttribute("href")).toBe(
    "#/vault",
  );
  expect(screen.getByRole("link", { name: "Vault" }).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByText(/not built yet/i)).toBeNull();
});

test("#/iterate/<id> renders S6 Iterate, before matchScreen — the Vault tab stays lit (V9 #20)", async () => {
  renderAt("#/iterate/abc");

  // The per-id route is resolved *before* `matchScreen` (S6's `SCREENS` entry is the bare
  // `#/iterate`), and S6 is reached from S4, so the Vault tab stays the active one (D8).
  expect(await screen.findByRole("heading", { level: 1, name: "Iterate" })).toBeTruthy();
  expect(screen.getByText("abc")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Vault" }).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByText(/not built yet/i)).toBeNull();
});

test("a bare #/iterate composes a 'choose an idea' landing, never an editor over nothing (V9 #20)", () => {
  renderAt("#/iterate");

  // T22 is S4 → S6: with no id there is no node to refine, and a blank editor would claim otherwise.
  expect(screen.getByText("Choose an idea to refine.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Go to the vault" }).getAttribute("href")).toBe(
    "#/vault",
  );
  expect(screen.getByRole("link", { name: "Vault" }).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByText(/not built yet/i)).toBeNull();
});

/** `#/` is S1 (home). Whichever entry brought the user there, a cold vault lands the E0 composition. */
test("#/ renders S1, and a vault below the floor lands E0 Cold — not a placeholder", async () => {
  window.location.hash = "#/";
  // S1 reads three routes (§4.10, §4.9, §3.2), so the stub routes by path: a cold summary, the
  // engine's own E0, and an empty deck.
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.includes("/v1/sparks/state")) {
        return Promise.resolve(json({ state: "E0", unreviewed: 0, run: null }));
      }
      if (url.includes("/v1/sparks?state=offered")) {
        return Promise.resolve(json({ sparks: [] }));
      }
      return Promise.resolve(
        json({ resolved_domains: 1, provisional_domains: 1, target: 3, floor: 2, eligible: false }),
      );
    }),
  );
  render(<App />);

  const cold = await screen.findByLabelText("Sparks need more domains");
  expect(within(cold).getByText("1 / 3")).toBeTruthy();
  expect(within(cold).getByRole("link", { name: "Add idea" }).getAttribute("href")).toBe(
    "#/capture",
  );
  expect(screen.queryByText(/not built yet/i)).toBeNull();
  // The Sparks tab is the active one: S1 is home, not a screen reached from elsewhere.
  expect(screen.getByRole("link", { name: "Sparks" }).getAttribute("aria-current")).toBe("page");
});

test("tapping a card on the deck opens its detail — the shell follows the hash to S1b (T08)", async () => {
  window.location.hash = "#/";
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/sparks/events")) {
        // A stream that opens and ends: S1 subscribes first (§4.11), and this test drives the tap.
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.close();
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
        );
      }
      if (url.includes("/v1/sparks/state")) {
        return Promise.resolve(json({ state: "E2", unreviewed: 1, run: null }));
      }
      if (url.includes("/v1/sparks?state=offered")) {
        return Promise.resolve(json({ sparks: [SPARK_DETAIL] }));
      }
      if (url.startsWith("/v1/sparks/")) return Promise.resolve(json(SPARK_DETAIL));
      if (url.includes("/v1/vault/summary")) {
        return Promise.resolve(
          json({
            resolved_domains: 3,
            provisional_domains: 0,
            target: 3,
            floor: 2,
            eligible: true,
          }),
        );
      }
      return Promise.resolve(json({ error: { code: "not_found", message: "no route" } }, 404));
    }),
  );
  render(<App />);

  const card = await screen.findByLabelText("Spark");
  fireEvent.pointerDown(card, { clientX: 12, clientY: 20 });
  fireEvent.pointerUp(card, { clientX: 12, clientY: 20 });

  // S1b, read from §4.12 for the tapped id — the deck's tap is the only way in, and nothing is stale
  // from the card it came from (the detail reads its own endpoint).
  expect(
    await screen.findByRole("heading", { level: 1, name: SPARK_DETAIL.direction }),
  ).toBeTruthy();
  expect(window.location.hash).toBe("#/sparks/abc");
});

test("#/sparks/<id> renders S1b Spark Detail, with the Sparks tab active (D8)", async () => {
  renderAt("#/sparks/abc");

  expect(
    await screen.findByRole("heading", { level: 1, name: SPARK_DETAIL.direction }),
  ).toBeTruthy();
  // D8 — S1b has no tab of its own and is reached from the deck, so the Sparks tab stays lit: a screen
  // the user can be on must not read as "nowhere".
  expect(screen.getByRole("link", { name: "Sparks" }).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByText(/not built yet/i)).toBeNull();
});

test("a bare #/sparks is still the not-found fallback — the deck is home, at #/", () => {
  renderAt("#/sparks");

  expect(screen.getByRole("heading", { level: 1, name: "Not found" })).toBeTruthy();
  expect(screen.getByText("No screen at /sparks.")).toBeTruthy();
});

test("#/fork renders S5's parent picker over the vault — the placeholder is gone (V9 #20)", async () => {
  renderAt("#/fork");

  // E3's entry: bare `#/fork` has no parent, so S5 composes the picker rather than forking nothing.
  expect(await screen.findByRole("link", { name: /A single sentence/ })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Vault" }).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByText(/not built yet/i)).toBeNull();
});

test("#/fork/<id> renders S5 seeded with the parent, before matchScreen (V9 #20)", async () => {
  renderAt("#/fork/abc");

  expect(await screen.findByLabelText("Parent idea")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Vault" }).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByText(/not built yet/i)).toBeNull();
});

test("an unknown path is still the not-found fallback, and the tab bar stays", () => {
  renderAt("#/nope");

  expect(screen.getByRole("heading", { level: 1, name: "Not found" })).toBeTruthy();
  expect(screen.getByText("No screen at /nope.")).toBeTruthy();
  expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
});
