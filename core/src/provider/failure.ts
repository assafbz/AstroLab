import type { RunFailureCause } from "../failure.js";

import { InvalidOutputError, NoKeyError, ProviderError } from "./types.js";

/**
 * The provider's failures, classified into the shared run-failure vocabulary (`FLOW.md` §5.6;
 * `ARCHITECTURE.md` §4.3, §5; L3 · #166, T4).
 *
 * The split it keeps: **the transport reports facts, this module owns the words.** `openrouter.ts`'s
 * transport attaches what it *knows* — an HTTP status, or "the request never got a response, and on
 * this surface that means X" — and every mapping from those facts to a `RunFailureCause` lives here, in
 * one readable table with one test. A second thrower then cannot invent a cause by hand.
 *
 * `../failure.js` is the one specifier these modules import from outside `provider/` — the vocabulary
 * has to be shared with the engine (which writes the row) and the vault (which reports E4) without a
 * `vault → provider` edge, which is exactly why it lives in its own portable module. Named as an
 * exception in `boundary.test.ts`'s sibling rule.
 */
export function failureCause(err: unknown): RunFailureCause {
  if (err instanceof NoKeyError) return "no-key";
  if (err instanceof InvalidOutputError) return "invalid-output";
  if (err instanceof ProviderError) {
    // The transport's own knowledge first: it saw a status, or it saw the request die before a response.
    if (err.network !== undefined) return err.network;
    if (err.status !== undefined) return causeOfStatus(err.status);
    if (isTimeout(err)) return "timeout";
    return "unavailable";
  }
  // A non-provider throw reaching the run body is still a failed run; "unavailable" is the honest
  // word for a failure that carried no information.
  return "unavailable";
}

/** §4.3's arms for a response: the key was rejected, we were throttled, or the provider was down. */
function causeOfStatus(status: number): RunFailureCause {
  if (status === 401 || status === 403) return "invalid-key";
  if (status === 429) return "rate-limited";
  return "unavailable";
}

/**
 * An abort by **our** signal (`AbortSignal.timeout`) is the only thing that throws a `TimeoutError`;
 * a user- or OS-initiated abort is the same shape, and both mean the call did not complete.
 */
function isTimeout(err: ProviderError): boolean {
  const cause = err.cause;
  return cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
}
