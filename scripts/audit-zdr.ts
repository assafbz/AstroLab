#!/usr/bin/env node
/**
 * EV6 (#48) — consume F1's PRIV1 build artifact.
 *
 * `scripts/capture-zdr.mjs` (F1 #8) fetches OpenRouter's Zero-Data-Retention endpoint list in the
 * **non-required** `zdr-evidence` CI job and uploads it as the artifact of record. Nothing read it: an
 * artifact nobody consumes is a file, not evidence. This is the consumer.
 *
 * It answers the one question the capture cannot answer about itself — **is the model our adapter will
 * actually call in that list?** §5's routing control is `provider: { zdr: true }` on every request,
 * which restricts routing to endpoints the provider classifies ZDR. If the pinned model is not
 * classified, the pin is not a privacy control: it is a call that can never be served.
 * `provider/boundary.test.ts` proves every call pins the flag; this proves the flag has somewhere to
 * route — the two halves of §11's "routing control" row, each with its own evidence.
 *
 * Usage:
 *   npx tsx scripts/audit-zdr.ts [--artifact <path>] [--model <id>] [--self-check]
 *
 * `--self-check` runs every check against synthetic artifacts and asserts each one bites — on this box,
 * no network — so the check cannot quietly become a scan that passes on anything.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_MODEL } from "../worker/src/provider/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The provider's own host and path. AstroLab's routes are bare `/v1` (`ARCHITECTURE.md` §6). */
const ZDR_HOST = "openrouter.ai";
const ZDR_PATH = "/api/v1/endpoints/zdr";

const DEFAULT_ARTIFACT = "artifacts/zdr-endpoints.json";

interface ZdrEntry {
  model_id?: unknown;
  provider_name?: unknown;
}

interface ZdrArtifact {
  source?: unknown;
  fetched_at?: unknown;
  http_status?: unknown;
  count?: unknown;
  data?: unknown;
}

/**
 * Every check the artifact of record has to pass. Returns the failures — empty means the evidence
 * stands. Pure, so `--self-check` can drive it with synthetic inputs.
 */
function audit(artifact: ZdrArtifact, model: string): string[] {
  const failures: string[] = [];
  const note = (message: string): void => {
    failures.push(message);
  };

  // 1. The artifact is the provider's own list — not our API's, and not a mirror. The capture allows a
  //    `ZDR_ENDPOINTS_URL` override for offline runs; the *evidence* may not come from one.
  if (typeof artifact.source !== "string") {
    note("source: missing");
  } else {
    let url: URL | null = null;
    try {
      url = new URL(artifact.source);
    } catch {
      note(`source: not a URL: ${artifact.source}`);
    }
    if (url !== null) {
      if (url.host !== ZDR_HOST) note(`source: host is ${url.host}, not ${ZDR_HOST}`);
      if (!url.pathname.endsWith(ZDR_PATH)) {
        note(`source: path is ${url.pathname}, not ${ZDR_PATH}`);
      }
    }
  }

  // 2. The capture hard-fails on a non-200, so a 200 here is the artifact's own precondition holding.
  if (artifact.http_status !== 200) note(`http_status: ${String(artifact.http_status)} (want 200)`);

  // 3. The envelope's own count is the list's length: a truncated write would otherwise still read as
  //    evidence, and an empty list means every routing pin would fail closed.
  const data = artifact.data;
  if (!Array.isArray(data)) {
    note("data: not an array");
    return failures;
  }
  if (artifact.count !== data.length) {
    note(`count: ${String(artifact.count)} ≠ data.length ${data.length}`);
  }
  if (data.length === 0) note("count: the list is empty — every routing pin would fail closed");

  // 4. Every entry names a model, or the list is not a list of routable endpoints.
  const entries = data as ZdrEntry[];
  const unnamed = entries.filter((entry) => {
    const id = entry?.model_id;
    return typeof id !== "string" || id.length === 0;
  });
  if (unnamed.length > 0) note(`data: ${unnamed.length} entry(s) carry no model_id`);

  // 5. The load-bearing check: the model the adapter will call is routable under the pin.
  const ids = new Set(entries.map((entry) => entry?.model_id));
  if (!ids.has(model)) {
    note(`model: ${model} is not ZDR-classified (${ids.size} models in the listed endpoints)`);
  }

  return failures;
}

/** `--flag value` from argv. Kept local: two flags do not earn an argument parser. */
function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function run(argv: readonly string[]): number {
  const artifactPath = flag(argv, "--artifact") ?? process.env.ZDR_ARTIFACT ?? DEFAULT_ARTIFACT;
  // `--model` overrides, then the env rule `createAdapterFromEnv` (`provider/openrouter.ts`) and
  // `compose.ts`'s `modelFromEnv` both apply — `env.AI_MODEL?.trim() || DEFAULT_MODEL` — read from the
  // boundary's own constant rather than restated. `||` and not `??`: an empty or whitespace `AI_MODEL`
  // then falls back to the default the way it does at the call site, instead of naming the empty model
  // and failing here for the wrong reason (EV6 review).
  const model = flag(argv, "--model") || process.env.AI_MODEL?.trim() || DEFAULT_MODEL;

  let raw: string;
  try {
    raw = readFileSync(resolve(ROOT, artifactPath), "utf8");
  } catch {
    console.error(
      `[audit-zdr] no artifact at ${artifactPath} — capture it first (\`node scripts/capture-zdr.mjs\`)`,
    );
    return 1;
  }

  let artifact: ZdrArtifact;
  try {
    artifact = JSON.parse(raw) as ZdrArtifact;
  } catch (cause) {
    console.error(`[audit-zdr] ${artifactPath} is not JSON: ${describe(cause)}`);
    return 1;
  }

  const failures = audit(artifact, model);
  const size = Array.isArray(artifact.data) ? artifact.data.length : 0;
  const headline = `[audit-zdr] ${artifactPath} — ${size} endpoints · model ${model}`;
  if (failures.length > 0) {
    console.error(`${headline}\n${failures.map((failure) => `  ✗ ${failure}`).join("\n")}`);
    return 1;
  }
  console.log(
    `${headline}\n  ✓ source is the provider's own ZDR list · HTTP 200 · count matches · ` +
      `every entry names a model · ${model} is classified ZDR`,
  );
  return 0;
}

function selfCheck(): number {
  const good: ZdrArtifact = {
    source: `https://${ZDR_HOST}${ZDR_PATH}`,
    fetched_at: "2026-01-01T00:00:00.000Z",
    http_status: 200,
    count: 2,
    data: [
      { model_id: "example/pinned-model", provider_name: "ExampleProvider" },
      { model_id: "example/other-model", provider_name: "ExampleProvider" },
    ],
  };
  const MODEL = "example/pinned-model";

  // Each case asserts the **exact set of checks that fail** — not just "it failed". A case whose
  // mutation also breaks a neighbouring check shows up as an extra name, and a rule that failed
  // everything would still have to pass the first case, which allows none.
  const cases: Array<[string, ZdrArtifact, string[]]> = [
    ["a well-formed artifact", good, []],
    [
      "our own API's route, not the provider's",
      { ...good, source: "http://localhost:3000/v1/endpoints/zdr" },
      ["source"],
    ],
    [
      "a mirror, not the provider",
      { ...good, source: "https://example.com/api/v1/endpoints/zdr" },
      ["source"],
    ],
    ["a non-200 capture", { ...good, http_status: 404 }, ["http_status"]],
    ["a truncated write (count disagrees)", { ...good, count: 999 }, ["count"]],
    ["an empty list", { ...good, count: 0, data: [] }, ["count", "model"]],
    [
      "an entry carrying no model",
      { ...good, count: 1, data: [{ provider_name: "x" }] },
      ["data", "model"],
    ],
    [
      "the pinned model absent",
      { ...good, count: 1, data: [{ model_id: "example/other" }] },
      ["model"],
    ],
  ];

  const check = (failure: string): string => failure.slice(0, failure.indexOf(":"));
  let failed = 0;
  for (const [label, artifact, expect] of cases) {
    // Distinct: one check can report two reasons (the localhost source fails on host *and* path).
    const got = [...new Set(audit(artifact, MODEL).map(check))].sort();
    const ok = got.join(",") === [...expect].sort().join(",");
    if (ok) {
      console.log(`✓ ${label}`);
    } else {
      failed += 1;
      console.error(
        `✗ ${label}: failing checks [${got.join(", ")}], wanted [${expect.join(", ")}]`,
      );
    }
  }
  console.log(failed === 0 ? "\nself-check: all cases pass" : `\nself-check: ${failed} FAILED`);
  return failed === 0 ? 0 : 1;
}

process.exitCode = process.argv.includes("--self-check") ? selfCheck() : run(process.argv.slice(2));
