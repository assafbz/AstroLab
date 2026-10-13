import type { Server } from "node:http";

import { afterAll, beforeAll, expect, test } from "vitest";

import { createApp } from "./server.js";

// Proves the test runner is wired — the harness F3's invariant tests and the EV1-EV7
// evidence issues land on (deps: F1). Deliberately tiny.
let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => server.close());

test("api stub answers 200 with its identity", async () => {
  const res = await fetch(`${base}/`);
  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toEqual({ ok: true, service: "api" });
});
