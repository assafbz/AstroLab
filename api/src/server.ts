import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * The F4 API skeleton (docs/API.md): HTTP/JSON, bearer auth on every `/v1` route, and **one** error
 * envelope. The resource endpoints are the V, O and K issues — none is implemented here — so every
 * `/v1` route that is not implemented answers the `not_found` envelope rather than a 200.
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

function isV1Route(path: string): boolean {
  return path === "/v1" || path.startsWith("/v1/");
}

export function createApp(): Server {
  return createServer((req, res) => {
    try {
      const method = req.method ?? "GET";
      // No query parameter is read in F4 (the contract ignores unknown ones), so the path is enough.
      const path = (req.url ?? "/").split("?")[0] ?? "/";

      if (path === "/healthz" && method === "GET") {
        return sendJson(res, 200, { status: "ok" });
      }

      if (isV1Route(path) && !isAuthorized(req)) {
        return sendError(res, "unauthorized", "missing or invalid bearer token");
      }

      // Nothing else is implemented yet — the resource endpoints are later issues — and it is
      // deliberately not a 200. docs/API.md §2 has no "not implemented" code; `not_found` is the fit.
      return sendError(res, "not_found", `no route for ${method} ${path}`);
    } catch {
      // Last line of defence for "failures are only this envelope" (docs/API.md §2).
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendError(res, "internal_error", "unexpected error");
    }
  });
}
