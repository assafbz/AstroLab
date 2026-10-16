import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test, vi } from "vitest";

import { inspireSeed } from "./inspire.ts";
import type { InspireSeed } from "./types.ts";

/** `client/src/` — this file is `client/src/api/inspire.test.ts`. */
const SRC_DIR = fileURLToPath(new URL("../", import.meta.url));

/** Every non-test client module, from its source, as a path relative to `client/src`. */
function clientModules(): { path: string; source: string }[] {
  return readdirSync(SRC_DIR, { recursive: true })
    .map((name) => String(name))
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => ({ path: name, source: readFileSync(join(SRC_DIR, name), "utf8") }));
}

/** A stubbed `fetch` whose calls the test can inspect. */
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

afterEach(() => vi.unstubAllGlobals());

/** §4.14 — §3.4's projection under the payload's own key names. */
const SEED: InspireSeed = {
  spark_id: "1a2b",
  direction: "Pair the transit lattice with audio",
  claim: "Scheduling and DSP share a shape.",
  what_it_takes: "Two weekends on the ingest path, then a week of labelling.",
  first_step: "Instrument the ingest path before the model runs.",
  domain_tags: ["transit", "audio-dsp"],
};

test("inspireSeed POSTs §4.14's route with no body and returns the seed unreshaped", async () => {
  const mock = stubFetch(() => Promise.resolve(json(SEED)));

  expect(await inspireSeed("1a2b")).toEqual(SEED);
  expect(mock).toHaveBeenCalledTimes(1);

  const [url, init] = mock.mock.calls[0]!;
  // §4.14 is a POST-shaped *read* (§4.16's posture): the route reads no body, so none is sent.
  expect(url).toBe("/v1/sparks/1a2b/inspire");
  expect(init!.method).toBe("POST");
  expect(init!.body).toBeUndefined();
});

test("inspireSeed encodes the id, so an opaque id cannot address another route", async () => {
  const mock = stubFetch(() => Promise.resolve(json(SEED)));

  await expect(inspireSeed("a b")).resolves.toEqual(SEED);
  expect(mock.mock.calls[0]![0]).toBe("/v1/sparks/a%20b/inspire");
});

test("a null what_it_takes / first_step is a legacy row and travels as null, never defaulted (§3.4)", async () => {
  // The screen renders them absent rather than a label over nothing, which it can only do if the
  // transport does not helpfully turn the nulls into "" on the way through.
  stubFetch(() => Promise.resolve(json({ ...SEED, what_it_takes: null, first_step: null })));

  const legacy = await inspireSeed("legacy");

  expect(legacy.what_it_takes).toBeNull();
  expect(legacy.first_step).toBeNull();
  expect(legacy.domain_tags).toEqual(SEED.domain_tags);
});

test("inspireSeed surfaces §2's envelope — an unknown id is `not_found`, not an empty seed", async () => {
  stubFetch(() =>
    Promise.resolve(json({ error: { code: "not_found", message: "no such spark" } }, 404)),
  );

  await expect(inspireSeed("0bad")).rejects.toMatchObject({ code: "not_found", status: 404 });
});

test("a refusal that is not a 404 keeps its own code — one envelope path", async () => {
  stubFetch(() =>
    Promise.resolve(json({ error: { code: "unauthorized", message: "no token" } }, 401)),
  );

  await expect(inspireSeed("1a2b")).rejects.toMatchObject({ code: "unauthorized", status: 401 });
});

test("#119 — §4.14 is read from exactly one place, so the seed has one definition to be stale against", () => {
  const modules = clientModules();
  // Non-vacuity: the walk must be reading the client source (and its `.tsx`, not just its `.ts`), and
  // it must *see* the module §4.14 lives in — an empty read would pass the rule below for the wrong
  // reason. This is the same shape as the deck seam's one-call-site guards, one package over.
  const paths = modules.map((module) => module.path);
  expect(paths).toContain("api/inspire.ts");
  expect(paths).toContain("screens/Capture.tsx");
  expect(paths).toContain("App.tsx");

  const readers = modules
    // The module itself defines `inspireSeed(`; the rule is about its **callers**.
    .filter((module) => module.path !== "api/inspire.ts")
    .filter((module) => module.source.includes("inspireSeed("))
    .map((module) => module.path);

  // Plant: add `await inspireSeed(id)` in any other module → a second entry → red.
  expect(readers).toEqual(["screens/Capture.tsx"]);
  // Residual: text, not syntax. A comment or string mentioning `inspireSeed(` in another module
  // false-positives, and a call spelled `inspireSeed (…)` — name and paren apart — false-negatives.
});
