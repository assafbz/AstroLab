import type { ApiError } from "../api/client.ts";
import type { Decision } from "../api/types.ts";
import type { ResolutionKind } from "./deck-interaction.ts";

/**
 * The deck's **decision identity** (`FLOW.md` §2.2 / N4, §4.3 / H4; `docs/API.md` §4.13).
 *
 * §4.13 is idempotent on a client-generated `decision_id`, and §2.2 makes the client the owner of that
 * key: *"The client persists the `decision_id` and reuses the same one on retry — it must not regenerate
 * it, or the retry becomes a second decision."* This module is that ownership and nothing else. It
 * sends no request of its own — `post` is injected, the way `run-trigger.ts` takes `enqueue` — so it is
 * pure policy: no React, no `fetch`, no clock.
 *
 * Three rules, each a reading:
 *
 * 1. **One key per decision, never regenerated (§2.2).** The key is minted once and, from then on, it
 *    is what every send for that decision carries. A retry re-issues it; nothing here mints a second.
 * 2. **The card's two calls are one decision (§4.3, §5.5).** A swipe and a button tap both reach the
 *    seam — `SparkCard.test.tsx` pins that they do, identically — and §4.3 resolves them to **one**
 *    decision. So the key is held per **spark**: a second call while the first is in flight, or after a
 *    failure, reuses the key rather than minting one. (Two sends may go out; both carry the one key,
 *    and §4.13's hoisted repeat is what makes two sends one decision.) A decision that **committed**
 *    spends the key — reusing it then would be answered by the server's repeat, not by a new decision.
 * 3. **A failure keeps the record.** The key survives a refusal so **Retry re-issues the same one**; the
 *    failed attempt is the same decision, still uncommitted, and the caller's notice is drawn around
 *    it. Only the caller classifies the error — a `409` and a network drop reach the caller alike, and
 *    which of them offers Retry is the screen's call (`409` is the server stating a truth).
 *
 * The seam stays **void** (`ResolveSeam`): the screen learns the outcome through `onResolved` /
 * `onFailed`, never by widening the seam's return.
 */

/** Send one decision — `postDecision` in the screen; any promise in a test. */
export type PostDecision = (
  sparkId: string,
  decisionId: string,
  kind: ResolutionKind,
) => Promise<Decision | null>;

export interface DecisionResolverDeps {
  post: PostDecision;
  /**
   * The server recorded a decision. The screen **re-reads** §4.10 + §4.9 from here — it does not remove
   * the card locally, because the ladder and the deck are the server's (§4.10), and a card shown as
   * resolved before the server says so is exactly a committed idea the client pretends about.
   */
  onResolved(sparkId: string, decision: Decision): void;
  /** A resolution that did not commit — the caller draws the non-destructive Retry (T29). */
  onFailed(sparkId: string, error: ApiError): void;
  /**
   * Mint a decision id (§2.2). Defaults to `crypto.randomUUID`; injected so a test's keys are
   * deterministic and the module's *reuse* is observable rather than merely plausible.
   */
  newId?: () => string;
}

/** What the screens hold: the seam's own shape, plus the one act a failed attempt needs. */
export interface DecisionResolver {
  /** The `ResolveSeam` — one press or gesture, resolving to one decision. */
  resolve(sparkId: string, kind: ResolutionKind): void;
  /** Re-issue the pending decision for a spark, reusing its key (§2.2). A no-op if none is pending. */
  retry(sparkId: string): void;
}

export function createDecisionResolver(deps: DecisionResolverDeps): DecisionResolver {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  /** The live (unrecorded) decision per spark: the key, and the kind Retry would re-issue. */
  const live = new Map<string, { id: string; kind: ResolutionKind }>();

  function send(sparkId: string, id: string, kind: ResolutionKind): void {
    void deps.post(sparkId, id, kind).then(
      (decision) => {
        // `null` is "posted nothing" — §4.14's INSPIRED, which is not a resolution (no `decision` row).
        // Nothing to report and nothing to keep: the next press is a fresh decision.
        if (decision === null) {
          live.delete(sparkId);
          return;
        }
        live.delete(sparkId);
        deps.onResolved(sparkId, decision);
      },
      (error: ApiError) => {
        // A twin that lost the race may report **after** the winner committed. The decision resolved, so
        // its late failure is not a failure — reporting it would draw a Retry for a recorded decision.
        if (!live.has(sparkId)) return;
        deps.onFailed(sparkId, error);
      },
    );
  }

  return {
    resolve(sparkId, kind) {
      const pending = live.get(sparkId);
      const id = pending?.id ?? newId();
      // The stored kind is the latest intent, so a Retry re-issues what the user last asked for.
      live.set(sparkId, { id, kind });
      send(sparkId, id, kind);
    },
    retry(sparkId) {
      const pending = live.get(sparkId);
      if (pending === undefined) return;
      send(sparkId, pending.id, pending.kind);
    },
  };
}
