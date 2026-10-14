import { useState } from "react";

import { addDomainTag, removeDomainTag } from "../domain/capture.ts";

/**
 * Domain tags as removable chips plus the dashed **+ add domain** control (`DESIGN.md` §4 badge/chip,
 * §8): a rounded-full chip per tag, and a dashed chip that adds one.
 *
 * Normalisation lives in `domain/capture.ts` — this component only renders and reports the new list,
 * so the same rule that keeps the Vault filter agreeing with §4.4 applies to what the user types here
 * (Review Focus 5).
 */
export function DomainsField(props: {
  tags: string[];
  onChange: (tags: string[]) => void;
  error?: string;
}) {
  const [entry, setEntry] = useState("");

  function commit() {
    props.onChange(addDomainTag(props.tags, entry));
    setEntry("");
  }

  return (
    <div className="field">
      <label className="field__label" htmlFor="domain-tag">
        Domain tag(s)
      </label>
      {props.tags.length > 0 ? (
        <ul className="chips">
          {props.tags.map((tag) => (
            <li key={tag} className="chip">
              <span className="chip__label">{tag}</span>
              <button
                type="button"
                className="chip__remove"
                aria-label={`Remove ${tag}`}
                onClick={() => props.onChange(removeDomainTag(props.tags, tag))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="field__row">
        <input
          id="domain-tag"
          className="field__input"
          placeholder="e.g. fintech"
          value={entry}
          onChange={(event) => setEntry(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
        />
        <button type="button" className="chip chip--add" onClick={commit}>
          + add domain
        </button>
      </div>
      {props.error ? <p className="field__error">{props.error}</p> : null}
    </div>
  );
}
