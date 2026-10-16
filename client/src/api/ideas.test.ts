import { afterEach, expect, test, vi } from "vitest";

import {
  createIdea,
  deleteIdea,
  forkIdea,
  getIdeaDetail,
  iterateIdea,
  listIdeas,
  vaultQuery,
} from "./ideas.ts";
import type { Idea } from "./types.ts";

const IDEA: Idea = {
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

afterEach(() => vi.unstubAllGlobals());

test("vaultQuery with no filters is empty — no query string at all", () => {
  expect(vaultQuery()).toBe("");
  expect(vaultQuery({})).toBe("");
});

test("vaultQuery composes only the filters it is given", () => {
  expect(vaultQuery({ domain: "fin" })).toBe("?domain=fin");
  expect(vaultQuery({ domain: null, lineage: "FORK" })).toBe("?lineage=FORK");
  expect(vaultQuery({ domain: "fin", lineage: "FORK" })).toBe("?domain=fin&lineage=FORK");
});

test("vaultQuery encodes a tag — the contract's exact match is on the decoded value", () => {
  expect(vaultQuery({ domain: "a b" })).toBe("?domain=a%20b");
});

test("vaultQuery omits an empty-string filter — a present-but-empty value is 422 (§4.4)", () => {
  expect(vaultQuery({ domain: "", lineage: null })).toBe("");
});

test("vaultQuery carries the status slice — K8 #42's needs-completion read (§4.4)", () => {
  expect(vaultQuery({ status: "NEEDS_COMPLETION" })).toBe("?status=NEEDS_COMPLETION");
  expect(vaultQuery({ domain: "fin", status: "ACTIVE" })).toBe("?domain=fin&status=ACTIVE");
  // An absent filter is no restriction; `""` is still never sent, the status field included.
  expect(vaultQuery({ status: null })).toBe("");
  expect(vaultQuery({ status: "" as Idea["status"] })).toBe("");
});

test("listIdeas GETs the collection and returns body.ideas", async () => {
  const fetchMock = stubFetch(() => Promise.resolve(json({ ideas: [IDEA] })));

  await expect(listIdeas({ domain: "fin" })).resolves.toEqual([IDEA]);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe("/v1/ideas?domain=fin");
  expect(init!.method ?? "GET").toBe("GET");
});

test("getIdeaDetail encodes the id in the path", async () => {
  const detail = {
    idea: IDEA,
    versions: [],
    lineage: [],
    provenance: [],
    referenced_by: { forks: [], derived: [] },
  };
  const fetchMock = stubFetch(() => Promise.resolve(json(detail)));

  await expect(getIdeaDetail("a b")).resolves.toEqual(detail);
  expect(fetchMock.mock.calls[0]![0]).toBe("/v1/ideas/a%20b");
});

test("createIdea POSTs the §4.2 body — the seeded pair explicit as null on a blank capture", async () => {
  const fetchMock = stubFetch(() => Promise.resolve(json(IDEA, 201)));
  const input = { hypothesis: "h", problem: "p", monetization: "m", domain_tags: ["fintech"] };

  await expect(createIdea(input)).resolves.toEqual(IDEA);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe("/v1/ideas");
  expect(init!.method).toBe("POST");
  expect(new Headers(init!.headers).get("content-type")).toBe("application/json");
  expect(JSON.parse(init!.body as string)).toEqual({
    ...input,
    origin_spark_id: null,
    decision_id: null,
  });
});

test("deleteIdea sends DELETE to the idea's path", async () => {
  const fetchMock = stubFetch(() => Promise.resolve(json({ deleted: true, id: "x" })));

  await expect(deleteIdea("x")).resolves.toEqual({ deleted: true, id: "x" });
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe("/v1/ideas/x");
  expect(init!.method).toBe("DELETE");
});

test("iterateIdea POSTs the four mandatory fields to {id}/iterate — K8 #42, §4.6", async () => {
  const updated = { ...IDEA, status: "ACTIVE" as const, monetization: "the value angle" };
  const fetchMock = stubFetch(() => Promise.resolve(json(updated)));
  const fields = {
    hypothesis: "h",
    problem: "p",
    monetization: "the value angle",
    domain_tags: ["fintech"],
  };

  await expect(iterateIdea("a b", fields)).resolves.toEqual(updated);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe("/v1/ideas/a%20b/iterate");
  expect(init!.method).toBe("POST");
  expect(new Headers(init!.headers).get("content-type")).toBe("application/json");
  // Exactly the four — §4.6's request is `IdeaFields` verbatim, with no extra key to 422 on.
  expect(JSON.parse(init!.body as string)).toEqual(fields);
});

test("forkIdea POSTs exactly §4.7's two fields to {id}/fork — the frozen request (V9 #20)", async () => {
  const fork = { ...IDEA, id: "new", lineage_kind: "FORK" as const, lineage_parent_id: "9f1c" };
  const fetchMock = stubFetch(() => Promise.resolve(json(fork, 201)));
  const fields = {
    mutation_delta: "Forking this into a compliance scheduler",
    domain_tags: ["compliance"],
  };

  await expect(forkIdea("a b", fields)).resolves.toEqual(fork);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe("/v1/ideas/a%20b/fork");
  expect(init!.method).toBe("POST");
  expect(new Headers(init!.headers).get("content-type")).toBe("application/json");
  // Exactly the two — no `hypothesis`/`problem`/`monetization` key. §4.7 carries no text: the fork's
  // three text fields are the parent's, copied server-side, and a third key here would be a `422`.
  expect(JSON.parse(init!.body as string)).toEqual(fields);
});
