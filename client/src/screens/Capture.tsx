import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "../api/client.ts";
import { createIdea } from "../api/ideas.ts";
import { inspireSeed } from "../api/inspire.ts";
import type { InspireSeed } from "../api/types.ts";
import { DomainsField } from "../components/DomainsField.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Shimmer } from "../components/Shimmer.tsx";
import { HYPOTHESIS_MAX, counterText, seedToDraft, validateCapture } from "../domain/capture.ts";
import type { CaptureDraft, CaptureErrors } from "../domain/capture.ts";
import { isRetryable, resolutionNotice } from "../domain/decision.ts";
import { ideaHref } from "../router.ts";

/**
 * S2 Capture (`FLOW.md` §2.1 T15–T18) — two entries, one form:
 *
 * - the **Add** tab / INSPIRE-less route (`#/capture`) is a **blank** capture of the four mandatory
 *   fields (`PRD.md` §2);
 * - INSPIRE reaches it **seeded** (`#/capture/<spark_id>`, T09/T16): the screen prefills from §4.14's
 *   read and shows T09's banner, and the save carries the spark pair (`origin_spark_id` + its own
 *   `decision_id`) so §4.2 writes the provenance and resolves the spark `RESOLVED-INSPIRED`.
 *
 * **The seeded form reads its own endpoint.** §4.14, by id — not the card's payload handed over on the
 * way in, so a reload and a deep link render from the read alone, exactly as S1b renders from §4.12. It
 * is a read: the spark stays `OFFERED` while this screen is open, and only a **committed** save resolves
 * it (§4.3 / B). Abandoning Capture leaves it `OFFERED`; nothing here writes on mount.
 *
 * **The seeded save's `decision_id` is minted once and reused** (§2.2 / N4) — held in a ref, in memory,
 * like the deck's resolver (`domain/decision.ts`) — so a Retry re-issues the *same* key and §4.2's
 * idempotency answers it. A reload after a lost-response commit mints a fresh key, but the first save
 * left the spark `RESOLVED-INSPIRED`, so §4.2's last arm answers `409` rather than writing a second
 * idea: a reload surfaces a `409` (no duplicate), whose surface keeps the draft and offers no Retry.
 *
 * Validation is UX parity with §4.2, not authority: the server validates every write. It runs on the
 * first Save attempt and, once the attempt has happened, live as the user types — so an error clears
 * the moment the field is fixed. T17's "CTA blocked" is the *save* being blocked: the button stays
 * tappable so that tapping it is what surfaces the error, which is the only way an inline error can
 * follow a tap.
 */
const EMPTY: CaptureDraft = { hypothesis: "", problem: "", monetization: "", domain_tags: [] };

/** The seeded entry's read state; `blank` is the Add tab, which reads nothing. */
type Seed =
  | { kind: "blank" }
  | { kind: "loading" }
  | { kind: "ready"; seed: InspireSeed }
  /** The id is not a spark — `not_found` is a state, not an error to retry (§2). */
  | { kind: "missing" }
  | { kind: "error"; message: string };

export function Capture(props: { sparkId?: string }) {
  const { sparkId } = props;
  const seeded = sparkId !== undefined;

  const [seed, setSeed] = useState<Seed>(seeded ? { kind: "loading" } : { kind: "blank" });
  const [draft, setDraft] = useState<CaptureDraft>(EMPTY);
  const [attempted, setAttempted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Whether that failure is one a Retry can answer (T29) — seeded, `network`/`internal_error` only. */
  const [retryable, setRetryable] = useState(false);
  const [saving, setSaving] = useState(false);

  /**
   * The seeded save's idempotency key (§2.2 / N4), minted on first use and reused from then on: the
   * client "must not regenerate it", or a retry becomes a second decision. In memory — no storage.
   */
  const decisionId = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (sparkId === undefined) return;
    setSeed({ kind: "loading" });
    try {
      const fetched = await inspireSeed(sparkId);
      setSeed({ kind: "ready", seed: fetched });
      setDraft(seedToDraft(fetched));
    } catch (error) {
      if (error instanceof ApiError && error.code === "not_found") {
        setSeed({ kind: "missing" });
        return;
      }
      setSeed({
        kind: "error",
        message:
          error instanceof ApiError && error.code !== "network"
            ? error.message
            : "Could not reach the engine. Check your connection.",
      });
    }
  }, [sparkId]);

  useEffect(() => {
    void load();
  }, [load]);

  function update(patch: Partial<CaptureDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function onSave() {
    setAttempted(true);
    setSaveError(null);
    setRetryable(false);
    if (Object.keys(validateCapture(draft)).length > 0) return;

    setSaving(true);
    try {
      const idea = await createIdea(
        sparkId === undefined
          ? draft
          : // §4.2's seeded pair is both-or-neither, and both are here: the spark the provenance
            // points at, and this capture's own key. The key is minted once and reused (§2.2).
            { ...draft, origin_spark_id: sparkId, decision_id: seededKey() },
      );
      // T16's destination is **the created idea's detail**, the same one a blank capture lands on
      // (D3). A committed seeded save takes the spark off the deck (§4.3 / B), so its own S1b detail
      // would render a spark the server no longer offers — the idea, not the spark, is what to show.
      window.location.hash = ideaHref(idea.id);
    } catch (error) {
      setSaveError(saveNotice(error, seeded));
      // Only a seeded, retryable failure carries a Retry: a `409` can only loop (the deck's rule),
      // and a blank capture's Save button already *is* its retry.
      setRetryable(seeded && error instanceof ApiError && isRetryable(error));
      setSaving(false);
    }
  }

  /** The one place the key is minted — a second site would be the "regenerate" §2.2 forbids. */
  function seededKey(): string {
    decisionId.current ??= crypto.randomUUID();
    return decisionId.current;
  }

  if (seed.kind === "loading") return <Shimmer label="Loading the spark…" />;

  if (seed.kind === "missing") {
    return (
      <EmptyState
        title="This spark is not here."
        body="No spark answers to this link — it may have been removed, or the link may be incomplete."
        // Back to the deck, and no retry: retrying an id the server does not have is a loop.
        action={{ label: "Back to Sparks", href: "#/" }}
      />
    );
  }

  if (seed.kind === "error") {
    return (
      <EmptyState
        // T29 — the failure is **non-destructive** and carries its own retry: the read re-runs in
        // place, and whatever the server answers then is what renders.
        title="Couldn’t load this spark."
        body={seed.message}
        action={{ label: "Retry", onClick: () => void load() }}
      />
    );
  }

  const errors: CaptureErrors = attempted ? validateCapture(draft) : {};
  const over = draft.hypothesis.length > HYPOTHESIS_MAX;

  return (
    <div className="capture">
      <h1 className="screen__title">Capture</h1>
      <p className="screen__lede">
        An idea is four fields: the hypothesis, the problem it answers, the value it captures, and
        at least one domain.
      </p>

      {/* T09's banner (`stitch-prompts.md` §3): a card with a brass edge, the mono label and one line.
          Drawn from the read — the seed is what makes this a seeded capture, not a flag passed in. */}
      {seed.kind === "ready" ? (
        <div className="seedcard">
          <p className="section__label">FROM A SPARK</p>
          <p className="seedcard__body">Seeded from a spark — make it yours.</p>
        </div>
      ) : null}

      <div className="field">
        <label className="field__label" htmlFor="hypothesis">
          Core Hypothesis
        </label>
        <input
          id="hypothesis"
          className="field__input"
          value={draft.hypothesis}
          onChange={(event) => update({ hypothesis: event.target.value })}
        />
        <p className={`counter${over ? " counter--over" : ""}`}>
          {counterText(draft.hypothesis.length)}
        </p>
        {errors.hypothesis ? <p className="field__error">{errors.hypothesis}</p> : null}
      </div>

      <div className="field">
        <label className="field__label" htmlFor="problem">
          Problem Solved
        </label>
        <input
          id="problem"
          className="field__input"
          value={draft.problem}
          onChange={(event) => update({ problem: event.target.value })}
        />
        {errors.problem ? <p className="field__error">{errors.problem}</p> : null}
      </div>

      <div className="field">
        <label className="field__label" htmlFor="monetization">
          Monetization / Value Angle
        </label>
        <input
          id="monetization"
          className="field__input"
          value={draft.monetization}
          onChange={(event) => update({ monetization: event.target.value })}
        />
        {errors.monetization ? <p className="field__error">{errors.monetization}</p> : null}
      </div>

      <DomainsField
        tags={draft.domain_tags}
        onChange={(domain_tags) => update({ domain_tags })}
        error={errors.domain_tags}
      />

      {/* The save's failure, non-destructive either way. A retryable one (seeded, `network` /
          `internal_error`) adds T29's Retry, which re-issues the same `decision_id` (§2.2). */}
      {saveError === null ? null : (
        <p className="form-error" role="alert">
          {saveError}
          {retryable ? (
            <button type="button" className="button button--ghost" onClick={() => void onSave()}>
              Retry
            </button>
          ) : null}
        </p>
      )}

      <div className="actionbar">
        <button type="button" className="button" onClick={() => void onSave()} disabled={saving}>
          Save to vault
        </button>
      </div>
    </div>
  );
}

/**
 * A `409` on a seeded save — the spark is not `OFFERED`, so this save cannot commit (§4.2). It does not
 * claim *nothing was recorded*: on the reload-after-lost-response path the earlier attempt **is** what
 * created the idea, and the `409` is the duplicate being refused. Non-destructive, and no Retry — the
 * same request draws the same answer (the deck's rule), so a Retry could only loop.
 */
const SEED_REFUSED =
  "This spark was already resolved, so this save didn't commit. Your draft is still here.";

/**
 * What the user reads when a save does not commit.
 *
 * A **seeded** save borrows the deck's own T29 line for the retryable codes (`resolutionNotice`) — one
 * definition, so S2 and the deck cannot say different things about the same failure — and its own line
 * for a `409`. Everything else keeps the blank capture's behaviour: the envelope's own message inline
 * (`docs/API.md` §2), which for a `422` names the field the user has to fix.
 */
function saveNotice(error: unknown, seeded: boolean): string {
  if (seeded && error instanceof ApiError) {
    if (isRetryable(error)) return resolutionNotice(error);
    if (error.code === "conflict") return SEED_REFUSED;
  }
  return error instanceof ApiError ? error.message : "Could not save. Try again.";
}
