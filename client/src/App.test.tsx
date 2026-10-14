// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The Vault list and the idea detail read differently; stub by path. */
function stubFetch() {
  const mock = vi.fn((url: string) => {
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

/** `#/` is S1 (home). Whichever entry brought the user there, a cold vault lands the E0 composition. */
test("#/ renders S1, and a vault below the floor lands E0 Cold — not a placeholder", async () => {
  window.location.hash = "#/";
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        json({ resolved_domains: 1, provisional_domains: 1, target: 3, floor: 2, eligible: false }),
      ),
    ),
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

test("a screen V8 does not build still renders its placeholder", () => {
  renderAt("#/fork");

  expect(screen.getByText("S5 · Fork")).toBeTruthy();
  expect(screen.getByText(/not built yet/i)).toBeTruthy();
});

test("an unknown path is still the not-found fallback, and the tab bar stays", () => {
  renderAt("#/nope");

  expect(screen.getByRole("heading", { level: 1, name: "Not found" })).toBeTruthy();
  expect(screen.getByText("No screen at /nope.")).toBeTruthy();
  expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
});
