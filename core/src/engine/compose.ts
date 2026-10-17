import type { DatabaseSync } from "node:sqlite";

import { createAdjudicator } from "./engine/adjudicate.js";
import { createDomainDistance } from "./engine/domain.js";
import { createGate } from "./engine/gate.js";
import { createMechanismCache, EXTRACTOR_VERSION } from "./engine/mechanism.js";
import { createEngineRun, type EngineRun } from "./engine/run.js";
import { createSuppression } from "./engine/suppression.js";
import {
  createAdapterFromEnv,
  DEFAULT_MODEL,
  type AdapterFromEnvOptions,
  type Provider,
} from "./provider/index.js";

/**
 * The composition root (W8 #33, D4): the environment → the adapter → the four stages → the run
 * surface. Every stage up to here shipped **unwired** (W3–W7's sockets); this is the one place they
 * are assembled, so the wiring is a call, not a convention.
 *
 * ## A provider that cannot be built **fails runs, never the boot**
 *
 * `createAdapterFromEnv` throws when `OPENROUTER_API_KEY` is unset or `AI_PROVIDER` is unknown. That
 * must not stop the worker: the queue, the vault and the API are all still useful, and only spark
 * *generation* is unavailable (`FLOW.md` §5.6). So the failure is captured here and re-thrown from the
 * **body** — every run at that boot fails (`FAILED`, §4), which is exactly E4's signal
 * (`GET /v1/sparks/state`), and no run half-writes: a body that throws never reaches its commit.
 *
 * ## The adapter is built once, at boot
 *
 * The provider is constructed here and closed over by the stages; nothing downstream re-reads the env.
 * That is what makes `ADR-0003`'s "re-pointable without a code change" true — the env is read at one
 * site — and it is why the model is resolved beside the adapter that uses it (see `modelFromEnv`).
 *
 * ## The stages, and the dependencies between them
 *
 * | stage | built from |
 * | :-- | :-- |
 * | Stage 1's cache | the provider (`extract`) + the producer identity (`EXTRACTOR_VERSION`, model) |
 * | Axis 1's distance | the provider (`normalizeTag`) — §3.2 step 2's one call per unmapped tag |
 * | Axis 2's gate | the cache + the distance (`§3.1`) |
 * | Stage 2's adjudicator | the provider (`adjudicate`) |
 * | §3.5's re-offer rule | the vault alone — no provider |
 *
 * The **body/commit split** is `createEngineRun`'s (`run.ts`): this module only hands it the stages.
 * Each stage still refuses to write; the commit is the run lifecycle's (`queue.ts`).
 */

/** `createEngineFromEnv`'s inputs: the env to read, and the adapter's own test seams (D4). */
export interface ComposeOptions extends AdapterFromEnvOptions {
  /** Read for `AI_PROVIDER` / `AI_MODEL` / `OPENROUTER_API_KEY`. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * `ADR-0003`'s model (`AI_MODEL`), resolved the way `provider/openrouter.ts`'s `createAdapterFromEnv`
 * resolves it. The descriptor cache's `source_hash` covers the model (`mechanism.ts`), so this must be
 * the model the adapter actually calls — and it is, by construction: the same expression over the same
 * env, with the same `DEFAULT_MODEL` fallback. **One rule, two resolutions**; if that rule ever grows a
 * vendor map or a validation, it belongs on the boundary as an exported helper rather than copied here.
 */
function modelFromEnv(env: Record<string, string | undefined>): string {
  return env.AI_MODEL?.trim() || DEFAULT_MODEL;
}

/**
 * The four stages, composed into the run surface. Nothing here is env-aware; the caller builds the
 * adapter. Exported so a test can drive the **real** wiring over a stub provider (EV4 `#46`'s timed
 * run) rather than re-assembling the stages and proving a composition nothing ships.
 */
export function engineFromProvider(db: DatabaseSync, provider: Provider, model: string): EngineRun {
  const mechanisms = createMechanismCache(db, provider, { version: EXTRACTOR_VERSION, model });
  const distance = createDomainDistance(db, provider);
  return createEngineRun(db, {
    gate: createGate(db, mechanisms, distance),
    suppression: createSuppression(db),
    adjudicator: createAdjudicator(db, provider),
  });
}

/**
 * The boot-survival surface: every run fails with the construction error. The `commit` is a no-op
 * because `runOnce` never reaches it — the body threw first — so this path writes nothing, which is
 * the same guarantee a stale run gets (S2/D7).
 */
function unavailableEngine(err: unknown): EngineRun {
  const error = err instanceof Error ? err : new Error(String(err));
  return {
    body: () => {
      throw error;
    },
    commit: () => {},
  };
}

/**
 * The composition root. **Never throws**: a provider that cannot be built yields a run surface whose
 * every run fails with that error (§5.6 → E4), so the worker still boots.
 */
export function createEngineFromEnv(db: DatabaseSync, options: ComposeOptions = {}): EngineRun {
  const env = options.env ?? process.env;
  try {
    const provider = createAdapterFromEnv(env, {
      transport: options.transport,
      fetchImpl: options.fetchImpl,
    });
    return engineFromProvider(db, provider, modelFromEnv(env));
  } catch (err) {
    return unavailableEngine(err);
  }
}
