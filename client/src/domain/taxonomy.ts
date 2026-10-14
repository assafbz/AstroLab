/**
 * The S0 picker's list (`store/seed/README.md`, curation rule 2; `ARCHITECTURE.md` §3.2, option a).
 *
 * **This is a copy, and the copy is the client's only reachable source.** No endpoint exposes the
 * taxonomy (`ARCHITECTURE.md` §6 gives S0 `POST /v1/ideas` + `GET /v1/vault/summary`), the shipped
 * file is YAML read by `store`'s loader at boot, and `client` may not import `store` (`domain-seed.ts`
 * reads `node:fs`). So the 28 clusters are mirrored here — and `taxonomy.test.ts` reads the shipped
 * YAML and fails if this list drifts from it, which is what makes the copy safe rather than a rumour.
 *
 * **The value is the cluster `key`; the label is `name`.** `store/seed/README.md` rule 2: *"The S0
 * picker is this list … the picker's value is the cluster key (`ai-ml`, `retail-commerce`). The loader
 * registers each cluster's key — and only the key — as a tag in its own cluster … The `name:` label is
 * what S0 renders and is **never** registered as a tag: normalising a label mints rows like `ai-&-ml`."*
 * A pick therefore **resolves by construction** (no AI on this path), which is what lets the salted
 * `≥ 2` spread gate stay deterministic (R1). Sending `name` instead of `key` is the silent failure this
 * module exists to prevent.
 *
 * **The order is the file's order**, kept deliberately: it is the curated order, coherent with the
 * README's six-family presentation grouping, and that grouping is *not stored* anywhere — so
 * re-sorting (or inventing a grouping of our own) would add a structure the artifact does not carry.
 */

/** One shipped domain cluster, as S0 offers it. */
export interface DomainCluster {
  /** The picker's value — the tag the loader registers in `domain_map` (`ai-ml`). */
  key: string;
  /** The picker's label — display only, never written as a tag (`AI & ML`). */
  name: string;
}

/** The 28 shipped clusters, in `store/seed/domain-taxonomy.yaml` order. */
export const DOMAIN_CLUSTERS: readonly DomainCluster[] = [
  { key: "devtools", name: "Developer tools" },
  { key: "data-infra", name: "Data infrastructure" },
  { key: "ai-ml", name: "AI & ML" },
  { key: "cybersecurity", name: "Cybersecurity" },
  { key: "fintech", name: "Fintech" },
  { key: "marketplaces", name: "Marketplaces" },
  { key: "retail-commerce", name: "Retail & commerce" },
  { key: "sales-support", name: "Sales & support" },
  { key: "marketing-growth", name: "Marketing & growth" },
  { key: "health", name: "Health" },
  { key: "biotech", name: "Biotech" },
  { key: "agriculture-food", name: "Agriculture & food" },
  { key: "personal-life", name: "Personal & lifestyle" },
  { key: "mobility", name: "Mobility & logistics" },
  { key: "manufacturing", name: "Manufacturing" },
  { key: "hardware-iot", name: "Hardware & IoT" },
  { key: "climate-energy", name: "Climate & energy" },
  { key: "space-defense", name: "Space & defense" },
  { key: "education", name: "Education" },
  { key: "hr-work", name: "Work & HR" },
  { key: "legal-compliance", name: "Legal & compliance" },
  { key: "public-sector", name: "Public sector & civic" },
  { key: "enterprise-ops", name: "Business operations" },
  { key: "consumer-social", name: "Consumer & social" },
  { key: "media-entertainment", name: "Media & entertainment" },
  { key: "travel", name: "Travel & hospitality" },
  { key: "real-estate", name: "Real estate & construction" },
  { key: "arts-culture", name: "Arts & culture" },
];
