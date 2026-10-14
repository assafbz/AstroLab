import { describe, expect, test } from "vitest";

import { DESCRIPTOR_SCHEMA } from "./schema.js";
import {
  DEFAULT_MODEL,
  buildRequest,
  createFetchTransport,
  createOpenRouterAdapter,
  type ChatRequest,
  type ChatResponse,
  type Transport,
  type ZdrPinnedRequest,
} from "./openrouter.js";
import { InvalidOutputError, ProviderError, type IdeaText } from "./types.js";

const idea: IdeaText = {
  hypothesis: "Batch cooking for one",
  problem: "Cooking a single portion wastes a whole evening",
  monetization: "Subscription for weekly batch plans",
};

const descriptorJson = JSON.stringify({
  verb: "batch",
  object_class: "meals",
  constraint: "one cook session",
  transferable_structure: "amortise a fixed cost across many units",
});

const draftJson = JSON.stringify({
  shared_mechanism: "amortising a fixed setup cost",
  direction: "Batch the setup step for CI runs",
  claim: "Both amortise one expensive setup across many units",
  what_it_takes: "A batching scheduler",
  first_step: "Group jobs by setup key",
});

const refusalJson = JSON.stringify({
  shared_mechanism: null,
  direction: null,
  claim: null,
  what_it_takes: null,
  first_step: null,
});

const chatReply = (content: string): ChatResponse => ({ choices: [{ message: { content } }] });

/** A transport that records every request and answers from `respond`. */
function fakeTransport(respond: (request: ChatRequest) => Promise<ChatResponse>): {
  transport: Transport;
  requests: ZdrPinnedRequest[];
} {
  const requests: ZdrPinnedRequest[] = [];
  return {
    requests,
    transport: {
      async send(request) {
        requests.push(request);
        return respond(request);
      },
    },
  };
}

function build(respond: (request: ChatRequest) => Promise<ChatResponse>) {
  const fake = fakeTransport(respond);
  return {
    ...fake,
    provider: createOpenRouterAdapter({ model: "test/model", transport: fake.transport }),
  };
}

describe("buildRequest — the one place the ZDR pin is written (ARCH §5, NFR-PRIV1)", () => {
  const request = buildRequest({
    model: "test/model",
    schemaName: "mechanism_descriptor",
    schema: DESCRIPTOR_SCHEMA,
    system: "system text",
    user: "user text",
  });

  test("pins provider.zdr on the request itself, not at a call site", () => {
    expect(request.provider).toEqual({ zdr: true });
  });

  test("carries the model, the messages and the strict schema", () => {
    expect(request.model).toBe("test/model");
    expect(request.messages).toEqual([
      { role: "system", content: "system text" },
      { role: "user", content: "user text" },
    ]);
    expect(request.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "mechanism_descriptor", strict: true, schema: DESCRIPTOR_SCHEMA },
    });
  });

  test("defaults the model to ADR-0003's pin", () => {
    expect(DEFAULT_MODEL).toBe("deepseek/deepseek-v4-flash");
  });
});

describe("createFetchTransport", () => {
  const request = buildRequest({
    model: "m",
    schemaName: "s",
    schema: DESCRIPTOR_SCHEMA,
    system: "sys",
    user: "usr",
  });

  test("POSTs the pinned body to chat/completions with the bearer token and an abort signal", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const transport = createFetchTransport({
      apiKey: "sk-test",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify(chatReply("{}")), { status: 200 });
      },
    });

    const response = await transport.send(request);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer sk-test",
    });
    expect(JSON.parse(String(call?.init.body))).toEqual(request);
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(response).toEqual(chatReply("{}"));
  });

  test("a non-2xx response is a ProviderError, with no body returned", async () => {
    const transport = createFetchTransport({
      apiKey: "k",
      fetchImpl: async () => new Response("rate limited", { status: 429 }),
    });

    await expect(transport.send(request)).rejects.toBeInstanceOf(ProviderError);
  });

  test("a transport rejection — timeout, abort, network — is a ProviderError", async () => {
    const transport = createFetchTransport({
      apiKey: "k",
      fetchImpl: async () => {
        throw new DOMException("the operation timed out", "TimeoutError");
      },
    });

    await expect(transport.send(request)).rejects.toBeInstanceOf(ProviderError);
  });

  test("a body that is not JSON is a ProviderError", async () => {
    const transport = createFetchTransport({
      apiKey: "k",
      fetchImpl: async () => new Response("<html>nope</html>", { status: 200 }),
    });

    await expect(transport.send(request)).rejects.toBeInstanceOf(ProviderError);
  });

  test("uses the injected signal factory, so the abort path is not a wall-clock race", async () => {
    const controller = new AbortController();
    controller.abort(); // deterministic — nothing waits for a clock
    const seen: RequestInit[] = [];
    const transport = createFetchTransport({
      apiKey: "k",
      signal: () => controller.signal,
      fetchImpl: async (_url, init) => {
        seen.push(init ?? {});
        if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
        return new Response("{}", { status: 200 });
      },
    });

    await expect(transport.send(request)).rejects.toBeInstanceOf(ProviderError);
    expect(seen[0]?.signal).toBe(controller.signal);
  });
});

describe("the ZDR brand — pin 4's teeth", () => {
  test("a hand-rolled request body cannot reach a Transport", () => {
    const { transport } = fakeTransport(async () => chatReply("{}"));
    const handRolled: ChatRequest = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "n", strict: true, schema: DESCRIPTOR_SCHEMA },
      },
      provider: { zdr: true },
    };

    // @ts-expect-error a plain ChatRequest lacks the phantom symbol, and only buildRequest adds it
    const attempt = () => transport.send(handRolled);

    // The assertion is the compile error above, and it cuts both ways: drop the brand and this directive
    // goes unused, which fails typecheck (TS2578). Nothing is sent at runtime.
    expect(typeof attempt).toBe("function");
  });
});

describe("createOpenRouterAdapter — extract (ARCH §3.3 step 1)", () => {
  test("returns the parsed descriptor", async () => {
    const { provider, requests } = build(async () => chatReply(descriptorJson));

    await expect(provider.extract(idea)).resolves.toEqual(JSON.parse(descriptorJson));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.provider).toEqual({ zdr: true });
  });

  test("sends only the idea's own text, never a wider payload", async () => {
    const { provider, requests } = build(async () => chatReply(descriptorJson));

    await provider.extract(idea);

    const user = requests[0]?.messages.find((message) => message.role === "user")?.content ?? "";
    expect(user).toContain(idea.hypothesis);
    expect(user).toContain(idea.problem);
    expect(user).toContain(idea.monetization);
  });

  test("content that is not JSON is an InvalidOutputError, not a partial descriptor", async () => {
    const { provider } = build(async () => chatReply("I think the mechanism is batching."));

    await expect(provider.extract(idea)).rejects.toBeInstanceOf(InvalidOutputError);
  });

  test("JSON that does not satisfy the schema is an InvalidOutputError", async () => {
    const { provider } = build(async () => chatReply(JSON.stringify({ verb: "batch" })));

    await expect(provider.extract(idea)).rejects.toBeInstanceOf(InvalidOutputError);
  });

  test("a response with no message content at all is an InvalidOutputError", async () => {
    const { provider } = build(async () => ({ choices: [] }));

    await expect(provider.extract(idea)).rejects.toBeInstanceOf(InvalidOutputError);
  });

  test("a transport failure propagates as a ProviderError (§4: a failed call)", async () => {
    const { provider } = build(async () => {
      throw new ProviderError("provider returned HTTP 503");
    });

    await expect(provider.extract(idea)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("createOpenRouterAdapter — adjudicate (ARCH §3.3 step 3)", () => {
  test("returns the parsed draft", async () => {
    const { provider, requests } = build(async () => chatReply(draftJson));

    await expect(provider.adjudicate(idea, idea, mechanisms())).resolves.toEqual({
      mechanism: "amortising a fixed setup cost",
      direction: "Batch the setup step for CI runs",
      claim: "Both amortise one expensive setup across many units",
      what_it_takes: "A batching scheduler",
      first_step: "Group jobs by setup key",
    });
    expect(requests[0]?.provider).toEqual({ zdr: true });
  });

  test("a declared refusal is null — a real answer, not an error", async () => {
    const { provider } = build(async () => chatReply(refusalJson));

    await expect(provider.adjudicate(idea, idea, mechanisms())).resolves.toBeNull();
  });

  test("a malformed refusal is an InvalidOutputError, not a silent null", async () => {
    const { provider } = build(async () =>
      chatReply(JSON.stringify({ ...JSON.parse(refusalJson), claim: "a real claim" })),
    );

    await expect(provider.adjudicate(idea, idea, mechanisms())).rejects.toBeInstanceOf(
      InvalidOutputError,
    );
  });

  test("sends both ideas' text and both descriptors", async () => {
    const { provider, requests } = build(async () => chatReply(draftJson));

    await provider.adjudicate(idea, idea, mechanisms());

    const user = requests[0]?.messages.find((message) => message.role === "user")?.content ?? "";
    expect(user).toContain(idea.hypothesis);
    expect(user).toContain("amortise");
  });

  test("every call through both methods carries the pin", async () => {
    const { provider, requests } = build(async (request) =>
      chatReply(
        request.response_format.json_schema.name === "mechanism_descriptor"
          ? descriptorJson
          : draftJson,
      ),
    );

    await provider.extract(idea);
    await provider.adjudicate(idea, idea, mechanisms());

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.provider)).toEqual([{ zdr: true }, { zdr: true }]);
  });
});

function mechanisms() {
  return {
    a: {
      verb: "batch",
      object_class: "meals",
      constraint: "one session",
      transferable_structure: "amortise setup",
    },
    b: {
      verb: "cache",
      object_class: "deps",
      constraint: "slow install",
      transferable_structure: "amortise setup",
    },
  };
}
