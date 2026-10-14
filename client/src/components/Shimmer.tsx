/**
 * The system's only loader: a skeletal shimmer at Card dimensions (`DESIGN.md` §4 — *"no circular
 * spinners"*, and §7 bans them outright).
 *
 * It animates opacity alone (§6), and it is `aria-hidden` with a visually-hidden status line beside
 * it, so a screen reader hears the `label` (which names the screen) rather than three empty
 * cards.
 */
export function Shimmer(props: { label?: string } = {}) {
  return (
    <>
      <p className="sr-only" role="status">
        {props.label ?? "Loading…"}
      </p>
      <ul className="list" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <li key={index} className="card card--shimmer">
            <span className="shimmer__line" />
            <span className="shimmer__line shimmer__line--short" />
          </li>
        ))}
      </ul>
    </>
  );
}
