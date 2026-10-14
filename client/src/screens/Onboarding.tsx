import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../api/client.ts";
import { vaultSummary } from "../api/vault.ts";
import type { VaultSummary } from "../api/types.ts";
import { DomainPicker } from "../components/DomainPicker.tsx";
import { StarChart } from "../components/StarChart.tsx";
import { HYPOTHESIS_MAX, counterText } from "../domain/capture.ts";
import {
  promptFor,
  saveOnboardingIdea,
  validateOnboardingIdea,
  type OnboardingIdea,
} from "../domain/onboarding.ts";
import { spreadGate } from "../domain/spread-gate.ts";

/**
 * S0 — Onboarding / bootstrap (`FLOW.md` §2.1 S0, §4.2 T01–T04; `PRD.md` §3.4 items 1–2).
 *
 * **The capture-and-stay loop, and the two exits.** T02 is `S0 → S0`: *Add idea* creates the node, the
 * star chart widens, `domains covered` updates, and the user stays here with the next prompt. This
 * screen also renders S0's exits — T03's *skip for now* and T04's *"See your sparks"*, both landing S1
 * (`#/`, `router.ts`) — added by O4 `#24`; the launch entry (T01/T05) stays the shell's.
 *
 * **Nothing here computes a gate.** The readout renders the summary's own numbers, and the CTA's
 * condition is `spreadGate(summary)` — the server's `eligible`, read, never a local tally — so the gate
 * this screen opens and the number it shows cannot disagree (R1). While the summary is unread or
 * unreachable the CTA is **absent rather than guessed**, and *skip for now* stays available: the
 * deviation T03 records is descriptive and has no wire form.
 *
 * The rules live in `domain/onboarding.ts` (pure, tested directly); this file renders them.
 */

const EMPTY: OnboardingIdea = { hypothesis: "", problem: "", monetization: "", domain: null };

export function Onboarding() {
  const [promptIndex, setPromptIndex] = useState(0);
  const [draft, setDraft] = useState<OnboardingIdea>(EMPTY);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [summary, setSummary] = useState<VaultSummary | null>(null);
  const [summaryFailed, setSummaryFailed] = useState(false);

  const loadSummary = useCallback(async () => {
    setSummaryFailed(false);
    try {
      setSummary(await vaultSummary());
    } catch {
      // The readout is the only thing that needs the read; capture itself still works, so the failure
      // is composed rather than fatal.
      setSummaryFailed(true);
    }
  }, []);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const errors = attempted ? validateOnboardingIdea(draft) : {};
  const over = draft.hypothesis.length > HYPOTHESIS_MAX;

  function update(patch: Partial<OnboardingIdea>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function onAdd() {
    setAttempted(true);
    setSaveError(null);
    if (Object.keys(validateOnboardingIdea(draft)).length > 0) return;

    setSaving(true);
    try {
      await saveOnboardingIdea(draft);
      // T02: the node is created and we stay on S0 — blank the draft, advance the prompt, re-read the
      // readout from the server (never add to a local tally).
      setDraft(EMPTY);
      setAttempted(false);
      setPromptIndex((index) => index + 1);
      setSaving(false);
      await loadSummary();
    } catch (error) {
      setSaveError(error instanceof ApiError ? error.message : "Could not save. Try again.");
      setSaving(false);
    }
  }

  return (
    <div className="onboarding">
      <h1 className="screen__title">Your star chart</h1>
      <p className="screen__lede">Every idea is a point. Sparks draw the lines.</p>

      <ProgressMark summary={summary} failed={summaryFailed} onRetry={() => void loadSummary()} />

      <section className="prompt" aria-label="Cross-domain prompt">
        <p className="prompt__label">Cross-domain prompt</p>
        <p className="prompt__line">{promptFor(promptIndex)}</p>
      </section>

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

      {/* `key` on the prompt index: a saved idea blanks the draft, so the picker's own input state
          (which option is selected, what was typed) resets with it rather than lingering. */}
      <DomainPicker
        key={promptIndex}
        value={draft.domain}
        onChange={(domain) => update({ domain })}
        error={errors.domain_tags}
      />

      {saveError ? (
        <p className="form-error" role="alert">
          {saveError}
        </p>
      ) : null}

      {/*
       * S0's two exits (`FLOW.md` §4.2 T03/T04). Both land **S1** (`#/`, the home `router.ts`
       * already routes); neither is an in-place action, so both are anchors, like the tab bar.
       *
       * `See your sparks` is the gate — `spreadGate(summary)`, the server's `eligible`, and nothing
       * else. While the summary is unread or unreachable the CTA is **absent rather than guessed**:
       * the vault may or may not clear the floor, and a gate that rendered on a failed read would be
       * a client-side guess dressed as server truth (R1). Skip is always there — T03 allows leaving
       * onboarding early, and the deviation it records is descriptive (`PRD.md` §3.4 item 2 /
       * NFR-U1) with no wire form; its only consequence is S1 landing in E0 (slice 3).
       */}
      <div className="exits">
        {summary !== null && spreadGate(summary) ? (
          <a className="button button--ghost" href="#/">
            See your sparks
          </a>
        ) : null}
        <a className="exits__skip" href="#/">
          skip for now
        </a>
      </div>

      <div className="actionbar">
        <button type="button" className="button" onClick={() => void onAdd()} disabled={saving}>
          Add idea
        </button>
      </div>
    </div>
  );
}

/**
 * The readout's three states: loading, unreachable, resolved. The mark itself is
 * `components/StarChart.tsx` — shared with S1's E0 composition (`DESIGN.md` §9) so the two screens
 * render one mark, not two. This component owns only the read's outcome.
 */
function ProgressMark(props: {
  summary: VaultSummary | null;
  failed: boolean;
  onRetry: () => void;
}) {
  if (props.summary === null) {
    if (!props.failed) {
      return (
        <p className="sr-only" role="status">
          Loading your progress…
        </p>
      );
    }
    return (
      <section className="empty" aria-label="Progress unavailable">
        <h2 className="empty__title">Your progress is out of reach.</h2>
        <p className="empty__body">
          Capture still works — the readout needs the vault read to answer.
        </p>
        <button type="button" className="button" onClick={props.onRetry}>
          Try again
        </button>
      </section>
    );
  }

  return <StarChart summary={props.summary} />;
}
