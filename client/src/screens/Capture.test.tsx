// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { Capture } from "./Capture.tsx";

const IDEA = {
  id: "9f1c",
  hypothesis: "A single sentence",
  problem: "p",
  monetization: "m",
  domain_tags: ["fintech"],
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

const save = () => fireEvent.click(screen.getByRole("button", { name: "Save to vault" }));
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

function addDomain(value: string) {
  type("Domain tag(s)", value);
  fireEvent.click(screen.getByRole("button", { name: "+ add domain" }));
}

function fillValidDraft() {
  type("Core Hypothesis", "A single sentence");
  type("Problem Solved", "the friction");
  type("Monetization / Value Angle", "the value angle");
  addDomain("fintech");
}

/** §4.14 — the seed `#/capture/<id>` prefills from. */
const SEED = {
  spark_id: "abc",
  direction: "Pair the transit lattice with audio",
  claim: "Scheduling and DSP share a shape.",
  what_it_takes: "Two weekends on the ingest path.",
  first_step: "Instrument the ingest path before the model runs.",
  domain_tags: ["transit", "audio-dsp"],
};

/**
 * A `fetch` stub for the **seeded** capture: §4.14's read, then §4.2's write. An `override` sees each
 * call first (returning a response hijacks it), so a test can fail exactly one of the two.
 */
function stubSeededFetch(
  override?: (url: string, init?: RequestInit) => Promise<Response> | undefined,
) {
  const mock = vi.fn((url: string, init?: RequestInit) => {
    const hijacked = override?.(url, init);
    if (hijacked) return hijacked;
    if (url.includes("/inspire")) return Promise.resolve(json(SEED));
    if (url === "/v1/ideas") return Promise.resolve(json(IDEA, 201));
    return Promise.resolve(json({ error: { code: "not_found", message: "no route" } }, 404));
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** The idea-write bodies the screen sent, in call order. */
function savedBodies(mock: ReturnType<typeof stubSeededFetch>): Record<string, unknown>[] {
  return mock.mock.calls
    .filter((call) => String(call[0]) === "/v1/ideas")
    .map((call) => JSON.parse(String(call[1]?.body ?? "{}")) as Record<string, unknown>);
}

beforeEach(() => {
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("saving with an empty hypothesis shows the error under that field and sends nothing (T17)", () => {
  const fetchMock = stubFetch(() => Promise.resolve(json(IDEA, 201)));
  render(<Capture />);

  save();

  const group = screen.getByLabelText("Core Hypothesis").closest(".field") as HTMLElement;
  expect(within(group).getByText("Hypothesis is required")).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("the counter is mono `n / 280`, turns Destructive past the limit, and the save is blocked (Review Focus 4)", () => {
  const fetchMock = stubFetch(() => Promise.resolve(json(IDEA, 201)));
  render(<Capture />);
  fillValidDraft();

  type("Core Hypothesis", "x".repeat(281));
  const counter = screen.getByText("281 / 280");
  expect(counter.className).toContain("counter--over");

  save();

  expect(screen.getByText("Hypothesis exceeds 280 characters")).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("exactly 280 passes the block", async () => {
  const fetchMock = stubFetch(() => Promise.resolve(json(IDEA, 201)));
  render(<Capture />);
  fillValidDraft();

  type("Core Hypothesis", "x".repeat(280));
  expect(screen.getByText("280 / 280").className).not.toContain("counter--over");

  save();

  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
});

test("a valid draft POSTs the §4.2 body and sends the user to the created idea's detail (D3)", async () => {
  const fetchMock = stubFetch(() => Promise.resolve(json(IDEA, 201)));
  render(<Capture />);
  fillValidDraft();

  save();

  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe("/v1/ideas");
  expect(init!.method).toBe("POST");
  expect(JSON.parse(init!.body as string)).toEqual({
    hypothesis: "A single sentence",
    problem: "the friction",
    monetization: "the value angle",
    domain_tags: ["fintech"],
    origin_spark_id: null,
    decision_id: null,
  });
  await waitFor(() => expect(window.location.hash).toBe("#/ideas/9f1c"));
});

test("a domain entry is normalised before it becomes a chip and before it is sent (Review Focus 5)", async () => {
  const fetchMock = stubFetch(() => Promise.resolve(json(IDEA, 201)));
  render(<Capture />);
  type("Core Hypothesis", "h");
  type("Problem Solved", "p");
  type("Monetization / Value Angle", "m");

  addDomain(" #FinTech ");

  expect(screen.getByText("fintech")).toBeTruthy();
  save();

  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).domain_tags).toEqual(["fintech"]);
});

test("a 422 envelope renders inline, not a crash", async () => {
  stubFetch(() =>
    Promise.resolve(
      json(
        {
          error: {
            code: "validation_failed",
            message: "hypothesis exceeds 280 characters",
            details: null,
          },
        },
        422,
      ),
    ),
  );
  render(<Capture />);
  fillValidDraft();

  save();

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("exceeds 280 characters");
  expect(screen.getByRole("button", { name: "Save to vault" })).toBeTruthy();
});

test("a seeded capture reads §4.14 and prefills the four fields, with T09's banner (S2 from INSPIRE)", async () => {
  const mock = stubSeededFetch();
  render(<Capture sparkId="abc" />);

  expect(await screen.findByText("FROM A SPARK")).toBeTruthy();
  expect(screen.getByText("Seeded from a spark — make it yours.")).toBeTruthy();

  // The seed map (§4.14 → Capture's four fields): direction→hypothesis, claim→problem, monetization
  // blank (the spark carries none), tags as given (the server folded the union — no re-derivation).
  expect((screen.getByLabelText("Core Hypothesis") as HTMLInputElement).value).toBe(SEED.direction);
  expect((screen.getByLabelText("Problem Solved") as HTMLInputElement).value).toBe(SEED.claim);
  expect((screen.getByLabelText("Monetization / Value Angle") as HTMLInputElement).value).toBe("");
  expect([...document.querySelectorAll(".chip__label")].map((node) => node.textContent)).toEqual(
    SEED.domain_tags,
  );

  // It reads **its own** route by id — not §4.12's detail, not the deck's §4.9/§4.10.
  expect(mock.mock.calls.map((call) => String(call[0]))).toEqual(["/v1/sparks/abc/inspire"]);
});

test("a seeded save POSTs §4.2's pair — its own decision_id — and lands on the created idea's detail (T16)", async () => {
  const mock = stubSeededFetch();
  render(<Capture sparkId="abc" />);
  await screen.findByText("FROM A SPARK");

  // Only monetization is missing: the prefill leaves exactly that field for the user (§4.2 validation).
  type("Monetization / Value Angle", "the value angle");
  save();

  await waitFor(() => expect(window.location.hash).toBe("#/ideas/9f1c"));
  const [body] = savedBodies(mock);
  expect(body!.origin_spark_id).toBe("abc");
  // §2.2 — a real client-generated key, not a literal: the id a Retry would have to re-issue.
  expect(body!.decision_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  expect(body!.hypothesis).toBe(SEED.direction);
  expect(body!.problem).toBe(SEED.claim);
  expect(body!.domain_tags).toEqual(SEED.domain_tags);
});

test("a retry after a failed seeded save re-issues the SAME decision_id (§2.2 N4 — never regenerated)", async () => {
  let saves = 0;
  const mock = stubSeededFetch((url) => {
    if (url !== "/v1/ideas") return undefined;
    saves += 1;
    // A rejected `fetch` is the `network` code — the T29 case the notice exists for.
    return saves === 1 ? Promise.reject(new Error("dropped")) : Promise.resolve(json(IDEA, 201));
  });
  render(<Capture sparkId="abc" />);
  await screen.findByText("FROM A SPARK");
  type("Monetization / Value Angle", "m");

  save();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Nothing was recorded");

  fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(window.location.hash).toBe("#/ideas/9f1c"));

  const bodies = savedBodies(mock);
  expect(bodies).toHaveLength(2);
  // §2.2 N4: the retry is the *same* decision — a second key would make it a second decision.
  expect(bodies[1]!.decision_id).toBe(bodies[0]!.decision_id);
});

test("a 409 is non-destructive and carries no Retry — the spark is spoken for, so a Retry would loop", async () => {
  stubSeededFetch((url) =>
    url === "/v1/ideas"
      ? Promise.resolve(json({ error: { code: "conflict", message: "spark is not OFFERED" } }, 409))
      : undefined,
  );
  render(<Capture sparkId="abc" />);
  await screen.findByText("FROM A SPARK");
  type("Monetization / Value Angle", "m");

  save();

  const alert = await screen.findByRole("alert");
  // It does **not** say "nothing was recorded": in the reload case the first attempt did commit.
  expect(alert.textContent).toMatch(/already resolved/i);
  expect(within(alert).queryByRole("button", { name: "Retry" })).toBeNull();
  // Non-destructive: the form and the draft stay put.
  expect((screen.getByLabelText("Core Hypothesis") as HTMLInputElement).value).toBe(SEED.direction);
  expect(window.location.hash).not.toBe("#/ideas/9f1c");
});

test("an unknown spark on the seed read is the missing state with a way back — not an error to retry", async () => {
  stubSeededFetch((url) =>
    url.includes("/inspire")
      ? Promise.resolve(json({ error: { code: "not_found", message: "no such spark" } }, 404))
      : undefined,
  );
  render(<Capture sparkId="0bad" />);

  expect(await screen.findByText("This spark is not here.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Back to Sparks" }).getAttribute("href")).toBe("#/");
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

test("a failed seed read offers a retry that recovers in place", async () => {
  let reads = 0;
  stubSeededFetch((url) => {
    if (!url.includes("/inspire")) return undefined;
    reads += 1;
    return reads === 1
      ? Promise.resolve(json({ error: { code: "internal_error", message: "boom" } }, 500))
      : Promise.resolve(json(SEED));
  });
  render(<Capture sparkId="abc" />);

  expect(await screen.findByText("Couldn’t load this spark.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));

  expect(await screen.findByText("FROM A SPARK")).toBeTruthy();
  expect(reads).toBe(2);
});
