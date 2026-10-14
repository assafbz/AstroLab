/**
 * The one way this app renders "nothing here" (`DESIGN.md` §4: *"Empty States. Composed, prompting —
 * never a bare 'No ideas yet.'"*). Routing every absent state through one component is what keeps a
 * bare line of text from creeping back in.
 *
 * The action is an anchor when its destination is a route and a button when it is an in-place action
 * (Retry, clear the filter) — at the keyboard the two behave differently, so they are not
 * interchangeable.
 */
export function EmptyState(props: {
  title: string;
  body: string;
  action?: { label: string; href?: string; onClick?: () => void };
}) {
  return (
    <section className="empty">
      <h2 className="empty__title">{props.title}</h2>
      <p className="empty__body">{props.body}</p>
      {props.action ? (
        props.action.href ? (
          <a className="button" href={props.action.href}>
            {props.action.label}
          </a>
        ) : (
          <button type="button" className="button" onClick={props.action.onClick}>
            {props.action.label}
          </button>
        )
      ) : null}
    </section>
  );
}
