import { useRef } from "react";

import type { Spark } from "../api/types.ts";
import {
  SWIPE_DISTANCE_PX,
  type ResolutionKind,
  isTap,
  swipeKind,
} from "../domain/deck-interaction.ts";
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
 *
 * **A tap opens S1b** (T08) through a second, equally injected seam — `onOpen` — and it is *not* a
 * resolution, so it stays off `onResolve` and the one-call-site guard keeps its count of one. The
 * hazard is that the pointer stream is **shared**: the `pointerup` that ends a press on the *Good*
 * button bubbles to this card's own handler, so the tap carries two guards — it must be a press that
 * stayed put on both axes (not a scroll), and it must not have landed on a control.
 *
 * **The same open is reachable from the keyboard** (#129): the idea heading is a real `<button>`, so
 * Tab focuses it and **Enter/Space** are the browser's own activation — no hand-rolled `onKeyDown`
 * that could drift from the pointer tap. It is a **sibling** of `Good` / `Not for me`, not their
 * container: activating one of those never reaches the heading, which is the keyboard form of the
 * *"landed on a control"* guard — and there is no `isTap` travel guard to carry here, because a
 * keydown has no travel to measure. The pointer tap keeps the article; both arms call the one `open()`.
 */
export function SparkCard(props: {
  spark: Spark;
  /** The one resolution path out of the card (§5.5). Supplied by the screen. */
  onResolve: ResolveSeam;
  /**
   * T08 — the open that leads to `#/sparks/<id>` (the pointer tap and #129's keyboard arm). Supplied
   * by the screen; absent, the card renders the idea as plain text and never opens.
   */
  onOpen?: (id: string) => void;
  /** §6's gesture threshold; a test narrows it rather than fabricating a page-sized drag. */
  swipeDistance?: number;
}) {
  const { spark, onResolve, onOpen } = props;
  const distance = props.swipeDistance ?? SWIPE_DISTANCE_PX;
  /** Where the current press began, or `null` when no press is open. */
  const pressStart = useRef<{ x: number; y: number } | null>(null);

  // The ONE resolution path. Every affordance on this card reaches the seam through it — a second,
  // inline `onResolve` is the divergence the structural guard exists for.
  function dispatch(kind: ResolutionKind): void {
    onResolve(spark.id, kind);
  }

  // The ONE open path (T08), shared by the pointer tap and the heading button (#129): a second inline
  // open call is the divergence the structural guard exists for.
  function open(): void {
    onOpen?.(spark.id);
  }

  return (
    <article
      className="card sparkcard"
      aria-label="Spark"
      onPointerDown={(event) => {
        pressStart.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={(event) => {
        const from = pressStart.current;
        pressStart.current = null;
        if (from === null) return;
        const kind = swipeKind(from.x, event.clientX, distance);
        if (kind !== null) {
          dispatch(kind);
          return;
        }
        // Not a swipe. A press that stayed put is a **tap** on the card (T08) — unless it landed on a
        // control, whose own click it is: this pointer stream is shared, so a Good press bubbles here
        // too, and without the control guard the tap would navigate on every resolution.
        if (!isTap(from.x, from.y, event.clientX, event.clientY)) return;
        if (event.target instanceof Element && event.target.closest(CONTROL_SELECTOR) !== null)
          return;
        open();
      }}
    >
      <p className="section__label">THE IDEA</p>
      {/* #129: the heading is the keyboard arm of T08. With no `onOpen` it renders as plain text —
          the card never opens, so the app path cannot invent an open if a wiring is dropped. */}
      <h2 className="sparkcard__idea">
        {onOpen === undefined ? (
          spark.direction
        ) : (
          <button type="button" className="sparkcard__idea-open" onClick={open}>
            {spark.direction}
          </button>
        )}
      </h2>
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

/**
 * The controls a press can land on: a press there belongs to the control, never to the card. Stated
 * once, and by role rather than by the action bar's class — a control added to the card later is
 * covered without a second rule to keep in step.
 */
const CONTROL_SELECTOR = "button, a, input, select, textarea";
