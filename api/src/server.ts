import { createServer, type Server } from "node:http";

// F1 = delivery spine only. The /v1 routes, bearer auth and the error envelope are F4
// (docs/API.md); the store is F2/F3. Kept separate from index.ts so it is testable
// without binding a real port at import time.
export function createApp(): Server {
  return createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "api" }));
  });
}
