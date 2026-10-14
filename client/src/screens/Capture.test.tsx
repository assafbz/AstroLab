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
