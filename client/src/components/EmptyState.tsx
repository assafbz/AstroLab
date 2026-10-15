/**
 * The one way this app renders "nothing here" (`DESIGN.md` §4: *"Empty States. Composed, prompting —
 * never a bare 'No ideas yet.'"*). Routing every absent state through one component is what keeps a
 * bare line of text from creeping back in.
 *
 * The action is an anchor when its destination is a route and a button when it is an in-place action
 * (Retry, clear the filter) — at the keyboard the two behave differently, so they are not
 * interchangeable. `secondary` is the quieter lever beside the primary, for the states that compose
 * more than one (`DESIGN.md` §9 E3: *Add idea* / *Recompute*).
 */
type EmptyAction = { label: string; href?: string; onClick?: () => void };

export function EmptyState(props: {
  title: string;
  body: string;
  action?: EmptyAction;
  /** A second action, drawn ghost; `undefined` renders the composition the single-action callers have. */
  secondary?: EmptyAction;
}) {
  return (
    <section className="empty">
      <h2 className="empty__title">{props.title}</h2>
      <p className="empty__body">{props.body}</p>
      <div className="empty__actions">
        <Action action={props.action} />
        <Action action={props.secondary} quiet />
      </div>
    </section>
  );
}

function Action(props: { action?: EmptyAction; quiet?: boolean }) {
  const { action } = props;
  if (!action) return null;

  return action.href ? (
    <a className={props.quiet ? "button button--ghost" : "button"} href={action.href}>
      {action.label}
    </a>
  ) : (
    <button
      type="button"
      className={props.quiet ? "button button--ghost" : "button"}
      onClick={action.onClick}
    >
      {action.label}
    </button>
  );
}
