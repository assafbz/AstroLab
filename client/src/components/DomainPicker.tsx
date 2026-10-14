import { useState } from "react";

import {
  chooseCluster,
  chooseFreeText,
  isProvisional,
  type DomainChoice,
} from "../domain/onboarding.ts";
import { DOMAIN_CLUSTERS } from "../domain/taxonomy.ts";

/**
 * S0's domain input: a pick from the shipped taxonomy **plus the `Other → free text` escape**
 * (`FLOW.md` §4.2/T02, r3.3). Not S2's `DomainsField` — that one is a free-text chip list; this one's
 * *primary* path is the picker, which is what makes a picked tag resolved by construction.
 *
 * The component owns only the *input* state (which option is selected, what has been typed) and reports
 * the resolved `DomainChoice` upward. The rules live in `domain/onboarding.ts`.
 */

/** The select's sentinel for the escape lane — never a cluster key, so it cannot collide with one. */
const OTHER = "__other";

export function DomainPicker(props: {
  value: DomainChoice | null;
  onChange: (choice: DomainChoice | null) => void;
  error?: string;
}) {
  const [selected, setSelected] = useState<string>("");
  const [entry, setEntry] = useState("");

  function onSelect(next: string) {
    setSelected(next);
    if (next === "") props.onChange(null);
    else if (next === OTHER) props.onChange(chooseFreeText(entry));
    else {
      const cluster = DOMAIN_CLUSTERS.find((candidate) => candidate.key === next);
      props.onChange(cluster ? chooseCluster(cluster) : null);
    }
  }

  function onEntry(next: string) {
    setEntry(next);
    props.onChange(chooseFreeText(next));
  }

  const provisional = props.value !== null && isProvisional(props.value);
  const noteId = "domain-note";

  return (
    <div className="field">
      <label className="field__label" htmlFor="domain-pick">
        Domain
      </label>
      <select
        id="domain-pick"
        className="field__input"
        value={selected}
        aria-describedby={noteId}
        onChange={(event) => onSelect(event.target.value)}
      >
        <option value="">Choose a domain…</option>
        {DOMAIN_CLUSTERS.map((cluster) => (
          // The value is the cluster KEY; the label is its name. A name is never a tag.
          <option key={cluster.key} value={cluster.key}>
            {cluster.name}
          </option>
        ))}
        <option value={OTHER}>Other — free text</option>
      </select>

      {selected === OTHER ? (
        <div className="field__row">
          <input
            id="domain-other"
            className="field__input"
            aria-label="Your domain, in your own words"
            placeholder="e.g. urban beekeeping"
            value={entry}
            onChange={(event) => onEntry(event.target.value)}
          />
        </div>
      ) : null}

      {props.value ? (
        <ul className="chips chips--tight">
          <li className={provisional ? "chip chip--provisional" : "chip"}>
            <span className="chip__label">{props.value.tag}</span>
            {provisional ? <span className="chip__flag">provisional</span> : null}
          </li>
        </ul>
      ) : null}

      <p className="field__note" id={noteId}>
        {provisional
          ? "Provisional — counted toward your progress once the engine has resolved it."
          : "Picked from the shipped list, so it counts as a domain straight away."}
      </p>

      {props.error ? <p className="field__error">{props.error}</p> : null}
    </div>
  );
}
