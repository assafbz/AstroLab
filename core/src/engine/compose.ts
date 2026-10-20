import type { SqliteConnection } from "../store/connection.js";

import { createAdjudicator } from "./adjudicate.js";
import { createDomainDistance } from "./domain.js";
import { createGate } from "./gate.js";
import { createMechanismCache, EXTRACTOR_VERSION } from "./mechanism.js";
import { createEngineRun, type EngineRun } from "./run.js";
import { createSuppression } from "./suppression.js";
import { type Provider } from "../provider/index.js";

/**
 * Wiring the four stages into one run surface (W8 #33, D4) — the app's composition root calls this
 * once, at boot.
 *
 * The stages ship as sockets (W3–W7): this is the one place they are assembled, so the wiring is a
 * call, not a convention. It takes the **provider**, not an environment: since the rebuild the app
 * builds the adapter from the user's `KeyStore` and the model it resolves, and a missing key is a
 * *call-time* failure — never a construction failure — so this function cannot fail a boot
 * (`ARCHITECTURE.md` §5; L3 · #166).
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
 * **`model` must be the model the adapter actually calls.** The descriptor cache's `source_hash`
 * covers it (`mechanism.ts`), so a composition that named a different model would serve the first
 * model's cached descriptor. The caller passes one value to both; there is no second resolution left
 * to disagree with it (v1 resolved it twice, from `AI_MODEL`).
 *
 * The **body/commit split** is `createEngineRun`'s (`run.ts`): this module only hands it the stages.
 * Each stage still refuses to write; the commit is the run lifecycle's (`queue.ts`).
 */
export function engineFromProvider(
  db: SqliteConnection,
  provider: Provider,
  model: string,
): EngineRun {
  const mechanisms = createMechanismCache(db, provider, { version: EXTRACTOR_VERSION, model });
  const distance = createDomainDistance(db, provider);
  return createEngineRun(db, {
    gate: createGate(db, mechanisms, distance),
    suppression: createSuppression(db),
    adjudicator: createAdjudicator(db, provider),
  });
}
