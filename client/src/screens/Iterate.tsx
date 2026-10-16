import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../api/client.ts";
import { getIdeaDetail, iterateIdea } from "../api/ideas.ts";
import type { Idea, IdeaDetail as IdeaDetailData, IdeaVersion } from "../api/types.ts";
import { DomainsField } from "../components/DomainsField.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Shimmer } from "../components/Shimmer.tsx";
import { HYPOTHESIS_MAX, counterText, sameDraft, validateCapture } from "../domain/capture.ts";
import type { CaptureDraft, CaptureErrors } from "../domain/capture.ts";
import { draftFromIdea } from "../domain/completion.ts";
import { isRetryable } from "../domain/decision.ts";
import { ideaHref } from "../router.ts";

/**
 * S6 Iterate (`FLOW.md` §2.1 T22/T23; `DESIGN.md` §8) — **in-place refinement of one idea**: the same
 * node with a new version, the prior one kept as history (`PRD.md` §3.2 item 1). No lineage edge is
 * created; a branch is **Fork** (S5).
 *
 * **One read, one write, and nothing patched locally.** The screen reads §4.5 for the node *and* its
 * versions — the versions read is free (the same snapshot carries them, ascending, current included) —
 * and writes §4.6. A committed save **returns to S4** rather than updating in place (T23): the node's
 * own read is what cannot drift, exactly as the deck and S4 treat their committed writes (§4.10).
 *
 * **The draft is `draftFromIdea`'s, not a second spelling of the four fields** — the same function
 * S4's completion editor starts from, because both begin from *the idea's current fields* and both
 * post `IdeaFields`. §4.6's request is the four mandatory fields verbatim, so the draft *is* the body.
 *
 * **History is not lineage** (`DESIGN.md` §8's anti-pattern). The versions are a **flat** list — no
 * brass node markers, no connectors, no chain — because that vocabulary belongs to LIVING LINEAGE on
 * S4, and borrowing it would read a version as an ancestor. There is no *"iterate from this version"*
 * affordance either: that is a branch, and a branch is Fork.
 *
 * **Two blocked states, and only one of them is a refusal.** While the form is identical to the
 * current version the CTA is disabled and reads *"No changes yet"* in mono — an empty version row
 * would make the history meaningless (§8). Otherwise the CTA is tappable and validation runs on the
 * first press, then live — Capture's rule (§5.2/T17), reused: the button has to stay tappable for the
 * inline error to follow the tap, so T23's *"CTA blocked"* is the **save** being blocked (no request
 * leaves the screen) rather than a dead button.
 *
 * **Back with unsaved changes confirms the discard** (§8): the node is never mutated implicitly, and a
 * refinement nobody saved should not vanish without a word.
 */

type State =
  | { kind: "loading" }
  | { kind: "ready"; detail: IdeaDetailData }
  /** The id is not an idea any more — `not_found` is a state, not an error to retry. */
  | { kind: "missing" }
  | { kind: "error"; message: string };

export function Iterate(props: { id: string }) {
  const { id } = props;
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      setState({ kind: "ready", detail: await getIdeaDetail(id) });
    } catch (error) {
      if (error instanceof ApiError && error.code === "not_found") {
        setState({ kind: "missing" });
        return;
      }
      setState({
        kind: "error",
        message:
          error instanceof ApiError && error.code !== "network"
            ? error.message
            : "Could not reach the vault. Check your connection.",
      });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === "loading") return <Shimmer label="Loading the idea…" />;

  if (state.kind === "missing") {
    return (
      <EmptyState
        title="This idea is not here."
        body="No idea answers to this link — it may have been deleted, or the link may be incomplete."
        action={{ label: "Back to the vault", href: "#/vault" }}
      />
    );
  }

  if (state.kind === "error") {
    return (
      <EmptyState
        // T29 — the read's failure is non-destructive and carries its own retry, in place.
        title="Couldn’t load this idea."
        body={state.message}
        action={{ label: "Retry", onClick: () => void load() }}
      />
    );
  }

  // `key` so a new id (or a re-read after a failure) mounts a fresh editor: the draft, its errors and
  // the discard confirm belong to one node, and none of them may carry across.
  return <IterateForm key={id} id={id} idea={state.detail.idea} versions={state.detail.versions} />;
}

/** The editor itself, over a read that has landed: the draft is this node's fields, verbatim. */
function IterateForm(props: { id: string; idea: Idea; versions: IdeaVersion[] }) {
  const { id, idea, versions } = props;
  const current = draftFromIdea(idea);
  const [draft, setDraft] = useState<CaptureDraft>(current);
  /** Validation runs on the first Save attempt, then live — Capture's rule (§5.2 / T17), reused. */
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Whether that failure is one a Retry can answer (T29) — `network` / `internal_error` only. */
  const [retryable, setRetryable] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  const unchanged = sameDraft(draft, current);
  const errors: CaptureErrors = attempted ? validateCapture(draft) : {};
  const over = draft.hypothesis.length > HYPOTHESIS_MAX;

  function update(patch: Partial<CaptureDraft>) {
    setDraft((currentDraft) => ({ ...currentDraft, ...patch }));
  }

  async function onSave() {
    if (unchanged) return;
    setAttempted(true);
    setSaveError(null);
    setRetryable(false);
    if (Object.keys(validateCapture(draft)).length > 0) return;

    setSaving(true);
    try {
      await iterateIdea(id, draft);
      // T23 — a saved refinement returns to S4, which reads v N+1 as current and the prior version in
      // history. Nothing is patched here: the node's own read is the snapshot that cannot disagree
      // with itself.
      window.location.hash = ideaHref(id);
    } catch (error) {
      // Non-destructive (T29): the typing stays exactly as it is, and the envelope's own message (§2)
      // is what the user reads. A Retry is offered only where re-issuing is safe — `network` /
      // `internal_error` — because anything else is the server *stating* something, and the same
      // request would draw the same answer.
      setSaveError(error instanceof ApiError ? error.message : "Could not save. Try again.");
      setRetryable(error instanceof ApiError && isRetryable(error));
      setSaving(false);
    }
  }

  function goBack() {
    window.location.hash = ideaHref(id);
  }

  /** §8 — leaving with a refinement nobody saved asks first; the node is never mutated implicitly. */
  function onBack() {
    if (unchanged) {
      goBack();
      return;
    }
    setDiscarding(true);
  }

  return (
    <div className="iterate">
      <header className="iterate__head">
        <button type="button" className="button button--ghost" onClick={onBack}>
          Back
        </button>
        <h1 className="screen__title">Iterate</h1>
        {/* The *same* id S4 shows, because it is the same node (§8). */}
        <p className="detail__id mono">{idea.id}</p>
      </header>

      <div className="field">
        <label className="field__label" htmlFor="iterate-hypothesis">
          Core Hypothesis
        </label>
        <input
          id="iterate-hypothesis"
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
        <label className="field__label" htmlFor="iterate-problem">
          Problem Solved
        </label>
        <input
          id="iterate-problem"
          className="field__input"
          value={draft.problem}
          onChange={(event) => update({ problem: event.target.value })}
        />
        {errors.problem ? <p className="field__error">{errors.problem}</p> : null}
      </div>

      <div className="field">
        <label className="field__label" htmlFor="iterate-monetization">
          Monetization / Value Angle
        </label>
        <input
          id="iterate-monetization"
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

      <History versions={versions} currentVersion={idea.current_version} />

      {discarding ? (
        <section className="confirm" role="alertdialog" aria-labelledby="discard-title">
          <h2 id="discard-title" className="confirm__title">
            Discard your changes?
          </h2>
          <p className="confirm__detail">
            Nothing was saved as a version — the idea keeps its current one.
          </p>
          <div className="confirm__actions">
            <button
              type="button"
              className="button button--ghost"
              onClick={() => setDiscarding(false)}
            >
              Keep editing
            </button>
            <button type="button" className="button button--destructive" onClick={goBack}>
              Discard changes
            </button>
          </div>
        </section>
      ) : null}

      <div className="actionbar">
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
        <button
          type="button"
          className="button"
          disabled={saving || unchanged}
          onClick={() => void onSave()}
        >
          {unchanged ? <span className="mono">No changes yet</span> : "Save iteration"}
        </button>
      </div>
    </div>
  );
}

/**
 * The versions, flat (`DESIGN.md` §8) — the **History** section, each row opening read-only in place.
 * `<details>` rather than React state: the disclosure is the element's own, so it costs no state to
 * keep in sync with what is on screen, and a row's open/closed state survives the editor's re-renders.
 */
function History(props: { versions: IdeaVersion[]; currentVersion: number }) {
  return (
    <section className="history">
      <h2 className="section__label">History</h2>
      <ol className="history__list">
        {props.versions.map((version) => {
          const isCurrent = version.version === props.currentVersion;
          return (
            <li key={version.version}>
              <details className={`history__row${isCurrent ? " history__row--current" : ""}`}>
                <summary className="history__summary">
                  <span className="history__stamp mono">
                    v{version.version} · {clock(version.created_at)}
                  </span>
                  <span className="history__headline">{version.hypothesis}</span>
                  {isCurrent ? <span className="history__current mono">current</span> : null}
                </summary>
                <div className="history__body">
                  <p className="history__line">{version.problem}</p>
                  <p className="history__line">{version.monetization}</p>
                  <ul className="chips chips--tight">
                    {version.domain_tags.map((tag) => (
                      <li key={tag} className="chip chip--static">
                        <span className="chip__label">{tag}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </details>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * §8's row stamp — `v2 · 04:12`, the clock time the version was written, in the reader's own zone. A
 * stamp that will not parse shows `--:--` rather than `NaN:NaN`: the version number is the row's
 * identity, and a malformed timestamp must not take it down with it.
 */
function clock(createdAt: string): string {
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) return "--:--";
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}
