import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../api/client.ts";
import { sparkDetail } from "../api/sparks.ts";
import type { SparkDetail as SparkDetailData } from "../api/types.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { Shimmer } from "../components/Shimmer.tsx";
import type { ResolutionKind, ResolveSeam } from "../domain/deck-interaction.ts";

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
 * **The decision seat is S3's**, and the call module behind it is K7 `#41`'s; `Make it mine` needs
 * §4.14 and the seeded Capture, which nothing has built yet (#119). What this screen composes is the
 * read; nothing here resolves anything.
 * **The decision seat is here, wired inert, and the call module is K7 `#41`'s.** The detail's Good /
 * Not for me consume the **deck's own** `ResolveSeam` (`domain/deck-interaction.ts`) rather than a
 * second type of their own, so K7 has one shape to plug into per screen and the two screens cannot
 * drift into two payloads. Until K7 lands, a press resolves nothing rather than inventing a request —
 * the seat K2 shipped on the card. `Make it mine` needs §4.14 and the seeded Capture, which nothing has
 * built yet (#119), so no lever is drawn for it.
 */

type State =
  | { kind: "loading" }
  | { kind: "ready"; detail: SparkDetailData }
  /** The id is not a spark any more — `not_found` is a state, not an error to retry (§2). */
  | { kind: "missing" }
  | { kind: "error"; message: string };

/** The seat until K7's call module lands: a press reaches it, and it posts nothing. */
const inertResolve: ResolveSeam = () => {};

export function SparkDetail(props: { id: string; onResolve?: ResolveSeam }) {
  const { id } = props;
  const [state, setState] = useState<State>({ kind: "loading" });

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
  const resolve = props.onResolve ?? inertResolve;

  // The ONE resolution path out of this screen (§5.5's parity, one screen over): both buttons reach the
  // seam through it, and a second, inline dispatch is the divergence the structural guard in
  // `deck-interaction.test.ts` exists for.
  function dispatch(kind: ResolutionKind): void {
    resolve(sparkId, kind);
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

      {/* §2's bottom paths, the two S1b draws: **Not for me** and **Good**, both through the one
          `dispatch`. `Make it mine` is deliberately absent — it needs §4.14's seed and the seeded
          Capture, and a lever that points at nothing is worse than no lever (#119). */}
      <div className="actionbar">
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
