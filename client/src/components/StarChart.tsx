import type { VaultSummary } from "../api/types.ts";
import { progress } from "../domain/onboarding.ts";

/**
 * The `domains covered x / 3` readout and the star-chart mark (`FLOW.md` §5.2; `DESIGN.md` §6, §9).
 *
 * Extracted so S0 (`screens/Onboarding.tsx`) and S1's E0 composition (`DESIGN.md` §9) render the
 * *same* mark rather than two copies that drift. It takes a resolved summary and nothing else — the
 * fetch, the loading line and the unreachable state stay with the screen that owns the read.
 *
 * **No arcs.** `DESIGN.md` §6 draws *"brass arcs … between points that are far apart"*, but no S0
 * endpoint exposes `domain_cluster.adjacency` (`ARCHITECTURE.md` §6 gives S0 `POST /v1/ideas` +
 * `GET /v1/vault/summary`) — and §6 bars the client from computing scores at all. So the mark renders
 * what the client can reach: the rings, one brass point per **resolved** domain and one pale point per
 * **provisional** one. It still *"visibly widens as domains are covered"*, which is the criterion.
 *
 * **One displayed quantity.** The mark and the sr announcement read the *same* capped value the
 * readout prints — `progress().covered`, not the raw `resolved_domains`. A `resolved: 5, target: 3`
 * vault would otherwise render `3 / 3` beside five brass points and "5 covered domains": three
 * elements, two numbers. The full census is the Vault screen's to show.
 */
export function StarChart(props: { summary: VaultSummary }) {
  const p = progress(props.summary);
  const covered = p.covered;
  const provisional = props.summary.provisional_domains;
  const segments = Array.from({ length: p.target }, (_, index) => index < p.covered);

  return (
    <section className="progress" aria-label="Domains covered">
      <p className="progress__label">Domains covered</p>
      <p className="progress__value">
        {p.covered} / {p.target}
      </p>
      <div className="progress__bar" aria-hidden="true">
        {segments.map((filled, index) => (
          <span
            key={index}
            className={filled ? "progress__seg progress__seg--filled" : "progress__seg"}
          />
        ))}
      </div>
      <div className="chart" aria-hidden="true">
        <span className="chart__ring chart__ring--outer" />
        <span className="chart__ring chart__ring--middle" />
        <span className="chart__ring chart__ring--inner" />
        <span className="chart__points">
          {Array.from({ length: covered }, (_, index) => (
            <span key={`c${index}`} className="star star--covered" />
          ))}
          {Array.from({ length: provisional }, (_, index) => (
            <span key={`p${index}`} className="star star--provisional" />
          ))}
        </span>
      </div>
      <p className="sr-only">
        Star chart: {covered} covered {covered === 1 ? "domain" : "domains"}, {provisional}{" "}
        provisional.
      </p>
    </section>
  );
}
