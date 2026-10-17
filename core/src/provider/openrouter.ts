import {
  ADJUDICATION_SCHEMA,
  DESCRIPTOR_SCHEMA,
  TAG_SCHEMA,
  parseAdjudication,
  parseDescriptor,
  parseTagCluster,
  type JsonSchema,
} from "./schema.js";
import {
  ADJUDICATION_SYSTEM,
  EXTRACTION_SYSTEM,
  TAG_NORMALISATION_SYSTEM,
  adjudicationUser,
  extractionUser,
  tagNormalisationUser,
} from "./prompts.js";
import { readKey, type KeyStore } from "./key.js";
import {
  InvalidOutputError,
  ProviderError,
  type ClusterOption,
  type IdeaText,
  type MechanismPair,
  type Provider,
} from "./types.js";

/**
 * The OpenRouter adapter (`ARCHITECTURE.md` §5; `ADR-0003` as amended by `ADR-0006`) — one adapter,
 * three operations.
 *
 * The division of labour: the **adapter** owns the request shape, the privacy pin and output
 * validation; the **transport** owns URL, auth and timeout. That split is what lets the whole required
 * gate run offline with a fake transport — no key, no network (W2's pin 3).
 *
 * **The key is read per request, through the port** (L3 · #166, invariant 13). v1 read
 * `OPENROUTER_API_KEY` once, in a boot-time factory, because the key was the deployment's; now it is
 * the user's, it can be added or rotated mid-session, and the one place that must never happen is a
 * request sent with an empty or stale `Authorization`. So `readKey(store)` runs inside `send`, before
 * the fetch: no key ⇒ `NoKeyError` ⇒ §4's failed call, and nothing leaves the device.
 */

/** ADR-0003's pinned model; a config value, re-pointable without a code change. */
export const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 60_000;

/** The chat-completions body, as far as this boundary uses it. */
export interface ChatRequest {
  model: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  response_format: {
    type: "json_schema";
    json_schema: { name: string; strict: boolean; schema: JsonSchema };
  };
  provider: { zdr: boolean };
}

export interface ChatResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

declare const ZDR_PINNED: unique symbol;

/**
 * A request that has been through `buildRequest`. The brand is what stops a new call path hand-rolling a
 * body: a `Transport` accepts nothing else, so forgetting `provider.zdr` — or any part of the request
 * contract — is a **compile error**, not a discreet privacy regression. (An assertion *inside*
 * `buildRequest` would be a tautology; this is the tooth. `provider.test.ts` guards the single site.)
 */
export type ZdrPinnedRequest = ChatRequest & { readonly [ZDR_PINNED]: true };

/** The seam that makes the gate offline. Real one: `createFetchTransport`. */
export interface Transport {
  send(request: ZdrPinnedRequest): Promise<ChatResponse>;
}

export interface BuildRequestInput {
  model: string;
  schemaName: string;
  schema: JsonSchema;
  system: string;
  user: string;
}

/**
 * The **only** place in this repo that writes `provider: { zdr: true }` — §5's routing control, which
 * restricts a call to OpenRouter's Zero-Data-Retention endpoints. Everything else goes through it.
 */
export function buildRequest(input: BuildRequestInput): ZdrPinnedRequest {
  return {
    model: input.model,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: input.schemaName, strict: true, schema: input.schema },
    },
    provider: { zdr: true },
  } as ZdrPinnedRequest;
}

export interface FetchTransportOptions {
  /** The user's key, read **per request** — never captured at construction (invariant 13). */
  keyStore: KeyStore;
  baseUrl?: string;
  /**
   * Which surface is sending, because the same `fetch` rejection means two different things on two
   * surfaces: a browser that the provider's CORS policy blocks and a device with no connectivity both
   * arrive as one `TypeError`. `native` (the default) tells the user to check their connection; `web`
   * tells them the provider's direct-browser path is the likely cause. Both are one failed call.
   */
  surface?: "native" | "web";
  timeoutMs?: number;
  /** Injected so the transport's own error/timeout mapping is testable with no network and no wait. */
  fetchImpl?: typeof fetch;
  /**
   * Builds one call's abort signal. Injected so a test proves the timeout handling with an
   * `AbortController` it aborts itself — the gate never waits on a wall clock (David's pin).
   */
  signal?: () => AbortSignal;
}

export function createFetchTransport(options: FetchTransportOptions): Transport {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;
  const makeSignal = options.signal ?? (() => AbortSignal.timeout(timeoutMs));
  const surface = options.surface ?? "native";

  return {
    async send(request) {
      // Read first, fetch second: a missing key fails the call here, with no request in flight.
      const key = await readKey(options.keyStore);

      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
          },
          body: JSON.stringify(request),
          signal: makeSignal(),
        });
      } catch (cause) {
        // A timeout, an abort or a network failure is §4's failed call — never a partial result. The
        // two facts the classifier cannot recover later are attached here: *our* signal aborted it
        // (a `TimeoutError`), or the request died before any response on this surface.
        const aborted = cause instanceof Error && cause.name === "TimeoutError";
        throw new ProviderError(
          aborted
            ? `transport timed out after ${timeoutMs}ms`
            : `transport failed: ${describe(cause)}`,
          aborted ? { cause } : { cause, network: surface === "web" ? "cors-blocked" : "offline" },
        );
      }

      if (!response.ok) {
        throw new ProviderError(`provider returned HTTP ${response.status}`, {
          status: response.status,
        });
      }

      try {
        return (await response.json()) as ChatResponse;
      } catch (cause) {
        throw new ProviderError(`provider returned a body that is not JSON: ${describe(cause)}`, {
          cause,
        });
      }
    },
  };
}

export interface OpenRouterAdapterOptions {
  model: string;
  transport: Transport;
}

export function createOpenRouterAdapter({ model, transport }: OpenRouterAdapterOptions): Provider {
  /**
   * The single path every call takes: build the pinned request, send it, validate the answer. Both
   * operations go through here, so *"every call pins ZDR"* is a property of the code rather than of each
   * method's diligence — and validation cannot be skipped on one path.
   */
  async function call<T>(input: {
    schemaName: string;
    schema: JsonSchema;
    system: string;
    user: string;
    parse: (raw: unknown) => T;
  }): Promise<T> {
    const request = buildRequest({
      model,
      schemaName: input.schemaName,
      schema: input.schema,
      system: input.system,
      user: input.user,
    });
    return input.parse(contentOf(await transport.send(request)));
  }

  return {
    extract(idea: IdeaText) {
      return call({
        schemaName: "mechanism_descriptor",
        schema: DESCRIPTOR_SCHEMA,
        system: EXTRACTION_SYSTEM,
        user: extractionUser(idea),
        parse: parseDescriptor,
      });
    },

    adjudicate(ideaA: IdeaText, ideaB: IdeaText, mechanisms: MechanismPair) {
      return call({
        schemaName: "spark_adjudication",
        schema: ADJUDICATION_SCHEMA,
        system: ADJUDICATION_SYSTEM,
        user: adjudicationUser(ideaA, ideaB, mechanisms),
        parse: parseAdjudication,
      });
    },

    normalizeTag(tag: string, clusters: readonly ClusterOption[]) {
      return call({
        schemaName: "domain_cluster",
        schema: TAG_SCHEMA,
        system: TAG_NORMALISATION_SYSTEM,
        user: tagNormalisationUser(tag, clusters),
        // Membership is closed over the offered set, so a hallucinated id fails the call here.
        parse: (raw) => parseTagCluster(raw, new Set(clusters.map((cluster) => cluster.id))),
      });
    },
  };
}

/** The model's message text, as JSON. Anything else is invalid output — never a partial object. */
function contentOf(response: ChatResponse): unknown {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new InvalidOutputError("provider output: the response carries no message content");
  }
  try {
    return JSON.parse(content);
  } catch (cause) {
    throw new InvalidOutputError("provider output: the message content is not JSON", { cause });
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
