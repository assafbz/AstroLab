import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { captureIdea, NotFoundError, parseCaptureInput, ValidationError } from "./capture.js";
import { deleteIdea } from "./delete.js";
import { getIdeaDetail, listIdeas, parseVaultFilters } from "./ideas.js";
import { vaultSummary } from "./vault-summary.js";

/**
 * The API (docs/API.md): HTTP/JSON, bearer auth on every `/v1` route, and **one** error envelope.
 * F4 shipped the skeleton; V1 (#12) adds the first resource route — `POST /v1/ideas` — and the
 * shared path normaliser the auth gate and the router now both consult.
 */

/** docs/API.md §2 — the whole error vocabulary, and the status each code maps to. */
const STATUS = {
  unauthorized: 401,
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  internal_error: 500,
} as const;

type ErrorCode = keyof typeof STATUS;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * docs/API.md §2 — one shape, for every failure. Never a bare string, never HTML, never a stack trace:
 * that is why every failure path in this file goes through here and not through `sendJson`.
 */
function sendError(
  res: ServerResponse,
  code: ErrorCode,
  message: string,
  details: unknown = null,
): void {
  sendJson(res, STATUS[code], { error: { code, message, details } });
}

/**
 * The token from `Authorization: Bearer <token>`. Rejects rather than merely parses: a missing header,
 * another scheme (`Basic …`), and a blank value all return null.
 */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer[ \t]+(\S.*)$/i.exec(header);
  return match?.[1] ?? null;
}

/**
 * Constant-time compare: the token is a shared secret (ARCHITECTURE.md §9), and `===` on strings leaks
 * length and prefix through timing. Hashing first makes both operands the same width.
 *
 * **Fails closed:** an unset or empty `API_TOKEN` authenticates nothing, so a misconfigured deploy
 * answers 401 rather than opening the vault to everyone.
 */
function isAuthorized(req: IncomingMessage): boolean {
  const expected = process.env.API_TOKEN ?? "";
  const presented = bearerToken(req);
  if (expected === "" || presented === null) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * docs/API.md §1 — the gate and the router must classify the path the *same* way, or one spelling of
 * a `/v1` path can reach a handler without a token. F4 gated on the raw path, and `//v1/ideas` /
 * `/v1%2Fideas` walked past it; this is the one normaliser both now use.
 *
 * **Decode, then collapse — in that order.** `/%2Fv1/ideas` decodes to `//v1/ideas`, which only
 * becomes a `/v1` path if the collapse runs *after* the decode (collapsing first leaves it gated by
 * neither form). A malformed escape (`/v1%`) is caught, not thrown: the path is still classified, so
 * no decode failure can skip the gate or surface as a `500`.
 */
function normalizePath(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  return decoded.replace(/\/{2,}/g, "/");
}

/**
 * The gate's test, deliberately coarser than "a `/v1` route": any path whose first segment *begins*
 * `/v1`. The segment-exact `startsWith("/v1/")` is what let `/v1%` through — a malformed escape that
 * starts with the literal `/v1` and decodes to nothing. Over-gating costs nothing: a path that is
 * not a route is the `404` envelope with a token, `401` without one (§1).
 */
function looksLikeV1(path: string): boolean {
  return path.startsWith("/v1");
}

export interface AppOptions {
  /** The open store. V1's first resource route reads and writes it (docs/API.md §4.2). */
  db: DatabaseSync;
}

export function createApp({ db }: AppOptions): Server {
  return createServer((req, res) => {
    // `handleRequest` catches its own failures; this is only a last resort for a rejection it did
    // not see, so a bug here still answers the envelope rather than hanging the socket.
    handleRequest(req, res, db).catch(() => fail(res, new Error("unexpected error")));
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  db: DatabaseSync,
): Promise<void> {
  try {
    const method = req.method ?? "GET";
    // The path is the raw URL with the query stripped; `normalizePath` then gives the one string the
    // gate and router share. V2 (#13) reads three query parameters (§4.4), split at the *first* `?` so
    // a `?` inside a value stays in the query instead of truncating the path.
    const url = req.url ?? "/";
    const queryAt = url.indexOf("?");
    const rawPath = queryAt === -1 ? url : url.slice(0, queryAt);
    const query = new URLSearchParams(queryAt === -1 ? "" : url.slice(queryAt + 1));
    const path = normalizePath(rawPath);

    // §4.1 — answered *before* the gate, so a missing `API_TOKEN` cannot fail a liveness check.
    if (method === "GET" && path === "/healthz") {
      return sendJson(res, 200, { status: "ok" });
    }

    // §1 — auth before routing, for the whole `/v1` namespace, over *both* spellings: a path is gated
    // if it looks like a `/v1` path raw **or** normalized. Each form catches what the other misses.
    if ((looksLikeV1(rawPath) || looksLikeV1(path)) && !isAuthorized(req)) {
      return sendError(res, "unauthorized", "missing or invalid bearer token");
    }

    // Routing consults the normalized path and nothing else; every other path or method is the
    // `not_found` envelope — there is no third case (§2).
    if (method === "POST" && path === "/v1/ideas") {
      return await handleCapture(req, res, db);
    }

    if (method === "GET" && path === "/v1/ideas") {
      return handleListIdeas(res, db, query);
    }

    // §4.3 — the S0 progress readout. Deterministic and provider-free (`vault-summary.ts`), so it is
    // answered straight from the vault with no filter vocabulary to validate.
    if (method === "GET" && path === "/v1/vault/summary") {
      return sendJson(res, 200, vaultSummary(db));
    }

    const detailId = ideaIdFromPath(path);
    if (detailId !== null) {
      if (method === "GET") return handleIdeaDetail(res, db, detailId);
      // §4.8 — the same `{id}` path, a second method. Everything else still falls through to the
      // envelope below, so an unknown method on a known shape stays `not_found` (§2).
      if (method === "DELETE") return handleDeleteIdea(res, db, detailId);
    }

    return sendError(res, "not_found", `no route for ${method} ${path}`);
  } catch (err) {
    fail(res, err);
  }
}

/** `POST /v1/ideas` (docs/API.md §4.2): validate, then write. Both failures are the envelope. */
async function handleCapture(
  req: IncomingMessage,
  res: ServerResponse,
  db: DatabaseSync,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof ValidationError) {
      return sendError(res, "validation_failed", err.message);
    }
    throw err;
  }
  const input = parseCaptureInput(body); // ValidationError → the outer catch → the 422 envelope
  const idea = captureIdea(db, input); // NotFoundError (unknown spark) → the 404 envelope
  sendJson(res, 201, idea);
}

/** `GET /v1/ideas?domain=&lineage=&status=` (docs/API.md §4.4). Filters validate before any read. */
function handleListIdeas(res: ServerResponse, db: DatabaseSync, query: URLSearchParams): void {
  const filters = parseVaultFilters(query); // ValidationError → the outer catch → the 422 envelope
  sendJson(res, 200, { ideas: listIdeas(db, filters) });
}

/** `GET /v1/ideas/{id}` (docs/API.md §4.5). An unknown id is the `not_found` envelope. */
function handleIdeaDetail(res: ServerResponse, db: DatabaseSync, id: string): void {
  const detail = getIdeaDetail(db, id);
  if (detail === null) return sendError(res, "not_found", `idea ${id} not found`);
  sendJson(res, 200, detail);
}

/**
 * `DELETE /v1/ideas/{id}` (docs/API.md §4.8): orphan-with-warning, so the server never blocks and
 * never asks — §4.5's `referenced_by` is the client's warning, and the delete proceeds either way. An
 * unknown id is the `not_found` envelope, which is also what a repeat delete answers: the id is
 * unknown once the row is gone.
 */
function handleDeleteIdea(res: ServerResponse, db: DatabaseSync, id: string): void {
  if (!deleteIdea(db, id)) return sendError(res, "not_found", `idea ${id} not found`);
  sendJson(res, 200, { deleted: true, id });
}

/**
 * The `{id}` of `/v1/ideas/{id}`, read from the **normalised** path so an encoded spelling routes here
 * too. An empty id (`/v1/ideas/`) or a further segment (`/v1/ideas/a/b`) is not a defined route, which
 * §2 answers as `not_found` — worth recording in §6, because the *client* router resolves `#/vault/`
 * happily, and nothing should "fix" one side to match the other.
 */
const IDEA_DETAIL_PREFIX = "/v1/ideas/";
function ideaIdFromPath(path: string): string | null {
  if (!path.startsWith(IDEA_DETAIL_PREFIX)) return null;
  const id = path.slice(IDEA_DETAIL_PREFIX.length);
  return id === "" || id.includes("/") ? null : id;
}

/** A capture body is a few hundred bytes; a megabyte is a ceiling, not a target. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * §4.2's request body. This is the one place F4's "no body parsing" is lifted, and it is kept to the
 * envelope's vocabulary: a malformed or oversized body is a `422`, not a bare `400`.
 */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(new ValidationError("request body is too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text === "") {
        // No body at all is a missing mandatory field, not a parse error — let validation say so.
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new ValidationError("request body must be valid JSON"));
      }
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/** Map a thrown error to the envelope. Anything unexpected is `internal_error`, never a stack trace. */
function fail(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof ValidationError) {
    return sendError(res, "validation_failed", err.message);
  }
  if (err instanceof NotFoundError) {
    return sendError(res, "not_found", err.message);
  }
  return sendError(res, "internal_error", "unexpected error");
}
