import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../api/client.ts";
import { postDecision } from "../api/decisions.ts";
import { sparkDetail } from "../api/sparks.ts";
import type { SparkDetail as SparkDetailData } from "../api/types.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { Shimmer } from "../components/Shimmer.tsx";
import type { ResolutionKind, ResolveSeam } from "../domain/deck-interaction.ts";
import { createDecisionResolver, isRetryable, resolutionNotice } from "../domain/decision.ts";
import { captureHref } from "../router.ts";

/**
 * S1b Spark Detail (`FLOW.md` §2.1; `docs/stitch-prompts.md` §2) — one spark, expanded: the idea as
 * the headline with its chips beneath, then THE CLAIM · WHAT IT WOULD TAKE · FIRST STEP.
 *
 * **The composition is `Spark` + `what_it_takes` and nothing else** (`docs/API.md` §3.4; `PRD.md` §3.3
 * item 4). No score, no distance/alignment/similarity readout, no origin line: selection internals
 * never surface, and the spark's source ideas are excluded from the contract itself (§3.3). That is
 * the governance rule, not a shortfall — the pairing's similarity is not the user's question.
 *
 * **It reads its own endpoint.** §4.12, not §4.9 re-read and not the card's payload handed over on the
 * way in: `#/sparks/<id>` is a route, so a reload and a deep link must render from the read alone, and
 * a stale in-memory card must not be able to shadow the server. A `null` field is a legacy row and is
 * rendered **absent** — no label over nothing (the #115 treatment, §3.3/§3.4).
 *
 * **The decision seam is the screen's own, and it is live (K7 `#41`).** The detail's Good / Not for me
 * consume the **deck's own** `ResolveSeam` (`domain/deck-interaction.ts`) rather than a second type of
 * their own, and the screen wires its own resolver from the same module the deck does, so the two
 * screens cannot drift into two payloads. A commit returns to the deck (call 4(a)); a `409` re-reads
 * the deck rather than retrying (call 4(b)); only `network` / `internal_error` draw T29's notice.
 * An injected `onResolve` still overrides the seam — that is what the parity tests hold.
 *
 * **`Make it mine` is the third path, and it is not a resolution** (K5 `#39` + #119). §2.2's INSPIRE
 * opens S2 *seeded*; the spark stays `OFFERED` while Capture is open, and the CTA itself writes nothing
 * — it is a route change to `#/capture/<id>`, which is exactly why it stays **off** the seam (the
 * one-call-site guard below counts the resolutions, and an INSPIRE routed through `dispatch` would
 * redden it). The resolution happens in S2, on a committed seeded save (§4.2/§4.3).
 */

type State =
  | { kind: "loading" }
  | { kind: "ready"; detail: SparkDetailData }
  /** The id is not a spark any more — `not_found` is a state, not an error to retry (§2). */
  | { kind: "missing" }
  | { kind: "error"; message: string };

/** `#/` is the home, S1 Sparks — the deck a resolution returns to (K7 `#41`, call 4(a)). */
function backToDeck(): void {
  window.location.hash = "#/";
}

export function SparkDetail(props: { id: string; onResolve?: ResolveSeam }) {
  const { id } = props;
  const [state, setState] = useState<State>({ kind: "loading" });
  /** T29's notice for a resolution that did not commit — its own surface, never the read's error. */
  const [failure, setFailure] = useState<string | null>(null);

  /**
   * S1b's **resolution seam** (K7 `#41`), the same shape as the deck's: the screen wires its own
   * resolver from `domain/decision.ts` and §4.13's transport, and the seam stays `void`.
   *
   * Two calls this screen adds, both rulings recorded in #41's plan:
   *
   * - **(a) a commit returns to the deck.** The card is gone from §4.9, so a detail of the spark the
   *   user just resolved would show what the server no longer offers. `FLOW.md` pins the resolution's
   *   destination as S1 (T10/T11) and gives S1b none.
   * - **(b) a `409` is not retryable.** It is the server stating the spark is not `OFFERED` — resolved
   *   in another tab, or the second of two kinds on one card — so the screen **re-reads the deck**
   *   rather than offering a Retry that could only loop. Only `network` / `internal_error` carry Retry.
   */
  const [resolver] = useState(() =>
    createDecisionResolver({
      post: postDecision,
      onResolved: () => {
        setFailure(null);
        backToDeck();
      },
      onFailed: (_sparkId, error) => {
        if (isRetryable(error)) {
          setFailure(resolutionNotice(error));
          return;
        }
        setFailure(null);
        backToDeck();
      },
    }),
  );

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      setState({ kind: "ready", detail: await sparkDetail(id) });
    } catch (error) {
      // A spark the user resolved mid-session still answers here (§4.12 reads by id, whatever the
      // status) — so `not_found` means the id is gone, not that it is spoken for.
      if (error instanceof ApiError && error.code === "not_found") {
        setState({ kind: "missing" });
        return;
      }
      setState({
        kind: "error",
        message:
          error instanceof ApiError && error.code !== "network"
            ? error.message
            : "Could not reach the engine. Check your connection.",
      });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === "loading") return <Shimmer label="Loading the spark…" />;

  if (state.kind === "missing") {
    return (
      <EmptyState
        title="This spark is not here."
        body="No spark answers to this link — it may have been removed, or the link may be incomplete."
        // Back to the deck, and no retry: retrying an id the server does not have is a loop.
        action={{ label: "Back to Sparks", href: "#/" }}
      />
    );
  }

  if (state.kind === "error") {
    return (
      <EmptyState
        // T29 — the failure is **non-destructive** and carries its own retry: the read re-runs in
        // place, and whatever the server answers then is what renders.
        title="Couldn’t load this spark."
        body={state.message}
        action={{ label: "Retry", onClick: () => void load() }}
      />
    );
  }

  const { id: sparkId, direction, claim, what_it_takes, first_step, domain_tags } = state.detail;
  // The screen's own resolver is the app path; an injected seam overrides it (the parity tests, and any
  // future shell wiring), so the two screens keep one shape per screen (K3's ruling, §5.5).
  const resolve = props.onResolve ?? resolver.resolve;

  // The ONE resolution path out of this screen (§5.5's parity, one screen over): both buttons reach the
  // seam through it, and a second, inline dispatch is the divergence the structural guard in
  // `deck-interaction.test.ts` exists for. `Make it mine` deliberately does **not** come through here.
  function dispatch(kind: ResolutionKind): void {
    resolve(sparkId, kind);
  }

  // T09 — the third path. A route change to the **seeded** S2, which reads §4.14 itself; nothing is
  // resolved and nothing is posted, so the spark stays `OFFERED` until the save commits there (§4.3/B).
  function openCapture(): void {
    window.location.hash = captureHref(sparkId);
  }

  return (
    <article className="detail">
      <header className="detail__head">
        <h1 className="detail__headline">{direction}</h1>
        <ul className="chips">
          {domain_tags.map((tag) => (
            <li key={tag} className="chip chip--static">
              <span className="chip__label">{tag}</span>
            </li>
          ))}
        </ul>
      </header>

      <section className="detail__field">
        <h2 className="section__label">THE CLAIM</h2>
        <p className="detail__body">{claim}</p>
      </section>

      {/* §3.4's one detail-only field, and the reason this screen has a read of its own. A `null` is a
          legacy row: the section is absent rather than a label drawn over nothing. */}
      {what_it_takes === null ? null : (
        <section className="detail__field">
          <h2 className="section__label">WHAT IT WOULD TAKE</h2>
          <p className="detail__body">{what_it_takes}</p>
        </section>
      )}

      {/* The same rule on §3.3's other nullable field. */}
      {first_step === null ? null : (
        <section className="detail__field">
          <h2 className="section__label">FIRST STEP</h2>
          <p className="detail__body">{first_step}</p>
        </section>
      )}

      {/* T29 — a resolution that did not commit. The detail stays (nothing is removed locally), and this
          notice composes with it: non-destructive, and its one lever is Retry, which re-issues the same
          `decision_id` (§2.2). A `409` never reaches here — it re-reads the deck instead (call 4(b)). */}
      {failure === null ? null : (
        <p className="banner">
          <span className="banner__body" role="status">
            {failure}
          </span>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => resolver.retry(sparkId)}
          >
            Retry
          </button>
        </p>
      )}

      {/* §2's sticky bottom, its three paths in its order: **Make it mine** (ghost, brass text) opens
          the seeded S2 — a route change, not a resolution, so it stays off `dispatch` — then the two
          the seam also draws. */}
      <div className="actionbar">
        <button type="button" className="button button--ghost" onClick={openCapture}>
          Make it mine
        </button>
        <button type="button" className="button" onClick={() => dispatch("ACCEPT")}>
          Good
        </button>
        <button type="button" className="button button--ghost" onClick={() => dispatch("DISMISS")}>
          Not for me
        </button>
      </div>
    </article>
  );
}
