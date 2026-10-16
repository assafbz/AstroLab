import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { currentVaultRevision, enqueueRun } from "@astrolab/store";

import {
  captureIdea,
  ConflictError,
  NotFoundError,
  parseCaptureInput,
  parseIdeaFields,
  ValidationError,
} from "./capture.js";
import { parseDecisionInput, resolveDecision } from "./decision.js";
import { deleteIdea } from "./delete.js";
import { engineState } from "./engine-state.js";
import { exportVault } from "./export.js";
import { forkIdea, parseForkInput } from "./fork.js";
import { getIdeaDetail, listIdeas, parseVaultFilters } from "./ideas.js";
import { iterateIdea } from "./iterate.js";
import { handleSparkEvents, type SparkEventsOptions } from "./spark-events.js";
import { listOfferedSparks, parseSparkQuery, sparkDetail } from "./sparks.js";
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
  /**
   * A **second, read-only** handle on the same database file, used only to sample `PRAGMA
   * data_version` for the SSE stream (docs/API.md §4.11, K1 `#35`). A connection is blind to its own
   * commit, so the sampler cannot be `db` — it must see the API's own writes (§4.16's run enqueue,
   * every `vaultMutation`) as well as the worker's. It never writes. Defaults to `db`, which is only
   * correct for `:memory:` (a test-only path: a second handle there is a different database);
   * `api/src/index.ts` always passes a distinct handle.
   */
  watchDb?: DatabaseSync;
  /** Test affordances for the SSE sampler's cadence and heartbeat; production uses the defaults. */
  sparkEvents?: SparkEventsOptions;
}

export function createApp({ db, watchDb = db, sparkEvents }: AppOptions): Server {
  return createServer((req, res) => {
    // `handleRequest` catches its own failures; this is only a last resort for a rejection it did
    // not see, so a bug here still answers the envelope rather than hanging the socket.
    handleRequest(req, res, db, watchDb, sparkEvents).catch(() =>
      fail(res, new Error("unexpected error")),
    );
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  db: DatabaseSync,
  watchDb: DatabaseSync,
  sparkEvents?: SparkEventsOptions,
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

    // §4.9 — the deck read (S1, K1 #35). `state` is **required** and only `offered` validates, so the
    // query is validated **before** any row is read (the §4.6 posture: the body contract first, then the
    // store). `Spark` carries no `status`, which is why "no restriction" is not an option here — the
    // reading is recorded at §4.9.
    if (method === "GET" && path === "/v1/sparks") {
      parseSparkQuery(query); // ValidationError → the outer catch → the 422 envelope
      return sendJson(res, 200, { sparks: listOfferedSparks(db) });
    }

    // §4.10 — the engine state (S1): E0–E4 from one place (`engine-state.ts`). Provider-free, so the
    // readout answers while the engine is down — which is the state it exists to report (E4).
    if (method === "GET" && path === "/v1/sparks/state") {
      return sendJson(res, 200, engineState(db));
    }

    // §4.11 — the run-progress SSE stream (S1, K1 `#35`). The handler owns the response from here:
    // it flushes headers and never returns a JSON body, so it is *not* awaited and must not throw.
    if (method === "GET" && path === "/v1/sparks/events") {
      return handleSparkEvents(req, res, db, watchDb, sparkEvents);
    }

    // §4.16 — Recompute: enqueue a run at the current revision and answer immediately (NFR-P1: the
    // request never waits on the engine). **No body is read** — there is nothing to validate — and no
    // stamp: the revision belongs to the *mutation* that changed the vault, not to a recompute, which
    // runs at the revision it finds. `enqueueRun` is idempotent per revision, so a repeated call at
    // one stamp returns the same run.
    if (method === "POST" && path === "/v1/sparks/run") {
      const run = enqueueRun(db, currentVaultRevision(db));
      return sendJson(res, 202, { run_id: run.id, vault_revision: run.vault_revision });
    }

    // §4.12 — the spark detail (S1b, #118). The `{id}` shape is matched **after** the exact spark
    // routes above, so `state` / `events` / `run` are never read as a detail id; a further segment
    // (`…/decision`, §4.13, K6 #39) or a non-`GET` method falls to the envelope below. An unknown id is
    // §2's `not_found` — and it is the **only** 404 here: the read is status-blind, so a resolved spark
    // still answers `200` (§3.3/§3.4 carry no `status`).
    const sparkId = sparkPath(path);
    if (sparkId !== null && method === "GET") {
      return handleSparkDetail(res, db, sparkId);
    }

    // §4.13 — the resolution (S1's ACCEPT/DISMISS, K4 `#38`). Matched *after* the exact spark routes
    // and after the one-segment `{id}` shape, whose matcher refuses this deeper path; a nested id
    // (`…/decision/x`) or a non-`POST` method falls to the envelope below (§2). The write is the
    // envelope's other half: `422` for the body, `404` for an unknown spark, `409` for a spark that is
    // not a live offer or a `decision_id` committed elsewhere.
    const decisionSparkId = sparkDecisionPath(path);
    if (decisionSparkId !== null && method === "POST") {
      return await handleDecision(req, res, db, decisionSparkId);
    }

    // §4.17 — the open, complete export (V6 `#17`; NFR-D1, ARCH §8). A `GET` only: the document is the
    // whole vault in one read, so there is nothing to validate and no body is read. The read is the
    // export's own — one `BEGIN`…`COMMIT` snapshot inside `exportVault` (§4.5's shared `readSnapshot`),
    // read-only and provider-free — so the handler does no more than hand the document back. §4.17's
    // body *is* the eight-key document, not a wrapper: the keys are top-level, as the contract shows.
    if (method === "GET" && path === "/v1/export") {
      return sendJson(res, 200, exportVault(db));
    }

    // §4.6 — the same `{id}` path with an action segment. The dispatch is by method *and* action, so
    // a `GET`/`DELETE` on `…/iterate`, or a `POST` on the detail path, is the envelope below (§2).
    const ideas = ideaPath(path);
    if (ideas !== null) {
      if (ideas.action === "iterate") {
        if (method === "POST") return await handleIterate(req, res, db, ideas.id);
      } else if (ideas.action === "fork") {
        if (method === "POST") return await handleFork(req, res, db, ideas.id);
      } else {
        if (method === "GET") return handleIdeaDetail(res, db, ideas.id);
        // §4.8 — the same `{id}` path, a second method. Everything else still falls through to the
        // envelope below, so an unknown method on a known shape stays `not_found` (§2).
        if (method === "DELETE") return handleDeleteIdea(res, db, ideas.id);
      }
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

/**
 * `POST /v1/ideas/{id}/iterate` (docs/API.md §4.6): validate, then write — both failures the envelope.
 * The body is validated **before** the id is looked up, so an unknown id with a malformed body is
 * `422`: the body contract is checked before any row is consulted, exactly as at capture (§4.2), and
 * recorded in §6.
 */
async function handleIterate(
  req: IncomingMessage,
  res: ServerResponse,
  db: DatabaseSync,
  id: string,
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
  const fields = parseIdeaFields(body); // ValidationError → the outer catch → the 422 envelope
  const idea = iterateIdea(db, id, fields); // NotFoundError (unknown id) → the 404 envelope
  sendJson(res, 200, idea);
}

/**
 * `POST /v1/ideas/{id}/fork` (docs/API.md §4.7): validate, then write — both failures the envelope. As
 * at §4.2/§4.6, the body is validated **before** the id is looked up, so an unknown id with a malformed
 * body is `422`; the write then answers `404` (unknown id) before `409` (same domain).
 */
async function handleFork(
  req: IncomingMessage,
  res: ServerResponse,
  db: DatabaseSync,
  id: string,
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
  const input = parseForkInput(body); // ValidationError → the outer catch → the 422 envelope
  const idea = forkIdea(db, id, input); // NotFoundError → 404; ConflictError → 409
  sendJson(res, 201, idea); // §4.7 — a fork creates, so 201
}

/** `GET /v1/ideas/{id}` (docs/API.md §4.5). An unknown id is the `not_found` envelope. */
function handleIdeaDetail(res: ServerResponse, db: DatabaseSync, id: string): void {
  const detail = getIdeaDetail(db, id);
  if (detail === null) return sendError(res, "not_found", `idea ${id} not found`);
  sendJson(res, 200, detail);
}

/** `GET /v1/sparks/{id}` (docs/API.md §4.12). An unknown id is the `not_found` envelope. */
function handleSparkDetail(res: ServerResponse, db: DatabaseSync, id: string): void {
  const detail = sparkDetail(db, id);
  if (detail === null) return sendError(res, "not_found", `spark ${id} not found`);
  sendJson(res, 200, detail);
}

/**
 * `POST /v1/sparks/{id}/decision` (docs/API.md §4.13): validate, then resolve — both failures the
 * envelope. The body is validated **before** the id is consulted, as at §4.2/§4.6/§4.7, so a malformed
 * body on an unknown spark is `422` and not `404`; the write then answers `404` (unknown spark) before
 * `409` (not a live offer, or a `decision_id` committed to another spark). The order is recorded in
 * §4.13 and §6, and pinned in `server.test.ts` so it cannot silently flip.
 */
async function handleDecision(
  req: IncomingMessage,
  res: ServerResponse,
  db: DatabaseSync,
  id: string,
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
  const input = parseDecisionInput(body); // ValidationError → the outer catch → the 422 envelope
  const decision = resolveDecision(db, id, input); // NotFoundError → 404; ConflictError → 409
  sendJson(res, 200, decision);
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
 * The shapes under `/v1/ideas/`, read from the **normalised** path so an encoded spelling routes here
 * too: `{id}` (detail, delete), `{id}/iterate` (§4.6) and `{id}/fork` (§4.7). An empty id
 * (`/v1/ideas/`), a further segment (`/v1/ideas/a/b`), or any other action segment is not a defined
 * route, which §2 answers as `not_found` — worth recording in §6, because the *client* router resolves
 * `#/vault/` happily, and nothing should "fix" one side to match the other.
 */
const IDEA_DETAIL_PREFIX = "/v1/ideas/";
function ideaPath(path: string): { id: string; action: "iterate" | "fork" | null } | null {
  if (!path.startsWith(IDEA_DETAIL_PREFIX)) return null;
  const [id, action, ...extra] = path.slice(IDEA_DETAIL_PREFIX.length).split("/");
  if (id === undefined || id === "" || extra.length > 0) return null;
  if (action === undefined) return { id, action: null };
  return action === "iterate" || action === "fork" ? { id, action } : null;
}

/**
 * The `{id}` shape under `/v1/sparks/`, read from the **normalised** path like `ideaPath` (#118,
 * §4.12). Exactly one non-empty segment, and never a **reserved** one: `state` (§4.10), `events`
 * (§4.11) and `run` (§4.16) are routes, so no reserved name is ever read as a spark id — on *any*
 * method. (#118's clause claimed that; it held for `POST /run` only, because `state`/`events`/`run`
 * were matched by the router ahead of this shape and `run` is claimed for `POST` alone. Max found it
 * at #127's review: `GET /v1/sparks/run` read `run` as an id. Refusing the segment here is what makes
 * the clause literally true, and it costs only the accident it removes — ids are `randomUUID()`.)
 *
 * A further segment (`…/decision`, §4.13 — matched separately below) and an empty id (`/v1/sparks/`)
 * are not defined routes, which §2 answers as `not_found`.
 */
const SPARK_DETAIL_PREFIX = "/v1/sparks/";
const RESERVED_SPARK_SEGMENTS: ReadonlySet<string> = new Set(["state", "events", "run"]);

function sparkPath(path: string): string | null {
  if (!path.startsWith(SPARK_DETAIL_PREFIX)) return null;
  const [id, ...extra] = path.slice(SPARK_DETAIL_PREFIX.length).split("/");
  if (id === undefined || id === "" || extra.length > 0) return null;
  return RESERVED_SPARK_SEGMENTS.has(id) ? null : id;
}

/**
 * §4.13's `POST /v1/sparks/{id}/decision` (K4 `#38`) — one non-empty, unreserved segment and the
 * exact action. `/v1/sparks/{id}/decision/x`, `/v1/sparks/decision` and `/v1/sparks/run/decision` are
 * not this route; each falls to the envelope (§2), the `not_found` rule the deeper shapes already
 * follow.
 */
const SPARK_DECISION_ACTION = "/decision";

function sparkDecisionPath(path: string): string | null {
  if (!path.startsWith(SPARK_DETAIL_PREFIX)) return null;
  const rest = path.slice(SPARK_DETAIL_PREFIX.length);
  if (!rest.endsWith(SPARK_DECISION_ACTION)) return null;
  const id = rest.slice(0, -SPARK_DECISION_ACTION.length);
  if (id === "" || id.includes("/") || RESERVED_SPARK_SEGMENTS.has(id)) return null;
  return id;
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
  if (err instanceof ConflictError) {
    return sendError(res, "conflict", err.message);
  }
  return sendError(res, "internal_error", "unexpected error");
}
