import { describe, expect, test } from "vitest";

import { failureCause } from "./failure.js";
import { InvalidOutputError, NoKeyError, ProviderError } from "./types.js";

/**
 * The classifier's table (`provider/failure.ts`; L3 · #166, T4). One arm per E4 cause the surface can
 * render, plus the two "we cannot tell" answers — a failure that carried no information, and a throw
 * that is not a provider failure at all.
 */
describe("a provider failure is classified into the shared vocabulary", () => {
  test("no key / invalid output are their own classes, not messages", () => {
    expect(failureCause(new NoKeyError("no API key is set"))).toBe("no-key");
    expect(failureCause(new InvalidOutputError("the message content is not JSON"))).toBe(
      "invalid-output",
    );
    // Subclass first: `NoKeyError extends ProviderError`, so the order of the arms is load-bearing.
    expect(new NoKeyError("x")).toBeInstanceOf(ProviderError);
  });

  test("a response status names the arm (§4.3)", () => {
    expect(failureCause(new ProviderError("HTTP 401", { status: 401 }))).toBe("invalid-key");
    expect(failureCause(new ProviderError("HTTP 403", { status: 403 }))).toBe("invalid-key");
    expect(failureCause(new ProviderError("HTTP 429", { status: 429 }))).toBe("rate-limited");
    expect(failureCause(new ProviderError("HTTP 500", { status: 500 }))).toBe("unavailable");
    expect(failureCause(new ProviderError("HTTP 404", { status: 404 }))).toBe("unavailable");
  });

  test("the transport's surface decides offline vs browser-blocked", () => {
    expect(failureCause(new ProviderError("transport failed", { network: "offline" }))).toBe(
      "offline",
    );
    expect(failureCause(new ProviderError("transport failed", { network: "cors-blocked" }))).toBe(
      "cors-blocked",
    );
    // The network fact wins over a status: a request that died before a response has no status to read.
    expect(
      failureCause(new ProviderError("transport failed", { network: "offline", status: 502 })),
    ).toBe("offline");
  });

  test("an abort by our own signal is a timeout, by the cause's name", () => {
    expect(
      failureCause(
        new ProviderError("transport timed out after 60000ms", {
          cause: new DOMException("the operation timed out", "TimeoutError"),
        }),
      ),
    ).toBe("timeout");
    expect(
      failureCause(
        new ProviderError("transport failed", { cause: new DOMException("aborted", "AbortError") }),
      ),
    ).toBe("timeout");
  });

  test("anything else is 'unavailable' — never a guess", () => {
    expect(failureCause(new ProviderError("provider returned a body that is not JSON"))).toBe(
      "unavailable",
    );
    expect(failureCause(new Error("a stage threw"))).toBe("unavailable");
    expect(failureCause("a string throw")).toBe("unavailable");
    expect(failureCause(undefined)).toBe("unavailable");
  });
});
