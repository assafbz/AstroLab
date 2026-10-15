import { useRef } from "react";

import type { Spark } from "../api/types.ts";
import { SWIPE_DISTANCE_PX, type ResolutionKind, swipeKind } from "../domain/deck-interaction.ts";
import type { ResolveSeam } from "../domain/deck-interaction.ts";

/**
 * S3 — the **Spark Card** (`DESIGN.md` §4, §9; `FLOW.md` §2.2, §5.5): one proposed spark, presented
 * as an idea, judged by a swipe or a button.
 *
 * **What it renders is the `Spark` projection and nothing else** (`docs/API.md` §3.3, K1 `#35`; the
 * `first_step` row is #115): the idea (`direction`), the claim, the **first step**, and the raw
 * `domain_tags` chips — in `docs/stitch-prompts.md` §1's order. There is no score, no
 * distance/alignment readout, no origin line and no source ids — that is the governance rule, not a
 * shortfall, and a chip may be **provisional** (the card shows the raw tag and never reads it as a
 * resolved cluster, §3.3). A `null` `first_step` is a legacy row, and the row is omitted rather than
 * drawn empty.
 *
 * **Parity is structural here** (§5.5): the swipe and both buttons resolve through the single
 * `dispatch` below and construct no payload of their own — `deck-interaction.test.ts` fails on a
 * second call site, and `SparkCard.test.tsx` asserts a swipe right and a `Good` press hand the seam
 * *identical* arguments.
 *
 * **The card does not resolve.** It calls the injected seam; the call is K4 `#38`'s
 * (`POST /v1/sparks/{id}/decision`), so this component holds no transport and imports no API value.
 */
export function SparkCard(props: {
  spark: Spark;
  /** The one resolution path out of the card (§5.5). Supplied by the screen. */
  onResolve: ResolveSeam;
  /** §6's gesture threshold; a test narrows it rather than fabricating a page-sized drag. */
  swipeDistance?: number;
}) {
  const { spark, onResolve } = props;
  const distance = props.swipeDistance ?? SWIPE_DISTANCE_PX;
  /** Where the current drag began, or `null` when no drag is open. */
  const dragStartX = useRef<number | null>(null);

  // The ONE resolution path. Every affordance on this card reaches the seam through it — a second,
  // inline `onResolve` is the divergence the structural guard exists for.
  function dispatch(kind: ResolutionKind): void {
    onResolve(spark.id, kind);
  }

  return (
    <article
      className="card sparkcard"
      aria-label="Spark"
      onPointerDown={(event) => {
        dragStartX.current = event.clientX;
      }}
      onPointerUp={(event) => {
        if (dragStartX.current === null) return;
        const kind = swipeKind(dragStartX.current, event.clientX, distance);
        dragStartX.current = null;
        // A drag under the threshold is not a gesture; the buttons stay the only path it can take.
        if (kind !== null) dispatch(kind);
      }}
    >
      <p className="section__label">THE IDEA</p>
      <h2 className="sparkcard__idea">{spark.direction}</h2>
      <p className="section__label">THE CLAIM</p>
      <p className="sparkcard__claim">{spark.claim}</p>
      {/* The card's third element, in §1's order — between THE CLAIM and the chips. A `null` is a
          legacy row (§3.3), and it renders as *absent*: no label over nothing, and no filler the
          payload did not carry. */}
      {spark.first_step === null ? null : (
        <>
          <p className="section__label">FIRST STEP</p>
          <p className="sparkcard__firststep">{spark.first_step}</p>
        </>
      )}
      <ul className="chips chips--tight sparkcard__domains">
        {spark.domain_tags.map((tag) => (
          <li key={tag} className="chip chip--static">
            <span className="chip__label">{tag}</span>
          </li>
        ))}
      </ul>
      <div className="actionbar">
        {/* §4: both directions work as swipes, and the explicit buttons stay at ≥44px. */}
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
