import { useState } from "react";

import { ApiError } from "../api/client.ts";
import { createIdea } from "../api/ideas.ts";
import { DomainsField } from "../components/DomainsField.tsx";
import { HYPOTHESIS_MAX, counterText, validateCapture } from "../domain/capture.ts";
import type { CaptureDraft, CaptureErrors } from "../domain/capture.ts";
import { ideaHref } from "../router.ts";

/**
 * S2 Capture (`FLOW.md` §2.1 T15–T18) — a blank capture of the four mandatory fields (`PRD.md` §2).
 *
 * The seeded path (T09/T16 — `origin_spark_id`/`decision_id` from INSPIRE) is **not** built: it needs
 * the spark deck (K2 #36) to launch it, so a V8 capture is always blank. `createIdea` still states the
 * pair as `null`, which is what makes it blank rather than half-seeded.
 *
 * Validation is UX parity with §4.2, not authority: the server validates every write. It runs on the
 * first Save attempt and, once the attempt has happened, live as the user types — so an error clears
 * the moment the field is fixed. T17's "CTA blocked" is the *save* being blocked: the button stays
 * tappable so that tapping it is what surfaces the error, which is the only way an inline error can
 * follow a tap.
 */
const EMPTY: CaptureDraft = { hypothesis: "", problem: "", monetization: "", domain_tags: [] };

export function Capture() {
  const [draft, setDraft] = useState<CaptureDraft>(EMPTY);
  const [attempted, setAttempted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const errors: CaptureErrors = attempted ? validateCapture(draft) : {};
  const over = draft.hypothesis.length > HYPOTHESIS_MAX;

  function update(patch: Partial<CaptureDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function onSave() {
    setAttempted(true);
    setSaveError(null);
    if (Object.keys(validateCapture(draft)).length > 0) return;

    setSaving(true);
    try {
      const idea = await createIdea(draft);
      // D3 — the created idea's detail. "Origin" (T16) has no renderable meaning until the deck
      // (K2 #36) and onboarding (O3 #23) exist; this re-opens when they land the real origin.
      window.location.hash = ideaHref(idea.id);
    } catch (error) {
      // The envelope's `message` is non-normative (docs/API.md §2) but it is the honest thing to
      // show: the alternative is a blank save. The code decides nothing user-facing here.
      setSaveError(error instanceof ApiError ? error.message : "Could not save. Try again.");
      setSaving(false);
    }
  }

  return (
    <div className="capture">
      <h1 className="screen__title">Capture</h1>
      <p className="screen__lede">
        An idea is four fields: the hypothesis, the problem it answers, the value it captures, and
        at least one domain.
      </p>

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

      {saveError ? (
        <p className="form-error" role="alert">
          {saveError}
        </p>
      ) : null}

      <div className="actionbar">
        <button type="button" className="button" onClick={() => void onSave()} disabled={saving}>
          Save to vault
        </button>
      </div>
    </div>
  );
}
