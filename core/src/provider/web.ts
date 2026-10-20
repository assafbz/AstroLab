import type { RunFailureCause } from "../failure.js";

/**
 * Which providers the **web** target can call directly, and what a browser needs to do it
 * (`ARCHITECTURE.md` §5, §9; L3 · #166, T3).
 *
 * Native reaches a provider over the device's own network, so there is nothing to declare. A browser
 * cannot: the call is a cross-origin `fetch`, and whether it is *allowed* is the provider's policy, not
 * ours. Two consequences the app must not discover at runtime:
 *
 * 1. A provider may need an explicit opt-in header before it will serve a browser origin at all —
 *    Anthropic's is `anthropic-dangerous-direct-browser-access`, and the name is the point: it tells
 *    the provider you accept that a browser-held key is exposed to the origin.
 * 2. A provider with **no** browser path must be marked native-only **with a reason**, so the app can
 *    say so in the E4 arm instead of surfacing an opaque CORS failure as "no connection".
 *
 * The surface's second limit is not a header at all and is not here: `expo-sqlite`'s sync API needs a
 * cross-origin-isolated context and caps a sync result at 1 MiB (plan invariants 10, and
 * `core/test/boundary-node-adapter.test.ts`'s device-posture claims).
 */
export interface WebReach {
  /** Extra headers a browser origin must send. Empty when the provider serves browsers as-is. */
  headers: Record<string, string>;
}

export interface NativeOnly {
  /** Why there is no browser path — user-visible copy, not a log line. */
  nativeOnly: string;
}

/**
 * The known providers. **Only `openrouter` has an adapter today** (`ADR-0003`; it is the provider the
 * engine's prompts and the W9 calibration are against) — the other rows are here because their browser
 * posture is a documented fact of the design rather than something to discover when the target list
 * grows.
 */
const REACH: Record<string, WebReach> = {
  openrouter: { headers: {} },
  openai: { headers: {} },
  anthropic: { headers: { "anthropic-dangerous-direct-browser-access": "true" } },
};

/**
 * What the web target must know about `provider`: the headers to send, or the reason it cannot be
 * called from a browser. An **unknown** provider is native-only — the honest default, because we have
 * verified no browser path for it; guessing "open CORS" is how a user ends up with a failure the app
 * cannot explain.
 */
export function webReachFor(provider: string): WebReach | NativeOnly {
  const known = REACH[provider.trim().toLowerCase()];
  if (known !== undefined) return known;
  return {
    nativeOnly: `no browser path is known for "${provider}": its CORS policy has not been verified`,
  };
}

/** The failure the app shows for a native-only provider on web — one E4 arm, one word from the vocabulary. */
export const NATIVE_ONLY_CAUSE: RunFailureCause = "cors-blocked";
