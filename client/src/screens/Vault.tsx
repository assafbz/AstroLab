import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../api/client.ts";
import { listIdeas } from "../api/ideas.ts";
import type { Idea, VaultFilters } from "../api/types.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { Shimmer } from "../components/Shimmer.tsx";
import { distinctDomainTags } from "../domain/capture.ts";
import { completionPrompt } from "../domain/completion.ts";
import { ideaHref } from "../router.ts";

/**
 * S3 Vault (`FLOW.md` §2.1 T19–T21) — the list, with a domain filter and a lineage filter.
 *
 * Three absent states are deliberately distinct, and none of them is bare:
 * a **pristine empty** vault composes an invitation with the Add idea CTA (T19); a **filtered
 * empty** result names the filter and offers to clear it (T20); a **load failure** is a
 * non-destructive error with Retry that leaves the loaded list alone (T29).
 *
 * K8 `#42` adds T27's **polish prompt** to a card: a `NEEDS_COMPLETION` idea already carries the
 * badge, and the prompt is the actionable half — *what* to add. It is prose inside the card's own
 * link (the card tap opens S4, where the field is supplied), never a nested control: an `<a>` inside
 * an `<a>` is invalid, and the card is already the affordance.
 */

const LINEAGES: ReadonlyArray<Idea["lineage_kind"]> = ["ROOT", "FORK"];

export function Vault() {
  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const [domains, setDomains] = useState<string[]>([]);
  const [domain, setDomain] = useState<string | null>(null);
  const [lineage, setLineage] = useState<Idea["lineage_kind"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (filters: VaultFilters) => {
    setError(null);
    try {
      const list = await listIdeas(filters);
      setIdeas(list);
      // D6 — the palette is captured **once** and only from an unfiltered load: no taxonomy
      // endpoint is wired in V8, and rebuilding it from a filtered result would make the chips
      // vanish exactly when they are needed to undo the filter. This guard *is* the capture-once
      // rule — a second `current.length > 0` guard inside it would mask this one.
      // The palette is the vault's own distinct tags (`domain/capture.ts`), the only honest one (D6).
      if (filters.domain == null && filters.lineage == null) setDomains(distinctDomainTags(list));
    } catch (err) {
      // Non-destructive (T29, NFR-D1): the loaded list stays; only the banner changes.
      setError(
        err instanceof ApiError && err.code !== "network"
          ? err.message
          : "Could not reach the vault. Check your connection.",
      );
    }
  }, []);

  useEffect(() => {
    void load({});
  }, [load]);

  function applyFilter(next: { domain: string | null; lineage: Idea["lineage_kind"] | null }) {
    setDomain(next.domain);
    setLineage(next.lineage);
    void load({ domain: next.domain, lineage: next.lineage });
  }

  const filtered = domain !== null || lineage !== null;
  const retry = () => void load({ domain, lineage });

  return (
    <div className="vault">
      <h1 className="screen__title">Vault</h1>

      {domains.length > 0 || filtered ? (
        <div className="filters">
          <div className="filterrow" role="group" aria-label="Filter by lineage">
            <button
              type="button"
              className="chip chip--filter"
              aria-pressed={lineage === null}
              onClick={() => applyFilter({ domain, lineage: null })}
            >
              <span className="chip__label">ALL</span>
            </button>
            {LINEAGES.map((kind) => (
              <button
                key={kind}
                type="button"
                className={`chip chip--filter${lineage === kind ? " chip--active" : ""}`}
                aria-pressed={lineage === kind}
                onClick={() => applyFilter({ domain, lineage: kind })}
              >
                <span className="chip__label">{kind}</span>
              </button>
            ))}
          </div>
          <div className="filterrow" role="group" aria-label="Filter by domain">
            {domains.map((tag) => (
              <button
                key={tag}
                type="button"
                className={`chip chip--filter${domain === tag ? " chip--active" : ""}`}
                aria-pressed={domain === tag}
                onClick={() => applyFilter({ domain: domain === tag ? null : tag, lineage })}
              >
                <span className="chip__label">{tag}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {ideas === null ? (
        error ? (
          <EmptyState
            title="Couldn’t load the vault."
            body={error}
            action={{ label: "Retry", onClick: retry }}
          />
        ) : (
          <Shimmer label="Loading the vault…" />
        )
      ) : (
        <>
          {error ? (
            <div className="banner" role="alert">
              <p className="banner__body">{error}</p>
              <button type="button" className="button button--ghost" onClick={retry}>
                Retry
              </button>
            </div>
          ) : null}

          {ideas.length === 0 ? (
            filtered ? (
              <EmptyState
                title={domain ? `No ideas in ${domain}.` : `No ideas with lineage ${lineage}.`}
                body="Widen the filter, or capture something new."
                action={{
                  label: "Clear filters",
                  onClick: () => applyFilter({ domain: null, lineage: null }),
                }}
              />
            ) : (
              <EmptyState
                title="Your vault is empty."
                body="Every idea starts as a hypothesis. Capture yours — two domains is where sparks begin."
                action={{ label: "Add idea", href: "#/capture" }}
              />
            )
          ) : (
            <ul className="list">
              {ideas.map((idea) => (
                <li key={idea.id}>
                  <a className="card" href={ideaHref(idea.id)}>
                    <p className="card__title">{idea.hypothesis}</p>
                    <p className="card__meta">
                      <span className="badge">{idea.lineage_kind}</span>
                      {idea.status === "NEEDS_COMPLETION" ? (
                        <span className="badge badge--attention">Needs completion</span>
                      ) : null}
                    </p>
                    {/* K8 `#42` — T27's prompt: the badge names the status, this names the next move. */}
                    {idea.status === "NEEDS_COMPLETION" ? (
                      <p className="card__prompt">{completionPrompt(idea)}</p>
                    ) : null}
                    <ul className="chips chips--tight">
                      {idea.domain_tags.map((tag) => (
                        <li key={tag} className="chip">
                          <span className="chip__label">{tag}</span>
                        </li>
                      ))}
                    </ul>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
