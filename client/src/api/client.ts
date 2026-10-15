/**
 * The one API entry point. Every vault call goes through `apiRequest`, so the bearer
 * (`docs/API.md` §1) and the single error envelope (§2) are handled once.
 *
 * The client never encodes a server invariant (`docs/API.md` §0); this module maps what the server
 * returns and nothing more.
 */
export type ApiErrorCode =
  "unauthorized" | "not_found" | "validation_failed" | "conflict" | "internal_error" | "network";

/** The envelope's codes (`docs/API.md` §2), minus `network`, which is client-local. */
const ENVELOPE_CODES: readonly ApiErrorCode[] = [
  "unauthorized",
  "not_found",
  "validation_failed",
  "conflict",
  "internal_error",
];

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  /** The HTTP status; `0` for `network` — there was no response to speak of. */
  readonly status: number;

  constructor(code: ApiErrorCode, status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

/** The bearer for `/v1` (`docs/API.md` §1). Empty when the shell has no token — the server fails closed. */
export function apiToken(): string {
  return import.meta.env.VITE_API_TOKEN ?? "";
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** The body's envelope code, or `internal_error` when the body is not the envelope (`docs/API.md` §2). */
function envelopeCode(body: unknown): ApiErrorCode {
  const code = (body as ErrorEnvelope | null)?.error?.code;
  return ENVELOPE_CODES.find((known) => known === code) ?? "internal_error";
}

/**
 * The headers every `/v1` call carries — built here, once, for the same reason `apiRequest` exists:
 * a second place to state the bearer rule is a second place for it to drift. §1's gate is on the
 * stream too (`docs/API.md` §4.11), and `EventSource` cannot set `Authorization` — so §4.11's caller
 * reaches the route with a `fetch` stream and **these** headers.
 */
export function apiHeaders(
  init: { headers?: HeadersInit; body?: unknown; accept?: string } = {},
): Headers {
  const headers = new Headers(init.headers);
  headers.set("accept", init.accept ?? "application/json");
  const token = apiToken();
  // Omitted when empty, not sent blank: a blank bearer is a `401` either way, and omitting keeps
  // the header's absence the honest signal.
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return headers;
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = apiHeaders({ headers: init.headers, body: init.body });

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError("network", 0, `Could not reach the API at ${path}`);
  }

  const body = await readJson(res);
  if (!res.ok) {
    const message =
      (body as ErrorEnvelope | null)?.error?.message ?? `Request failed (${res.status})`;
    throw new ApiError(envelopeCode(body), res.status, message);
  }
  return body as T;
}
