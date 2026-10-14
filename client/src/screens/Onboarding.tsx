import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../api/client.ts";
import { vaultSummary } from "../api/vault.ts";
import type { VaultSummary } from "../api/types.ts";
import { DomainPicker } from "../components/DomainPicker.tsx";
import { HYPOTHESIS_MAX, counterText } from "../domain/capture.ts";
import {
  progress,
  promptFor,
  saveOnboardingIdea,
  validateOnboardingIdea,
  type OnboardingIdea,
} from "../domain/onboarding.ts";

/**
 * S0 — Onboarding / bootstrap (`FLOW.md` §2.1 S0, §4.2 T01/T02; `PRD.md` §3.4 items 1–2).
 *
 * **The capture-and-stay loop.** T02 is `S0 → S0`: *Add idea* creates the node, the star chart widens,
 * `domains covered` updates, and the user stays here with the next prompt. The **exits** are not in
 * this issue — T03's Skip and T04's *"See your sparks"* gate are O4 `#24` ("spread gate + Skip
 * deviation"), and the launch entry (T01/T05) is O4's too. Nothing here computes a gate: the readout is
 * the summary's, so the gate O4 adds and this number stay the same quantity (R1).
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

      <div className="actionbar">
        <button type="button" className="button" onClick={() => void onAdd()} disabled={saving}>
          Add idea
        </button>
      </div>
    </div>
  );
}

/**
 * The `domains covered x / 3` readout and the star-chart mark (`FLOW.md` §5.2; `DESIGN.md` §6).
 *
 * **No arcs.** `DESIGN.md` §6 draws *"brass arcs … between points that are far apart"*, but no S0
 * endpoint exposes `domain_cluster.adjacency` (`ARCHITECTURE.md` §6 gives S0 `POST /v1/ideas` +
 * `GET /v1/vault/summary`) — and §6 bars the client from computing scores at all. So the mark renders
 * what the client can reach: the rings, one brass point per **resolved** domain and one pale point per
 * **provisional** one. It still *"visibly widens as domains are covered"*, which is the criterion.
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

  const p = progress(props.summary);
  // **One displayed quantity.** The mark and the sr announcement read the *same* capped value the
  // readout prints — `progress().covered`, not the raw `resolved_domains`. A `resolved: 5, target: 3`
  // vault would otherwise render `3 / 3` beside five brass points and "5 covered domains": three
  // elements, two numbers. The full census is the Vault screen's to show, not S0's.
  const covered = p.covered;
  const provisional = props.summary.provisional_domains;
  const segments = Array.from({ length: p.target }, (_, index) => index < p.covered);

  return (
    <section className="progress" aria-label="Domains covered">
      <p className="progress__label">Domains covered</p>
      <p className="progress__value">
        {p.covered} / {p.target}
      </p>
      <div className="progress__bar" aria-hidden="true">
        {segments.map((filled, index) => (
          <span
            key={index}
            className={filled ? "progress__seg progress__seg--filled" : "progress__seg"}
          />
        ))}
      </div>
      <div className="chart" aria-hidden="true">
        <span className="chart__ring chart__ring--outer" />
        <span className="chart__ring chart__ring--middle" />
        <span className="chart__ring chart__ring--inner" />
        <span className="chart__points">
          {Array.from({ length: covered }, (_, index) => (
            <span key={`c${index}`} className="star star--covered" />
          ))}
          {Array.from({ length: provisional }, (_, index) => (
            <span key={`p${index}`} className="star star--provisional" />
          ))}
        </span>
      </div>
      <p className="sr-only">
        Star chart: {covered} covered {covered === 1 ? "domain" : "domains"}, {provisional}{" "}
        provisional.
      </p>
    </section>
  );
}
