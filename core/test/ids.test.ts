import { afterEach, expect, test, vi } from "vitest";

import { globalIdSource, newId, setIdSource } from "../src/store/ids.js";
import { openNodeStore } from "../src/store/connection.node.js";
import { MIGRATIONS, migrate, seedDomainTaxonomy } from "../src/store/index.js";
import { captureIdea } from "../src/vault/capture.js";
import { enqueueRun } from "../src/store/runs.js";
import { createDecisionResolver } from "../src/domain/decision.js";

/**
 * #184 — the **id source port**. `core/` used to mint every id with `node:crypto`'s `randomUUID` (and,
 * in `domain/decision.ts`, the bare global), which is empty under Metro: every vault write threw on
 * device and web while CI stayed green on Node.
 *
 * The two halves that matter are both here: the default works where the standard global exists, and
 * its **absence is a named failure** — the shape that stops a Node-only green from masking the device
 * gap. A port with a lazy default is only portable if the failure is legible.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  setIdSource(globalIdSource);
});

/** A migrated, seeded, in-memory vault — the shape every write test needs. */
function newDb(): ReturnType<typeof openNodeStore> {
  const db = openNodeStore(":memory:");
  migrate(db, MIGRATIONS);
  seedDomainTaxonomy(db);
  return db;
}

test("the default mints a v4 uuid from the standard global, read at call time", () => {
  const first = newId();
  expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(newId()).not.toBe(first);
});

test("with no global the failure is named — not a TypeError from a missing property", () => {
  // Hermes (React Native) has no Web Crypto: this is the device's state, reproduced exactly.
  vi.stubGlobal("crypto", undefined);
  expect(() => newId()).toThrow(/no id source installed: globalThis\.crypto\.randomUUID/);

  // …and the near miss stays honest: a global that exists but is not Web Crypto is the same refusal,
  // so a platform that ships *some* `crypto` object cannot quietly half-work.
  vi.stubGlobal("crypto", {});
  expect(() => newId()).toThrow(/no id source installed/);
});

test("an installed source is what the vault writes through — capture, fork and the run it stamps", () => {
  let n = 0;
  setIdSource({ newId: () => `test-${++n}` });
  const db = newDb();

  const idea = captureIdea(db, {
    hypothesis: "h",
    problem: "p",
    monetization: "m",
    domain_tags: ["fintech"],
    origin_spark_id: null,
    decision_id: null,
  });

  expect(idea.id).toBe("test-1");
  // The capture stamps a revision and enqueues its run in the same call (#2): a second id, same source.
  const run = db.prepare("SELECT id FROM spark_run").get() as { id: string };
  expect(run.id).toBe("test-2");
  expect(enqueueRun(db, 99).id).toBe("test-3");
});

test("the deck's decision key comes from the port too — it was the bare global, not `node:crypto`", () => {
  // The fifth site: `createDecisionResolver`'s default used `crypto.randomUUID` directly, so no
  // `node:` walk could see it (`domain/decision.ts`). Without `deps.newId`, the port must answer.
  setIdSource({ newId: () => "decision-key-1" });
  const posted: string[] = [];
  const resolver = createDecisionResolver({
    // `null` is "posted nothing" (INSPIRED): this test is about the *key* the request carried, not
    // what the seam reported back.
    post: (_sparkId, decisionId) => {
      posted.push(decisionId);
      return Promise.resolve(null);
    },
    onResolved: () => {},
    onFailed: () => {},
  });

  resolver.resolve("spark-1", "ACCEPT");
  expect(posted).toEqual(["decision-key-1"]);
});

test("the composition root can install a device source and restore the standard one", () => {
  setIdSource({ newId: () => "device-1" });
  expect(newId()).toBe("device-1");
  setIdSource(globalIdSource);
  expect(newId()).toMatch(/^[0-9a-f-]{36}$/);
});
