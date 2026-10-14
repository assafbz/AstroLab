import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../api/client.ts";
import { deleteIdea, getIdeaDetail } from "../api/ideas.ts";
import type { IdeaDetail as IdeaDetailData } from "../api/types.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { Shimmer } from "../components/Shimmer.tsx";
import { deleteWarning } from "../domain/delete-warning.ts";
import { ideaHref } from "../router.ts";

/**
 * S4 Idea Detail (`FLOW.md` §2.1 T21, T26) — one idea: the four fields, the lineage chain, muted
 * provenance, and the one action V8 gives it (Delete).
 *
 * **Reference ids are rendered as the contract returns them, never resolved** (D5, the #80 carry).
 * §4.5 exposes ids only, resolving would cost a request per ref, and a ref that names a tombstone —
 * a deleted fork parent, a deleted provenance source — would `404`. The carry is "render it, don't
 * paper over it": the dangling ref is shown, never dropped and never crashed on.
 *
 * **Delete is orphan-with-warning** (§4.8): the confirm states what it orphans and the server does
 * not block. Until V5 (#16) lands the route, a live delete answers `not_found` — so the action
 * surfaces the envelope's message instead of failing blankly (D7's condition).
 */

type State =
  | { kind: "loading" }
  | { kind: "ready"; detail: IdeaDetailData }
  /** The id is not an idea any more — `not_found` is a state, not an error to retry. */
  | { kind: "missing" }
  | { kind: "error"; message: string };

export function IdeaDetail(props: { id: string }) {
  const { id } = props;
  const [state, setState] = useState<State>({ kind: "loading" });
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
    // A new id is a new idea: the confirm panel and its error do not carry across.
    setConfirming(false);
    setDeleteError(null);
    void load();
  }, [id, load]);

  async function onConfirmDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteIdea(id);
      setConfirming(false);
      window.location.hash = "#/vault";
    } catch (error) {
      // D7 — the envelope, not a blank. `not_found` here means V5 #16 has not landed the route.
      setDeleteError(error instanceof ApiError ? error.message : "Could not delete. Try again.");
      setDeleting(false);
    }
  }

  if (state.kind === "loading") return <Shimmer label="Loading the idea…" />;

  if (state.kind === "missing") {
    return (
      <EmptyState
        title="This idea no longer exists."
        body="It was deleted. Anything that referenced it keeps the reference — nothing else changed."
        action={{ label: "Back to the vault", href: "#/vault" }}
      />
    );
  }

  if (state.kind === "error") {
    return (
      <EmptyState
        title="Couldn’t load this idea."
        body={state.message}
        action={{ label: "Retry", onClick: () => void load() }}
      />
    );
  }

  const { idea, lineage, provenance, referenced_by } = state.detail;
  const warning = deleteWarning(referenced_by);

  return (
    <article className="detail">
      <header className="detail__head">
        <p className="detail__id mono">{idea.id}</p>
        <h1 className="detail__headline">{idea.hypothesis}</h1>
        <ul className="chips">
          {idea.domain_tags.map((tag) => (
            <li key={tag} className="chip chip--static">
              <span className="chip__label">{tag}</span>
            </li>
          ))}
        </ul>
        <p className="detail__meta mono">
          {idea.lineage_kind} · v{idea.current_version}
          {idea.status === "NEEDS_COMPLETION" ? " · needs completion" : ""}
        </p>
      </header>

      <section className="detail__field">
        <h2 className="section__label">Problem solved</h2>
        <p className="detail__body">{idea.problem}</p>
      </section>

      <section className="detail__field">
        <h2 className="section__label">Monetization / value angle</h2>
        <p className="detail__body">{idea.monetization}</p>
      </section>

      <section className="lineage">
        <h2 className="section__label">Living lineage</h2>
        {/* Root-first, ending at this idea (§4.5). A root's chain is its own node — one node, never
            an empty state. */}
        <ol className="chain">
          {lineage.map((ancestor) => (
            <li key={ancestor.id} className="chain__node">
              <a className="chain__link" href={ideaHref(ancestor.id)}>
                <span className="chain__id mono">{ancestor.id}</span>
                <span className="chain__title">{ancestor.hypothesis}</span>
              </a>
            </li>
          ))}
          <li className="chain__node chain__node--current">
            <span className="chain__id mono">{idea.id}</span>
            <span className="chain__title">{idea.hypothesis}</span>
            <span className="chain__marker mono">This idea</span>
          </li>
        </ol>
      </section>

      {/* Absent provenance renders nothing at all — it is not a state the user needs told about. */}
      {provenance.length > 0 ? (
        <section className="provenance">
          <h2 className="section__label">Provenance</h2>
          <ul className="provenance__list">
            {provenance.map((ref) => (
              <li key={`${ref.source_idea_id}:${ref.spark_id}`} className="provenance__ref">
                <span className="provenance__id mono">{ref.source_idea_id}</span>
                <span className="provenance__spark mono">{ref.spark_id}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="actionbar">
        <button
          type="button"
          className="button button--destructive"
          onClick={() => setConfirming(true)}
        >
          Delete idea
        </button>
      </div>

      {confirming ? (
        <section className="confirm" role="alertdialog" aria-labelledby="delete-title">
          <h2 id="delete-title" className="confirm__title">
            {warning.summary}
          </h2>
          {warning.details.map((line) => (
            <p key={line} className="confirm__detail">
              {line}
            </p>
          ))}
          {warning.details.length === 0 ? (
            <p className="confirm__detail">
              Nothing references it — no reference is left dangling.
            </p>
          ) : null}
          {deleteError ? (
            <p className="form-error" role="alert">
              {deleteError}
            </p>
          ) : null}
          <div className="confirm__actions">
            <button
              type="button"
              className="button button--ghost"
              onClick={() => {
                setConfirming(false);
                setDeleteError(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button--destructive"
              disabled={deleting}
              onClick={() => void onConfirmDelete()}
            >
              Delete for good
            </button>
          </div>
        </section>
      ) : null}
    </article>
  );
}
