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
 * 2. **The card's two calls are one decision — and one *send* (§4.3 / H4, §5.5).** A swipe and a button
 *    tap both reach the seam (`SparkCard.test.tsx` pins that they do, identically, and §5.5 makes them
 *    the *same command*), and §4.3 resolves them to **one** decision. So the key is held per **spark**,
 *    and while a request for that spark's decision is out a further press **does not send**: the
 *    in-flight request already carries the outcome, and **the first kind wins** (a disagreement between
 *    the two calls is out of spec — §5.5's parity says they are the same command). Coalescing here is
 *    `deck-stream.ts`'s idiom applied to a write. A decision that **committed** spends the key —
 *    reusing it then would be answered by §4.13's hoisted repeat, not by a new decision.
 * 3. **A failure keeps the record (§2.2).** The key survives a refusal so **Retry re-issues the same
 *    one**; the failed attempt is the same decision, still uncommitted, and the caller's notice is drawn
 *    around it. A request that failed is no longer in flight, so a retry — or a fresh press — sends
 *    again under the same key.
 *
 * ## The ordering invariant (why coalescing, and not deferral bookkeeping)
 *
 * Per `decision_id`: **a failure is emitted only when its own request settles, and never after a
 * success for that id.** Coalescing makes both halves structural rather than bookkept:
 *
 * - only **one** request per key is ever out, so no second request's failure can race the first's
 *   success — and "two twins both fail" cannot arise to need counting;
 * - a **success removes the record** before it is reported, so the key cannot be re-issued and no later
 *   failure for it can be emitted.
 *
 * The one ordering that must *remain* legal is failure-then-success: a response lost in transit is a
 * genuine failure, and its Retry is answered by §4.13's hoisted repeat — so a success legitimately
 * follows a failure. What may never happen is the reverse.
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

/** A live (unrecorded) decision: its key, the kind its request carries, and whether that request is out. */
interface Pending {
  id: string;
  kind: ResolutionKind;
  inFlight: boolean;
}

export function createDecisionResolver(deps: DecisionResolverDeps): DecisionResolver {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const live = new Map<string, Pending>();

  function send(sparkId: string, pending: Pending): void {
    pending.inFlight = true;
    void deps.post(sparkId, pending.id, pending.kind).then(
      (decision) => {
        // Settled: spend the key **before** reporting, so nothing can re-issue it and no later failure
        // for this id can be emitted (the ordering invariant above). `null` is "posted nothing" —
        // §4.14's INSPIRED, which is not a resolution (no `decision` row): nothing to report, nothing
        // to keep.
        live.delete(sparkId);
        if (decision !== null) deps.onResolved(sparkId, decision);
      },
      (error: ApiError) => {
        // The record stays, so Retry re-issues the same key (§2.2). Reported here and only here: this
        // is the only request that could carry this key's outcome (any second was coalesced away), and
        // a settled success has already removed the record.
        pending.inFlight = false;
        deps.onFailed(sparkId, error);
      },
    );
  }

  return {
    resolve(sparkId, kind) {
      const pending = live.get(sparkId);
      if (pending !== undefined) {
        // Coalesced while the request is out — §4.3's raced swipe + tap is **one** decision, and the
        // in-flight request carries it (the first kind wins). With nothing out, the press is a fresh
        // attempt at a failed decision: the **same** key, and the user's latest kind.
        if (pending.inFlight) return;
        pending.kind = kind;
        send(sparkId, pending);
        return;
      }
      const created: Pending = { id: newId(), kind, inFlight: false };
      live.set(sparkId, created);
      send(sparkId, created);
    },
    retry(sparkId) {
      const pending = live.get(sparkId);
      // Nothing pending (never started, or already committed), or a request is already out: a no-op.
      if (pending === undefined || pending.inFlight) return;
      send(sparkId, pending);
    },
  };
}

/**
 * Whether **Retry** may re-issue a failed decision — the line between a blip and a statement.
 *
 * `network` never reached the server and `internal_error` is the server failing on its own side; either
 * can differ on a second try, and those are the two T29's surface and NFR-A1 are about. Every other
 * code is the server *stating* something — `conflict` that the spark is not `OFFERED` (resolved in
 * another tab), `not_found` that the id is unknown, `validation_failed`/`unauthorized` that the request
 * or the token is wrong. Re-issuing the same request draws the same answer, so the screen **re-reads**
 * rather than offering a Retry that can only loop (the lever-that-points-at-nothing this repo refuses).
 *
 * One definition, so the deck and S1b cannot disagree about which failures carry Retry.
 */
export function isRetryable(error: ApiError): boolean {
  return error.code === "network" || error.code === "internal_error";
}
