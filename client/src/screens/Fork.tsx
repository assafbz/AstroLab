import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../api/client.ts";
import { forkIdea, getIdeaDetail, listIdeas } from "../api/ideas.ts";
import type { Idea } from "../api/types.ts";
import { DomainsField } from "../components/DomainsField.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Shimmer } from "../components/Shimmer.tsx";
import {
  addDomainTag,
  distinctDomainTags,
  removeDomainTag,
  sameDomainSet,
} from "../domain/capture.ts";
import { isRetryable } from "../domain/decision.ts";
import { forkHref, ideaHref, iterateHref } from "../router.ts";

/**
 * S5 Fork (`FLOW.md` §2.1 T24/T25; `docs/stitch-prompts.md` §6; `docs/API.md` §4.7) — the **branching**
 * path, as distinct from S6's version. A fork is a **new** node whose parent is the source, and its
 * domain set must **differ** from the parent's: a fork widens the vault into a new domain, which is what
 * the flywheel runs on (`PRD.md` §1.2). A same-domain branch is a refinement, and the refinement is S6 —
 * so this screen *offers* Iterate rather than inventing a second path to the same write.
 *
 * **Two entries, one route family** — the `#/capture` / `#/capture/<id>` pairing. `#/fork/<id>` is
 * T24's: the parent comes from the route and is read at §4.5. A bare `#/fork` is E3's entry and carries
 * no parent, so it composes a **parent picker** over §4.4 rather than forking nothing — §4.7 needs a
 * parent, and a picker reuses the vault's own read rather than adding a route or a second transport.
 *
 * **The request is the frozen two fields** (`mutation_delta` + `domain_tags`, `api/ideas.ts`). The
 * fork's three text fields are the **parent's, copied server-side**, so this screen never sends them and
 * never shows an editor for them: what the user writes here is what *changed*.
 *
 * **Same-domain is set equality, mirrored exactly.** §4.7 refuses a fork whose domain set **equals** the
 * parent's (`409`), order- and duplicate-insensitively, and admits a superset — the widening case. The
 * client applies the same rule before the request (`sameDomainSet`) so the offer appears without a
 * round-trip, and answers a `409` with the same offer, because that is the race the rule exists for.
 */

export function Fork(props: { parentId?: string }) {
  // The bare route is E3's, and it has no parent: §4.7 needs one, so it composes the picker.
  return props.parentId === undefined ? <ParentPicker /> : <ForkForm parentId={props.parentId} />;
}

/**
 * `#/fork` without a parent (E3's entry) — the vault's own list, each row a link into the seeded route.
 * It reuses §4.4's read, which is also what the Vault renders, so there is no second idea list in the
 * client and no second transport.
 */
function ParentPicker() {
  const [state, setState] = useState<PickerState>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      setState({ kind: "ready", ideas: await listIdeas() });
    } catch (error) {
      setState({
        kind: "error",
        message:
          error instanceof ApiError && error.code !== "network"
            ? error.message
            : "Could not reach the vault. Check your connection.",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="fork">
      <h1 className="screen__title">Fork</h1>
      <p className="screen__lede">
        A fork widens the vault: pick the idea to branch from, then give the branch a different
        domain.
      </p>

      {state.kind === "loading" ? <Shimmer label="Loading the vault…" /> : null}

      {state.kind === "error" ? (
        <EmptyState
          title="Couldn’t load the vault."
          body={state.message}
          action={{ label: "Retry", onClick: () => void load() }}
        />
      ) : null}

      {state.kind === "ready" && state.ideas.length === 0 ? (
        <EmptyState
          title="Nothing to fork yet."
          body="A fork needs a parent. Capture an idea first — the branch comes after."
          action={{ label: "Add idea", href: "#/capture" }}
        />
      ) : null}

      {state.kind === "ready" && state.ideas.length > 0 ? (
        <ul className="list">
          {state.ideas.map((idea) => (
            <li key={idea.id}>
              <a className="card" href={forkHref(idea.id)}>
                <p className="card__title">{idea.hypothesis}</p>
                <p className="card__meta">
                  <span className="badge">{idea.lineage_kind}</span>
                </p>
                <ul className="chips chips--tight">
                  {idea.domain_tags.map((tag) => (
                    <li key={tag} className="chip chip--static">
                      <span className="chip__label">{tag}</span>
                    </li>
                  ))}
                </ul>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

type PickerState =
  { kind: "loading" } | { kind: "ready"; ideas: Idea[] } | { kind: "error"; message: string };

type ParentState =
  | { kind: "loading" }
  | { kind: "ready"; parent: Idea }
  /** The id is not an idea any more — `not_found` is a state, not an error to retry. */
  | { kind: "missing" }
  | { kind: "error"; message: string };

function ForkForm(props: { parentId: string }) {
  const { parentId } = props;
  const [state, setState] = useState<ParentState>({ kind: "loading" });
  /** The vault's own tags, for the suggestion row — `[]` when that read failed (it is best-effort). */
  const [vaultTags, setVaultTags] = useState<string[]>([]);
  const [delta, setDelta] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  /** Validation runs on the first Create attempt, then live — Capture's rule (§5.2 / T17), reused. */
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  /** The same-domain answer, whether the client caught it or the server did (`409`). */
  const [offerIterate, setOfferIterate] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    // Two reads, one screen. §4.5 is the **parent** and is authoritative — its failure is this screen's.
    // §4.4 is the vault's own tags, read only to fill the suggestion row: a failure there leaves the row
    // absent and the user types the domain instead, which is the whole of the degradation.
    const [parent, ideas] = await Promise.allSettled([getIdeaDetail(parentId), listIdeas()]);
    setVaultTags(ideas.status === "fulfilled" ? distinctDomainTags(ideas.value) : []);

    if (parent.status === "rejected") {
      const error: unknown = parent.reason;
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
      return;
    }
    setState({ kind: "ready", parent: parent.value.idea });
  }, [parentId]);

  useEffect(() => {
    // A new parent is a new fork: neither the delta, nor the domains, nor the offer carries across.
    setDelta("");
    setTags([]);
    setAttempted(false);
    setSaveError(null);
    setRetryable(false);
    setOfferIterate(false);
    void load();
  }, [parentId, load]);

  if (state.kind === "loading") return <Shimmer label="Loading the parent idea…" />;

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

  const { parent } = state;
  // The parent's tags are excluded: the suggestion is a domain the *parent* does not carry, which is
  // exactly the difference §4.7 asks for. None of it is required — the field accepts anything typed.
  const suggestions = vaultTags.filter((tag) => !parent.domain_tags.includes(tag));
  const deltaError =
    attempted && delta.trim() === "" ? "The mutation delta is required" : undefined;
  const domainsError = attempted && tags.length === 0 ? "Add at least one domain" : undefined;

  async function onCreate() {
    setAttempted(true);
    setSaveError(null);
    setRetryable(false);
    setOfferIterate(false);
    if (delta.trim() === "" || tags.length === 0) return;

    // T25 / §4.7 — the fork's domain set must **differ**: an equal set is the same-domain attempt, and
    // the answer to it is Iterate, not a fork. A superset is legal (the widening case).
    if (sameDomainSet(tags, parent.domain_tags)) {
      setOfferIterate(true);
      return;
    }

    setSaving(true);
    try {
      const fork = await forkIdea(parentId, { mutation_delta: delta, domain_tags: tags });
      // T25 — the fork is a **new** node, so the flow lands on its detail (unlike S6, which returns to
      // the node it edited). The id is the server's; nothing is composed here.
      window.location.hash = ideaHref(fork.id);
    } catch (error) {
      // A `409` is the same-domain race the rule above already knows how to answer — the server states
      // it, so the offer is drawn rather than a bare error. Anything retryable keeps the draft whole
      // (T29) and offers the one lever that can help.
      if (error instanceof ApiError && error.code === "conflict") {
        setOfferIterate(true);
        setSaving(false);
        return;
      }
      setSaveError(
        error instanceof ApiError ? error.message : "Could not create the fork. Try again.",
      );
      setRetryable(error instanceof ApiError && isRetryable(error));
      setSaving(false);
    }
  }

  return (
    <div className="fork">
      <header className="fork__head">
        <button
          type="button"
          className="button button--ghost"
          onClick={() => {
            window.location.hash = ideaHref(parentId);
          }}
        >
          Back
        </button>
        <h1 className="screen__title">Fork</h1>
      </header>

      {/* The parent, dimmed and labelled: it is not editable here, because §4.7 copies it verbatim. */}
      <section className="fork__parent" aria-label="Parent idea">
        <p className="section__label">PARENT</p>
        <p className="fork__parent-id mono">{parent.id}</p>
        <p className="fork__parent-headline">{parent.hypothesis}</p>
        <ul className="chips chips--tight">
          {parent.domain_tags.map((tag) => (
            <li key={tag} className="chip chip--static">
              <span className="chip__label">{tag}</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="field">
        <label className="field__label" htmlFor="fork-delta">
          Mutation delta
        </label>
        <input
          id="fork-delta"
          className="field__input"
          value={delta}
          onChange={(event) => setDelta(event.target.value)}
        />
        <p className="field__note mono">Say what changes. The parent stays intact.</p>
        {deltaError ? <p className="field__error">{deltaError}</p> : null}
      </div>

      <DomainsField tags={tags} onChange={setTags} error={domainsError} />

      {suggestions.length > 0 ? (
        <div className="fork__suggest">
          <p className="field__note">
            Pick a domain you haven’t used — forks widen the vault, and a wider vault makes better
            sparks.
          </p>
          <ul className="chips chips--tight">
            {suggestions.map((tag) => (
              <li key={tag}>
                <button
                  type="button"
                  className={`chip chip--filter${tags.includes(tag) ? " chip--active" : ""}`}
                  aria-pressed={tags.includes(tag)}
                  onClick={() =>
                    setTags((current) =>
                      current.includes(tag)
                        ? removeDomainTag(current, tag)
                        : addDomainTag(current, tag),
                    )
                  }
                >
                  <span className="chip__label">{tag}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* What will be recorded — single-parent lineage, and the domain it lands in (§6's quiet card). */}
      <p className="fork__record mono">
        Fork of {parent.id} ·{" "}
        {tags.length > 0 ? `domain ${tags.map((tag) => `#${tag}`).join(", ")}` : "no domain yet"}
      </p>

      {offerIterate ? (
        <p className="form-error" role="alert">
          That is the parent’s own domain — a same-domain branch is a refinement, not a fork.{" "}
          <a className="fork__offer" href={iterateHref(parent.id)}>
            Iterate instead
          </a>
        </p>
      ) : null}

      <div className="actionbar">
        {saveError === null ? null : (
          <p className="form-error" role="alert">
            {saveError}
            {retryable ? (
              <button
                type="button"
                className="button button--ghost"
                onClick={() => void onCreate()}
              >
                Retry
              </button>
            ) : null}
          </p>
        )}
        <button type="button" className="button" disabled={saving} onClick={() => void onCreate()}>
          Create fork
        </button>
      </div>
    </div>
  );
}
