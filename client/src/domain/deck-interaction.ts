/**
 * S3's **interaction seam** (`FLOW.md` §5.5, §2.2; `DESIGN.md` §4, §6).
 *
 * S1's deck is judged by a gesture **and** a button, and §5.5 makes the gesture *"a shortcut for the
 * button, never a separate path"*: both dispatch the identical command with an identical payload, so
 * the resulting state is the same. The failure this module exists to make impossible is a divergence —
 * two call sites that construct their own payload — so there is exactly **one** seam
 * (`onResolve(sparkId, kind)`) and exactly **one** mapping from a gesture to a kind, here.
 *
 * Pure: no request, no React, no state. The card holds the seam; the screen supplies it; **the
 * resolution call itself is K4 `#38`** (its `POST /v1/sparks/{id}/decision`), not this slice.
 *
 * The module also owns the gesture that **does not** resolve: T08's **tap**, which opens S1b. It is
 * here for the same reason the swipe is — a gesture is a rule, and the card reads it rather than
 * deciding it — and it stays off the seam, so the one-call-site count above is untouched by it.
 */

/** `docs/API.md` §3.6 — a decision's `kind`, verbatim. */
export type ResolutionKind = "ACCEPT" | "DISMISS" | "INSPIRED";

/**
 * The one way a resolution leaves the card. `ACCEPT` / `DISMISS` are the deck's two; `INSPIRED` is
 * §2.2's button-only *"Use as inspiration"*, which opens S2 seeded rather than posting from here
 * (§4.13 accepts only the first two) — the type carries it so a later slice does not have to widen
 * the seam, and no caller has to guess.
 */
export type ResolveSeam = (sparkId: string, kind: ResolutionKind) => void;

/**
 * §6's gesture threshold, in device-independent px: a drag shorter than this is not a swipe. A prop on
 * the card overrides it, so a test can exercise both sides of the boundary without synthesising a
 * gesture that depends on the size of the thing drawn.
 */
export const SWIPE_DISTANCE_PX = 48;

/**
 * The gesture's kind, from the drag's start and end `x` — §2.2's axis, read once: **right is ACCEPT**,
 * **left is DISMISS**, and a drag under the threshold resolves **nothing** (`null` is not a third
 * kind; it is "no gesture", so the card's `onClick` path stays the only one that fires).
 *
 * It reads only the horizontal axis: the card is a vertical list item, and honouring a diagonal would
 * make an ordinary scroll along the deck ambiguous with a dismissal.
 */
export function swipeKind(
  fromX: number,
  toX: number,
  distance: number = SWIPE_DISTANCE_PX,
): ResolutionKind | null {
  const dx = toX - fromX;
  if (Math.abs(dx) < distance) return null;
  return dx > 0 ? "ACCEPT" : "DISMISS";
}

/**
 * §6's **tap tolerance**, in px: a press that travelled less than this on **both** axes is a tap —
 * `FLOW.md` §4.5 **T08**, *"tap card → expand the spark"*, which is the deck's one way into S1b.
 */
export const TAP_SLOP_PX = 10;

/**
 * Whether a completed press is a **tap** (T08) rather than a drag.
 *
 * It reads **both** axes, and that asymmetry with `swipeKind` is deliberate: a swipe is judged on the
 * horizontal axis alone so an ordinary vertical scroll never resolves a card — but the same leniency
 * on a tap would read *every* scroll as an open, because the deck and the list both scroll. The
 * boundary is exclusive (a press that travelled exactly the slop is a drag), pinned by a test.
 */
export function isTap(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  slop: number = TAP_SLOP_PX,
): boolean {
  return Math.abs(toX - fromX) < slop && Math.abs(toY - fromY) < slop;
}
