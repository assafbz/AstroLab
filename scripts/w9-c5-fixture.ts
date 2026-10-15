/**
 * W9 **C5 fixture** generator — the committed regression snapshot (issue #34; bar
 * `docs/W9_CALIBRATION.md` §3 C5, §4 step 7).
 *
 * **Run it** (0 provider calls — nothing here constructs an adapter):
 *
 * ```sh
 * npm run build -w store          # required: `tsx` does not apply vitest's source alias
 * npx tsx scripts/w9-c5-fixture.ts <path-to-p2-actuals.json>
 * ```
 *
 * The input is the **artifact of record** — `p2-actuals.json` (sha256 `b5e37875…`), posted to issue #34's
 * thread as relay messages `ee452598…` ‖ `e1b2ca87…`. This script reads those bytes and writes
 * `worker/src/engine/calibration/w9-c5-fixture.json`; a reviewer holding the artifact can re-run it and
 * expect `git diff` on the fixture to be empty.
 *
 * ## What it copies, and what it derives
 *
 * | column | source |
 * | :-- | :-- |
 * | the 28 descriptors | the artifact's `descriptors[].descriptor`, verbatim (the gate's input) |
 * | pair `key`, `alignment`, the four per-field terms | the artifact's `perFieldJaccard`, verbatim |
 * | pair `domain_distance` | **derived** — the shipped gate's read of the committed taxonomy over the committed vault (0 calls, deterministic) |
 * | `confirmed` / `rejected` keys, the 21 `draft`s | the artifact, verbatim (the provider half, a **snapshot**) |
 *
 * The distance column is the one value the artifact does not serialise (`perFieldJaccard` carries no
 * `distance`; `confirmedSparks` carries it for the 21 confirmed only), so it is re-derived here from the
 * shipped `createGate` over the committed vault — deterministic and AI-free, and asserted against the
 * gate again by the fixture's own test.
 *
 * ## Fail-closed
 *
 * The extractor handed to the cache **throws**. Seeding `idea_mechanism` with the exact producer
 * (`EXTRACTOR_VERSION` + the artifact's pinned model) is what makes every `descriptorFor` a hit, so the
 * script cannot quietly add an extraction call to the snapshot: a hash mismatch aborts the run instead.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  currentVaultRevision,
  MIGRATIONS,
  migrate,
  openStore,
  seedDomainTaxonomy,
  upsertDescriptor,
  vaultMutation,
} from "@astrolab/store";

import { createDomainDistance } from "../worker/src/engine/domain.js";
import { createGate } from "../worker/src/engine/gate.js";
import {
  createMechanismCache,
  EXTRACTOR_VERSION,
  hashIdeaText,
} from "../worker/src/engine/mechanism.js";
import { parseVault, W9_VAULT_PATH, type W9Idea } from "../worker/src/engine/calibration/w9-run.js";
import type { IdeaText, MechanismDescriptor } from "../worker/src/provider/types.js";
import { cutVault } from "../worker/src/queue.js";

/** The model the artifact's descriptors were extracted under (`AI_MODEL` unset ⇒ this default at P1). */
const MODEL = "deepseek/deepseek-v4-flash";
/** τ\* — the owner-seeded floor (`ARCHITECTURE.md` §3.4), the union the artifact records. */
const FLOOR = 0.02;

const OUT = fileURLToPath(
  new URL("../worker/src/engine/calibration/w9-c5-fixture.json", import.meta.url),
);

interface Artifact {
  floor: number;
  union: number;
  confirmed: string[];
  rejected: string[];
  descriptors: { ideaId: string; sourceHash: string; descriptor: MechanismDescriptor }[];
  perFieldJaccard: {
    key: string;
    alignment: number;
    verb: number;
    object_class: number;
    constraint: number;
    transferable_structure: number;
  }[];
  confirmedSparks: { key: string; distance: number; alignment: number; draft: unknown }[];
}

function fail(message: string): never {
  throw new Error(`w9-c5-fixture: ${message}`);
}

/** Seed the committed vault into `idea` (the same write the other W9 fixtures make). */
function seedVault(db: ReturnType<typeof openStore>, ideas: readonly W9Idea[]): void {
  vaultMutation(db, () => {
    const insert = db.prepare(
      `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                         lineage_parent_id, status, visibility, current_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, 'w9', 'w9')`,
    );
    for (const idea of ideas) {
      insert.run(
        idea.id,
        idea.hypothesis,
        idea.problem,
        idea.monetization,
        JSON.stringify([idea.cluster]),
      );
    }
  });
}

const textOf = (idea: W9Idea): IdeaText => ({
  hypothesis: idea.hypothesis,
  problem: idea.problem,
  monetization: idea.monetization,
});

async function main(): Promise<void> {
  const [artifactPath] = process.argv.slice(2);
  if (artifactPath === undefined) fail("usage: npx tsx scripts/w9-c5-fixture.ts <p2-actuals.json>");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as Artifact;
  if (artifact.floor !== FLOOR) fail(`artifact floor is ${artifact.floor}, expected ${FLOOR}`);

  const db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  seedDomainTaxonomy(db);

  const ideas = parseVault(readFileSync(W9_VAULT_PATH, "utf8"), W9_VAULT_PATH);
  seedVault(db, ideas);

  // Seed the cache from the artifact's own descriptors, keyed by the *recomputed* source hash. A
  // mismatch means the artifact was produced against different vault text, prompt or model — stop.
  const byId = new Map(ideas.map((idea) => [idea.id, idea]));
  for (const row of artifact.descriptors) {
    const idea = byId.get(row.ideaId);
    if (idea === undefined) fail(`descriptor for unknown idea ${row.ideaId}`);
    const sourceHash = hashIdeaText(textOf(idea), { version: EXTRACTOR_VERSION, model: MODEL });
    if (sourceHash !== row.sourceHash) {
      fail(`source_hash mismatch for ${row.ideaId} — vault text, EXTRACTOR_VERSION or model moved`);
    }
    upsertDescriptor(db, {
      ideaId: row.ideaId,
      descriptor: JSON.stringify(row.descriptor),
      sourceHash,
    });
  }

  const mechanisms = createMechanismCache(
    db,
    {
      async extract(): Promise<never> {
        return fail(
          "the extractor fired — the descriptor cache is not warm (refusing to snapshot)",
        );
      },
    },
    { version: EXTRACTOR_VERSION, model: MODEL },
  );
  const distance = createDomainDistance(db, {
    normalizeTag: (tag: string) => Promise.reject(new Error(`unmapped tag ${tag}`)),
  });

  // The deterministic half, at the explicit τ\* the artifact records: `minAlignment` 0 would return the
  // whole 378-pair matrix, so the floor is applied here exactly as the record's `union` did.
  const gate = createGate(db, mechanisms, distance, { minDomainDistance: 1, minAlignment: FLOOR });
  const gated = await gate.gatedPairs(cutVault(db, currentVaultRevision(db)));

  const perField = new Map(artifact.perFieldJaccard.map((row) => [row.key, row]));
  const pairs = gated.map((pair) => {
    const terms = perField.get(pair.key);
    if (terms === undefined) fail(`gated pair ${pair.key} is absent from the artifact`);
    if (terms.alignment !== pair.alignment) {
      fail(`alignment drift for ${pair.key}: gate ${pair.alignment}, artifact ${terms.alignment}`);
    }
    return {
      key: pair.key,
      distance: pair.distance,
      alignment: pair.alignment,
      gated: true,
      verb: terms.verb,
      object_class: terms.object_class,
      constraint: terms.constraint,
      transferable_structure: terms.transferable_structure,
    };
  });
  if (pairs.length !== artifact.union) {
    fail(`gate returned ${pairs.length} pairs, artifact records ${artifact.union}`);
  }
  // Every artifact row must be gated: the snapshot cannot silently drop a pair.
  for (const row of artifact.perFieldJaccard) {
    if (!pairs.some((pair) => pair.key === row.key)) fail(`artifact pair ${row.key} is not gated`);
  }

  const fixture = {
    provenance: {
      issue: "#34",
      artifact: {
        name: "p2-actuals.json",
        bytes: 71691,
        sha256: "b5e378758aa5d0106a426089db2cfe8f5c9e0c35ba7b78f0e00b27c4390e03c3",
        relay: [
          {
            event: "ee4525983e1598edc858fb5039acfd3de9190cd7a771f59f389af5c37a7d0b7b",
            bytes: 65531,
          },
          {
            event: "e1b2ca87ecc06caee95c5106fdc4de6760b7a9e9f87644171c823ee859877793",
            bytes: 6160,
          },
        ],
      },
      producer: { extractorVersion: EXTRACTOR_VERSION, model: MODEL },
      floor: FLOOR,
    },
    descriptors: artifact.descriptors.map((row) => ({
      ideaId: row.ideaId,
      descriptor: row.descriptor,
    })),
    pairs,
    confirmed: artifact.confirmed,
    rejected: artifact.rejected,
    snapshot: artifact.confirmedSparks.map((spark) => ({ key: spark.key, draft: spark.draft })),
  };

  writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
  process.stdout.write(
    `wrote ${OUT}\n  ${pairs.length} pairs · ${fixture.descriptors.length} descriptors · ` +
      `${fixture.confirmed.length} confirmed / ${fixture.rejected.length} rejected · ` +
      `${fixture.snapshot.length} snapshotted drafts\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
