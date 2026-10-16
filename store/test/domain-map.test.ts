import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";

import {
  newDomainFlag,
  readClusterAdjacency,
  readClusters,
  readDomainMap,
  upsertDomainTag,
} from "../src/domain-map.js";
import { migrate } from "../src/migrate.js";
import { MIGRATIONS } from "../src/migrations.js";
import { seedDomainTaxonomy } from "../src/domain-seed.js";
import { openStore } from "../src/store.js";
import { insertIdea, rows } from "./seed.js";

/**
 * The domain vocabulary's SQL (W4 #29; `ARCHITECTURE.md` §2.4, §3.2) — the reads Axis 1 makes and the
 * one write it makes: the cached normalisation of a provisional tag.
 *
 * The load-bearing blocks are the **exact-raw-tag key** (the S3 exact-match filter and
 * `api/src/vault-summary.test.ts`'s raw-cased-tag test both rest on it) and the **non-stamping**
 * property — this write is the `idea_mechanism` exception (Max's #78), and "no revision bump, no run"
 * must be guarded **where the write lives**.
 */

const dirs: string[] = [];
const opened: DatabaseSync[] = [];

function migrated(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "astrolab-domain-map-"));
  dirs.push(dir);
  const db = openStore(join(dir, "astrolab.sqlite"));
  opened.push(db);
  migrate(db, MIGRATIONS);
  seedDomainTaxonomy(db);
  return db;
}

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readClusters — the shipped taxonomy's vocabulary (§2.4)", () => {
  test("returns the seeded clusters, sorted by id", () => {
    const db = migrated();
    const clusters = readClusters(db);
    expect(clusters.length).toBeGreaterThan(20);
    expect(clusters.map((cluster) => cluster.id)).toEqual(
      [...clusters.map((cluster) => cluster.id)].sort(),
    );
    expect(clusters).toContainEqual({ id: "fintech", name: "Fintech" });
  });
});

describe("readClusterAdjacency — symmetrised on read (§2.4)", () => {
  test("the seed lists a pair once; the read carries both directions", () => {
    const db = migrated();
    const adjacency = readClusterAdjacency(db);
    expect(adjacency.get("fintech")?.get("marketplaces")).toBe(1);
    expect(adjacency.get("marketplaces")?.get("fintech")).toBe(1);
    expect(adjacency.get("fintech")?.get("ai-ml")).toBe(2);
    expect(adjacency.get("fintech")?.get("education")).toBeUndefined();
  });
});

describe("readDomainMap — the mapping, by exact tag (§3.2 step 1)", () => {
  test("returns only the tags that resolve", () => {
    const db = migrated();
    const mapped = readDomainMap(db, ["fintech", "payments", "ghost"]);
    expect(mapped.get("fintech")).toBe("fintech");
    expect(mapped.get("payments")).toBe("fintech");
    expect(mapped.has("ghost")).toBe(false);
    expect(mapped.size).toBe(2);
  });

  test("an empty tag list reads nothing", () => {
    expect(readDomainMap(migrated(), [])).toEqual(new Map());
  });
});

describe("upsertDomainTag — the cached normalisation write (§3.2 step 2)", () => {
  test("writes a row readDomainMap returns; a repeat is a no-op, a re-point replaces in place", () => {
    const db = migrated();
    upsertDomainTag(db, "neobank-xyz", "fintech");
    expect(readDomainMap(db, ["neobank-xyz"]).get("neobank-xyz")).toBe("fintech");

    upsertDomainTag(db, "neobank-xyz", "fintech");
    upsertDomainTag(db, "neobank-xyz", "health");
    expect(readDomainMap(db, ["neobank-xyz"]).get("neobank-xyz")).toBe("health");
    expect(rows(db, "SELECT count(*) AS n FROM domain_map WHERE tag = 'neobank-xyz'")[0]?.n).toBe(
      1,
    );
  });

  test("the key is the exact raw tag — never lower-cased or trimmed (David's addition)", () => {
    // Capture stores the tag raw (ARCH §3.2) and the worker "writes that exact spelling back"; a
    // normaliser that lower-cased here would invent a second vocabulary and break the S3 filter.
    const db = migrated();
    upsertDomainTag(db, "Fintech", "fintech");
    upsertDomainTag(db, " padded ", "health");

    expect(readDomainMap(db, ["Fintech"]).get("Fintech")).toBe("fintech");
    expect(rows(db, "SELECT count(*) AS n FROM domain_map WHERE tag = 'Fintech'")[0]?.n).toBe(1);
    expect(rows(db, "SELECT count(*) AS n FROM domain_map WHERE tag = ' padded '")[0]?.n).toBe(1);
    expect(rows(db, "SELECT count(*) AS n FROM domain_map WHERE tag = 'padded'")[0]?.n).toBe(0);
  });

  test("an unknown cluster id is an FK violation, and nothing is written", () => {
    const db = migrated();
    expect(() => upsertDomainTag(db, "ghost", "not-a-cluster")).toThrow();
    expect(rows(db, "SELECT count(*) AS n FROM domain_map WHERE tag = 'ghost'")[0]?.n).toBe(0);
  });
});

describe("the normalisation write is not a vault mutation (ARCH §4; Max's #78 carry)", () => {
  test("no `vault_meta` bump, no `spark_run` row, exactly one `domain_map` row", () => {
    const db = migrated();
    const revision = () =>
      rows(db, "SELECT revision FROM vault_meta WHERE id = 1")[0]?.revision as number;
    const before = revision();

    upsertDomainTag(db, "neobank-xyz", "fintech");

    expect(revision()).toBe(before);
    expect(rows(db, "SELECT count(*) AS n FROM spark_run")[0]?.n).toBe(0);
    expect(rows(db, "SELECT count(*) AS n FROM domain_map WHERE tag = 'neobank-xyz'")[0]?.n).toBe(
      1,
    );
  });
});

/**
 * `newDomainFlag` — EV1 `#43`'s instrument (`PRD.md` §5 / NFR-Q1; `idea.new_domain`, `0006`): does a
 * write's domain set reach a domain **no other idea row carries**? The identity is the vault's own
 * (`COALESCE(domain_map.cluster_id, <the tag>)`), so this is the same `resolved_domains` vocabulary the
 * summary reads — which is why the two same-cluster cases below (`fintech` / `payments`) are `0`.
 *
 * Read-only: the flag is a question about the vault, and asking it must not change one.
 */
describe("newDomainFlag — coverage at the write (EV1 #43)", () => {
  const flag = (db: DatabaseSync, tags: string[]): 0 | 1 => newDomainFlag(db, tags);

  test("an empty vault makes any tag new — the capture case", () => {
    expect(flag(migrated(), ["health"])).toBe(1);
  });

  test("a tag another row already carries is not new — and neither is its cluster", () => {
    const db = migrated();
    insertIdea(db, "a", { tags: ["fintech"] });
    expect(flag(db, ["fintech"])).toBe(0); // the same tag
    // `payments` maps to the SAME cluster (`seed/domain-taxonomy.yaml`: one cluster, many tags), and
    // `docs/API.md:119` — "`#fintech` + `#banking` are **one** domain". A tag-identity test would call
    // this `1`; the vault's own vocabulary calls it `0`.
    expect(flag(db, ["payments"])).toBe(0);
    // The rule is existential: ANY domain in the set the vault does not already carry makes the write
    // a widening, so a set mixing a covered tag with a fresh one is `1`.
    expect(flag(db, ["payments", "health"])).toBe(1);
  });

  test("a provisional tag is its own cluster until the worker maps it", () => {
    const db = migrated();
    insertIdea(db, "a", { tags: ["quantum-widgets"] });
    expect(flag(db, ["quantum-widgets"])).toBe(0); // another row literally carries it
    expect(flag(db, ["quantum-widgets-v2"])).toBe(1); // a different unmapped tag is a different domain
    // Once the vocabulary resolves the fresh tag onto a cluster some row already covers, the same tag
    // stops being a widening — the collapse the summary's monotone rule describes, seen from here.
    upsertDomainTag(db, "quantum-widgets-v2", "fintech");
    upsertDomainTag(db, "fintech", "fintech");
    expect(flag(db, ["quantum-widgets-v2"])).toBe(1); // still new: no other row carries `fintech`
    insertIdea(db, "b", { tags: ["payments"] });
    expect(flag(db, ["quantum-widgets-v2"])).toBe(0); // now the cluster is carried — by `b`
  });

  test("the comparison is the vault before the write — a re-save is not a widening", () => {
    const db = migrated();
    insertIdea(db, "a", { tags: ["health"] });
    expect(flag(db, ["health"])).toBe(0); // the vault already carries it — whoever carried it
    // The case that separates this from a "no OTHER row" reading (measured, not asserted): `a` is the
    // sole carrier of `health`. A plain text-only re-save of `a` does not widen the vault, so the row's
    // own current tags must count as coverage — computed *before* the update, they are the whole answer.
    // Under "ignore the row's own tags", the same re-save would read `1` — a false positive on the
    // commonest iterate there is.
    expect(flag(db, ["health", "fintech"])).toBe(1); // …while a genuinely fresh domain is still a win
  });

  test("an empty tag set is not a widening, and the read writes nothing", () => {
    const db = migrated();
    insertIdea(db, "a", { tags: ["fintech"] });
    const revision = rows(db, "SELECT revision FROM vault_meta WHERE id = 1")[0]?.revision;
    expect(flag(db, [])).toBe(0);
    expect(rows(db, "SELECT revision FROM vault_meta WHERE id = 1")[0]?.revision).toBe(revision);
    expect(rows(db, "SELECT count(*) AS n FROM spark_run")[0]?.n).toBe(0);
  });
});
