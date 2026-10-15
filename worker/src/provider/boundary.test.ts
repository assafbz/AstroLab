import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { MIGRATIONS } from "@astrolab/store";
import { describe, expect, test } from "vitest";

/**
 * The boundary and the privacy pin, as *checked* invariants (W2's pin 1 + pin 4; `ARCHITECTURE.md` §5,
 * §9, §11 PRIV1).
 *
 * Two claims that a single happy-path test cannot make true:
 *
 * 1. **The vault cannot reach a provider.** NFR-A1 is "the vault works without the Spark" — and it holds
 *    because `api/` and `store/` have no reachable path to this module, not because nobody has got round
 *    to importing it. If one appears, the mechanism is falsified and the suite must say so.
 * 2. **Every call pins `provider.zdr`.** One call site, guarded — an assertion inside `buildRequest`
 *    would only restate the field it just set (David's pin 4).
 * 3. **The boundary reaches nothing but its own siblings.** No DB handle, no vault, no second transport:
 *    every specifier under `provider/` resolves inside the directory (a `./sibling.js`, or a `node:`
 *    builtin that reaches no state). Claim 1 says the vault cannot reach *here*; this says this cannot
 *    reach *there*. Without it the first is only half a guarantee — `worker` already depends on
 *    `@astrolab/store`, so one line would hand the adapter the vault and no check would notice.
 *
 * All three are mutation-checked in the PR: plant a violation, watch it fail, restore.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PROVIDER_DIR = "worker/src/provider";
const PROVIDER_MODULE = `${PROVIDER_DIR}/openrouter.ts`;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "artifacts", ".agents", "data"]);

/**
 * Everything that is *not* the worker. A provider import anywhere under these is the bug this file
 * exists for. Read from the root manifest rather than hardcoded, so a new package is guarded the day it
 * exists — the hardcoded `["api","store"]` left `client/` unguarded (§1 forbids the client reaching the
 * provider too), and nothing would have said so.
 */
const WORKSPACES = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { workspaces: string[] }
).workspaces;
const VAULT_PACKAGES = WORKSPACES.filter((pkg) => pkg !== "worker");

/** Every extension a workspace's `src/` can hold — a `.jsx` or `.mjs` file is a production code path too. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(join(dir, entry.name), found);
    } else if (
      SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) &&
      !TEST_FILE.test(entry.name)
    ) {
      const path = join(dir, entry.name);
      // Only a package's `src/` — test fixtures are not production code paths. A React component is
      // one, and a client provider import is the same bug as a vault one.
      if (relative(ROOT, path).split(/[\\/]/).includes("src")) found.push(path);
    }
  }
  return found;
}

const FILES = sourceFiles(ROOT).map((path) => ({
  rel: relative(ROOT, path).split(/[\\/]/).join("/"),
  text: readFileSync(path, "utf8"),
}));

/** Every module specifier in a file, static or dynamic — including a side-effect import. */
function specifiers(text: string): string[] {
  return [...text.matchAll(/(?:from\s+|import\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm)].map(
    (match) => match[1] ?? "",
  );
}

/**
 * Which specifiers a file under `worker/src/provider/` may use: a `./sibling.js` (the boundary's own
 * modules), or a `node:` builtin that reaches no state. Refused: any bare package, any `../` escape —
 * and **`node:sqlite`**, a DB handle. The adapter must not take one (W3's carry, #28 review): a handle
 * would let it write, which demotes *"invalid output ⇒ nothing stored"* from a construction to a
 * promise. `node:crypto` stays allowed, so a stateless hash never has to fight the guard.
 */
function boundarySpecifierAllowed(specifier: string): boolean {
  if (specifier === "node:sqlite") return false;
  return /^\.\/[A-Za-z0-9_.-]+\.js$/.test(specifier) || specifier.startsWith("node:");
}

describe("the vault cannot reach the AI boundary (NFR-A1, ARCH §9)", () => {
  test("the scan is real — it sees the tree it is guarding", () => {
    // Without this, a broken walk turns every assertion below into a silent pass.
    expect(FILES.length).toBeGreaterThan(10);
    expect(FILES.map((file) => file.rel)).toContain("worker/src/queue.ts");
    // Both widenings are themselves non-vacuous. Per package, because a typo'd package name narrows the
    // scan silently — the same failure mode as the `from`-only specifier extractor. And the walk must
    // reach a `.tsx` file, or "the extension union" is a claim about nothing.
    for (const pkg of VAULT_PACKAGES) {
      expect(
        FILES.some((file) => file.rel.startsWith(`${pkg}/`)),
        `the scan reached no files under ${pkg}/`,
      ).toBe(true);
    }
    expect(FILES.map((file) => file.rel)).toContain("client/src/App.tsx");
  });

  test("the specifier extractor sees every import form — a side-effect import has no `from`", () => {
    // This is the form that got past the first version of this guard: `import "@astrolab/worker";` has no
    // `from` clause, so a `from`-only regex walks straight past it. Pinned as a unit test so the hole
    // cannot reopen silently.
    const text = [
      'import "@astrolab/worker";',
      'import { a } from "./a.js";',
      'import type { B } from "@astrolab/worker";',
      'export * from "../worker/src/provider/index.js";',
      'const c = await import("./c.js");',
    ].join("\n");

    expect(specifiers(text)).toEqual([
      "@astrolab/worker",
      "./a.js",
      "@astrolab/worker",
      "../worker/src/provider/index.js",
      "./c.js",
    ]);
  });

  test("no non-worker source imports the provider module", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const pkg = file.rel.split("/")[0];
      if (pkg === undefined || !VAULT_PACKAGES.includes(pkg)) continue;
      for (const specifier of specifiers(file.text)) {
        if (specifier === "@astrolab/worker" || /(^|\/)provider(\/index)?\.js$/.test(specifier)) {
          offenders.push(`${file.rel} → ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("neither vault package takes a dependency on the worker", () => {
    for (const pkg of VAULT_PACKAGES) {
      const manifest = JSON.parse(readFileSync(join(ROOT, pkg, "package.json"), "utf8")) as Record<
        string,
        Record<string, string> | undefined
      >;
      for (const section of ["dependencies", "devDependencies"]) {
        expect(Object.keys(manifest[section] ?? {})).not.toContain("@astrolab/worker");
      }
    }
  });
});

describe("the boundary reaches nothing but its own siblings (NFR-A1, ARCH §5, §11 PRIV1)", () => {
  const PROVIDER_FILES = FILES.filter((file) => file.rel.startsWith(`${PROVIDER_DIR}/`));

  test("the boundary is scanned at all", () => {
    // Same non-vacuity rule as above: an empty list would make the assertion below pass by default.
    expect(PROVIDER_FILES.map((file) => file.rel)).toContain(PROVIDER_MODULE);
    expect(PROVIDER_FILES.length).toBeGreaterThan(3);
  });

  test("every specifier under worker/src/provider/ resolves inside the directory", () => {
    // `worker` depends on `@astrolab/store`, so `import { openStore } from "@astrolab/store"` in the
    // adapter typechecks and passed 54/54 before this test existed. The adapter's *only* route to the
    // vault would be an import, so closing the import closes the route: this is what makes "invalid
    // output ⇒ nothing stored" true by construction rather than by discipline.
    //
    // A `node:` builtin reaches no state, so one is allowed; a **DB handle** is the exception, named
    // and refused (`node:sqlite`) — see `boundarySpecifierAllowed`. A later stage that wants any other
    // specifier should arrive as a *named* exception with its reason: W3's `idea_mechanism` cache write
    // is exactly that, and it lives in `store/src/mechanism.ts` — above this line, and reachable from
    // the API's delete path (V5 #16) — rather than in the adapter.
    const offenders = PROVIDER_FILES.flatMap((file) =>
      specifiers(file.text)
        .filter((specifier) => !boundarySpecifierAllowed(specifier))
        .map((specifier) => `${file.rel} → ${specifier}`),
    );

    expect(offenders).toEqual([]);
  });

  test("the allowed-specifier rule accepts the boundary's own shape and refuses a DB handle", () => {
    // A positive control, per the guard-scope rule: the rule must accept one input and refuse one, or
    // a widened (or broken) rule reads exactly like a passing scan.
    for (const allowed of ["./schema.js", "node:crypto"]) {
      expect(boundarySpecifierAllowed(allowed), allowed).toBe(true);
    }
    for (const refused of ["node:sqlite", "@astrolab/store", "../queue.js", "./schema"]) {
      expect(boundarySpecifierAllowed(refused), refused).toBe(false);
    }
  });
});

describe("the mechanism descriptor never leaves the worker (ARCH §3.3 items 2–4; PRD §3.3)", () => {
  // The descriptor and its table are selection-internal: `docs/API.md` §0 and §3.3 forbid a
  // `mechanism`, a distance, an alignment, or a "related ideas" readout anywhere in a response — which
  // only holds if no surface can reach them. Scope is the *surfaces*, `api/` and `client/`, not
  // `store/`: the store owns the shipped DDL and legitimately names the table in `0001_init` — that is
  // the schema of record, not a surface.
  const SURFACES = VAULT_PACKAGES.filter((pkg) => pkg !== "store");
  const TABLE = /idea_mechanism/;
  const TYPE = /MechanismDescriptor/;
  const names = (pattern: RegExp): string[] =>
    FILES.filter((file) => pattern.test(file.text)).map((file) => file.rel);

  test("the scan reaches both surfaces, and each alternative bites somewhere", () => {
    for (const pkg of SURFACES) {
      expect(
        FILES.some((file) => file.rel.startsWith(`${pkg}/`)),
        `no files under ${pkg}/`,
      ).toBe(true);
    }
    // A typo'd pattern passes silently; show both halves matching something real.
    expect(names(TABLE)).toContain("store/src/migrations.ts");
    expect(names(TYPE)).toContain("worker/src/engine/mechanism.ts");
  });

  test("no api/ or client/ source names the descriptor or its table", () => {
    const offenders = FILES.filter(
      (file) =>
        SURFACES.some((pkg) => file.rel.startsWith(`${pkg}/`)) &&
        (TABLE.test(file.text) || TYPE.test(file.text)),
    ).map((file) => file.rel);

    expect(offenders).toEqual([]);
  });
});

describe("every call pins provider.zdr (ARCH §5, NFR-PRIV1) — pin 4", () => {
  test("exactly one source file writes the pin", () => {
    // The pin's *form*, not the bare word — so a comment mentioning ZDR does not fail the suite while a
    // second `provider: { zdr: … }` site does. (The brand makes a second site unusable anyway; this is
    // the belt to that braces.)
    const sites = FILES.filter((file) => /provider\s*:\s*\{[^}]*\bzdr\b/i.test(file.text)).map(
      (file) => file.rel,
    );

    expect(sites).toEqual([PROVIDER_MODULE]);
  });

  test("exactly one source file sends a request", () => {
    const callers = FILES.filter((file) => file.text.includes(".send(")).map((file) => file.rel);

    expect(callers).toEqual([PROVIDER_MODULE]);
  });
});

describe("Axis 1 stays in the worker (ARCH §3.2; NFR-A1) — W4", () => {
  // The distance module, the normaliser interface, and its method are the axis's names. None may
  // appear under `api/` or `client/`: the vault path resolves no cluster and reaches no model — a
  // domain tag is stored raw and read raw (`api/src/vault-summary.ts`'s exact match depends on it).
  // `\b` so the axis *type* is matched as a whole word: W5's `minDomainDistance` / `parseDomainDistance`
  // contain the substring `DomainDistance` without naming the type, and a substring match would flag them.
  const AXIS = /\bDomainDistance\b|TagNormalizer|normalizeTag/;
  const names = (): string[] =>
    FILES.filter((file) => AXIS.test(file.text)).map((file) => file.rel);

  test("the scan is real — each name bites somewhere in the worker", () => {
    // Non-vacuity: a typo'd pattern would pass the assertion below by matching nothing.
    expect(names()).toContain("worker/src/engine/domain.ts");
    expect(names()).toContain("worker/src/provider/types.ts");
  });

  test("no api/ or client/ source names the axis, its normaliser, or its method", () => {
    const offenders = FILES.filter(
      (file) =>
        VAULT_PACKAGES.some((pkg) => file.rel.startsWith(`${pkg}/`)) && AXIS.test(file.text),
    ).map((file) => file.rel);

    expect(offenders).toEqual([]);
  });
});

describe("Axis 2 stays in the worker; thresholds stay out of schema and API (#30 Done) — W5", () => {
  // Two #30 claims, stated structurally rather than in prose:
  //
  // 1. **The gate is selection-internal.** `descriptorSimilarity` / `gatedPairs` / `GatedPair` may not
  //    appear on a *surface* (`api/`, `client/`) — an alignment number in a response is exactly what
  //    `PRD.md` §3.3 item 4 forbids. `store/` is excluded because it owns `GateConfig` legitimately: the
  //    thresholds' type lives beside their SQL, not on a surface.
  // 2. **Changing a threshold touches no schema and no API.** The `config` table is created once (no
  //    migration adds a threshold), and no `api/` or `client/` source names a threshold key or its reader.
  const SURFACES = VAULT_PACKAGES.filter((pkg) => pkg !== "store");
  const AXIS = /descriptorSimilarity|gatedPairs|GatedPair/;
  const THRESHOLD = /readGateConfig|min_domain_distance|min_alignment/;
  const onSurface = (file: { rel: string }): boolean =>
    SURFACES.some((pkg) => file.rel.startsWith(`${pkg}/`));

  test("the scan is real — each name bites somewhere, and every surface is reached", () => {
    const hits = (pattern: RegExp): string[] =>
      FILES.filter((file) => pattern.test(file.text)).map((file) => file.rel);
    // A typo'd pattern would pass the assertions below by matching nothing.
    expect(hits(/descriptorSimilarity/)).toContain("worker/src/engine/alignment.ts");
    expect(hits(/gatedPairs/)).toContain("worker/src/engine/gate.ts");
    expect(hits(/GateConfig/)).toContain("store/src/config.ts");
    for (const pkg of SURFACES) {
      expect(
        FILES.some((file) => file.rel.startsWith(`${pkg}/`)),
        `no files under ${pkg}/`,
      ).toBe(true);
    }
  });

  test("no api/ or client/ source names the alignment axis", () => {
    const offenders = FILES.filter((file) => onSurface(file) && AXIS.test(file.text)).map(
      (file) => file.rel,
    );
    expect(offenders).toEqual([]);
  });

  test("the `config` table is created once — no migration adds a threshold", () => {
    const creators = MIGRATIONS.filter((migration) => /CREATE TABLE config\b/.test(migration.sql));
    expect(creators.map((migration) => migration.version)).toEqual([1]);
  });

  test("no api/ or client/ source names a threshold key or its reader", () => {
    const offenders = FILES.filter((file) => onSurface(file) && THRESHOLD.test(file.text)).map(
      (file) => file.rel,
    );
    expect(offenders).toEqual([]);
  });
});

describe("Stage 2's adjudication stays in the worker (PRD §3.3 item 4; API §0) — W6", () => {
  // Stage 2's names, plus the draft it carries. `SparkDraft.mechanism` is an internal column (§2.3) and
  // a `direction` / `claim` pair is exactly the "related ideas" readout `PRD.md` §3.3 item 4 forbids
  // *before* a spark is offered — so none of this may appear on a surface. `store/` is excluded for the
  // same reason as the blocks above: it owns `spark`'s DDL (`mechanism`, `domain_distance`,
  // `structural_alignment` are its columns of record), and the schema of record is not a surface.
  // `\b` around `Adjudication` and `Adjudicator` so each is matched as a **whole word**: the all-caps
  // `ADJUDICATION_SYSTEM` / `ADJUDICATION_SCHEMA` are not dragged in by a substring, and the provider's
  // own `SparkAdjudicator` keeps its own alternative. All five of `adjudicate.ts`'s exports are named
  // here — the first version carried four, and a bare `Adjudicator` under `api/` left the suite green
  // (W6 review, Max).
  const SURFACES = VAULT_PACKAGES.filter((pkg) => pkg !== "store");
  const ADJUDICATION =
    /SparkDraft|SparkAdjudicator|createAdjudicator|ConfirmedSpark|RejectedPair|\bAdjudication\b|\bAdjudicator\b/;
  const onSurface = (file: { rel: string }): boolean =>
    SURFACES.some((pkg) => file.rel.startsWith(`${pkg}/`));

  test("the scan is real — every name bites in the worker, and every surface is reached", () => {
    const hits = (pattern: RegExp): string[] =>
      FILES.filter((file) => pattern.test(file.text)).map((file) => file.rel);
    // Each alternative, on its own: a typo'd pattern would pass the assertion below by matching nothing.
    for (const name of ["SparkDraft", "SparkAdjudicator"]) {
      expect(hits(new RegExp(name)), name).toContain("worker/src/provider/types.ts");
    }
    for (const name of ["createAdjudicator", "ConfirmedSpark", "RejectedPair", "Adjudication"]) {
      expect(hits(new RegExp(name)), name).toContain("worker/src/engine/adjudicate.ts");
    }
    // The bare interface, as its own alternative — a substring match would find it inside
    // `SparkAdjudicator` and say nothing about the pattern actually guarding the name.
    expect(hits(/\bAdjudicator\b/)).toContain("worker/src/engine/adjudicate.ts");
    for (const pkg of SURFACES) {
      expect(
        FILES.some((file) => file.rel.startsWith(`${pkg}/`)),
        `no files under ${pkg}/`,
      ).toBe(true);
    }
  });

  test("no api/ or client/ source names the adjudication surface or its draft", () => {
    const offenders = FILES.filter((file) => onSurface(file) && ADJUDICATION.test(file.text)).map(
      (file) => file.rel,
    );
    expect(offenders).toEqual([]);
  });
});

describe("Done 5 — no synthetic seeds, no note import (ARCH §7; PRD §3.4 item 3) — W7", () => {
  // The negative requirement: **neither the engine nor the API generates ideas on the user's behalf**,
  // and **nothing imports a user's notes**. Nothing in the product *does* the forbidden thing, so there
  // is no positive surface to test — the risk is that a check nobody wrote regresses silently the first
  // time someone reaches for the obvious shortcut. Three arms, each with a leg proving it is not
  // vacuous (a typo'd pattern or a narrowed walk passes forever — `mem/astrolab-guard-scope`).
  //
  // The API is the user-intent path: `api/src/capture.ts` mints a root from a form the user filled, and
  // `api/src/delete.ts` removes one. Both are *the user's* action, both are allowed, and their being
  // seen is the positive control that the matcher bites. The engine and the client mint nothing.

  test("A: no source outside api/ writes an idea table", () => {
    // `\b` after the table name so `idea_mechanism` (a cache row, written by the worker) is not pulled
    // in: `\b` fails between `idea` and `_`.
    const IDEA_WRITE = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:idea|idea_version)\b/i;
    const writers = FILES.filter((file) => IDEA_WRITE.test(file.text)).map((file) => file.rel);

    // Positive control: the user-intent path is the writer, and the walk reaches it.
    expect(writers).toContain("api/src/capture.ts");

    const offenders = FILES.filter(
      (file) => !file.rel.startsWith("api/") && IDEA_WRITE.test(file.text),
    ).map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  test("B: the only file-reading call in a workspace src/ is the shipped taxonomy", () => {
    // "Imports existing notes" (`PRD.md` §3.4 item 3) is a file *read*. A live product can read exactly
    // one file — `store/src/domain-seed.ts`'s shipped taxonomy (`ARCHITECTURE.md` §3.2). The build
    // scripts under `scripts/` are tooling, not a package's `src/`; `worker/src/boot.ts` creates a
    // directory (a write), not a read.
    // The **call**, not the name: importing `readFileSync` reads nothing, and a comment that mentions
    // it is not a read — so the paren is what makes this the claim it says it is.
    const READ = /(?:readFileSync|readFile|createReadStream|readdirSync)\s*\(/;
    const readers = FILES.filter((file) => READ.test(file.text)).map((file) => file.rel);

    // Exact, not "contains": a second reader is the bug, whatever it reads.
    expect(readers).toEqual(["store/src/domain-seed.ts"]);
    // Non-vacuity: the walk excludes test files, and every other reader in the repo is a test — so if
    // the walk ever started including one, this list would grow and the test would say so.
    expect(FILES.some((file) => file.rel.endsWith(".test.ts"))).toBe(false);
  });

  test("C: no exported provider operation returns an idea-shaped payload", () => {
    // The engine's only route to *mint* an idea would be a provider op whose output is one. The
    // provider's *inputs* carry idea text on purpose (`IdeaText` is the operation payload, §5); the
    // claim is about what an operation *returns*. `MechanismDescriptor` (extract) and `SparkDraft`
    // (adjudicate) are the two returns; neither may carry an idea's identity fields.
    const providerTypes = FILES.find((file) => file.rel === "worker/src/provider/types.ts");
    expect(providerTypes).toBeDefined();
    const body = (name: string): string => {
      const match = providerTypes?.text.match(
        new RegExp(`export interface ${name} \\{[\\s\\S]*?\\n\\}`),
      );
      return match?.[0] ?? "";
    };
    const IDEA_FIELDS = /\b(?:hypothesis|problem|monetization|status|lineage_kind|domain_tags)\b/;

    for (const returned of ["MechanismDescriptor", "SparkDraft"]) {
      const text = body(returned);
      expect(text, `${returned} not found in provider/types.ts`).not.toBe("");
      expect(IDEA_FIELDS.test(text), returned).toBe(false);
    }
    // Positive control: the matcher and the field set are real — the input type does carry them, so a
    // renamed field or a broken body-slicer cannot make the assertions above pass by matching nothing.
    expect(IDEA_FIELDS.test(body("IdeaText"))).toBe(true);
  });
});

describe("one call site per operation (ARCH §11 PRIV1, data-flow audit) — EV6", () => {
  // The data-flow audit's structural half: **how many places can hand user text to a model?** §5's
  // payload rule — "only the operation's payload is sent" — is checkable *at a call site*, and it is
  // unenumerable the moment a second one appears. So the claim is one call site per operation.
  //
  // A **provider call site** is a `.op(` whose receiver is *declared with that operation's interface
  // type* in the same file. The anchor is the declaration, not the method name: `run.ts` calls
  // `adjudicator.adjudicate(eligible)`, but `adjudicator` is typed `Adjudicator` — the engine's own
  // stage, whose single provider call lives in `engine/adjudicate.ts` — so a bare `\.adjudicate\(`
  // would count two and this one counts one. Without the anchor the guard would be about spelling.
  const IFACES: Record<string, string> = {
    extract: "MechanismExtractor",
    adjudicate: "SparkAdjudicator",
    normalizeTag: "TagNormalizer",
  };
  const opCalls = (text: string): Array<{ receiver: string; op: string }> =>
    [...text.matchAll(/([A-Za-z_$][\w$]*)\.(extract|adjudicate|normalizeTag)\s*\(/g)].map(
      (match) => ({ receiver: match[1] ?? "", op: match[2] ?? "" }),
    );
  const isProviderSite = (
    file: { text: string },
    call: { receiver: string; op: string },
  ): boolean => new RegExp(`\\b${call.receiver}\\s*:\\s*${IFACES[call.op]}\\b`).test(file.text);

  /** The three operations, and the one product module each is called from (`ARCHITECTURE.md` §3.3). */
  const OPERATIONS = [
    { op: "extract", module: "worker/src/engine/mechanism.ts" },
    { op: "adjudicate", module: "worker/src/engine/adjudicate.ts" },
    { op: "normalizeTag", module: "worker/src/engine/domain.ts" },
  ];
  // The W9 calibration driver is a **second** consumer of `extract`/`adjudicate`: it fires the same
  // prompts against the same adapter, on purpose. It is a *named* exception — never reachable from the
  // boot path, asserted below — rather than a directory quietly filtered out of the scan.
  const CALIBRATION = "worker/src/engine/calibration/";
  const productFiles = FILES.filter((file) => !file.rel.startsWith(CALIBRATION));
  const shaped = (file: { text: string }): boolean => opCalls(file.text).length > 0;

  test("the anchor is the receiver's declaration, not the method name", () => {
    // Both controls on the *real* ambiguity: `provider.adjudicate(` anchored by `provider:
    // SparkAdjudicator` is a provider site; `adjudicator.adjudicate(` under `adjudicator: Adjudicator`
    // (what `run.ts` actually does) is not. A rule that matched the name alone would call both one.
    const holder = {
      text: "function f(provider: SparkAdjudicator) { return provider.adjudicate(a, b); }",
    };
    const stage = {
      text: "function g(adjudicator: Adjudicator) { return adjudicator.adjudicate(ps); }",
    };
    expect(opCalls(holder.text).filter((call) => isProviderSite(holder, call))).toHaveLength(1);
    expect(opCalls(stage.text).filter((call) => isProviderSite(stage, call))).toHaveLength(0);
  });

  test("each operation has exactly one product call site, in its own module", () => {
    const sites = new Map<string, string[]>();
    for (const file of productFiles) {
      for (const call of opCalls(file.text)) {
        if (!isProviderSite(file, call)) continue;
        sites.set(call.op, [...(sites.get(call.op) ?? []), file.rel]);
      }
    }
    for (const { op, module } of OPERATIONS) {
      expect(sites.get(op) ?? [], op).toEqual([module]);
    }
  });

  test("no product file calls an operation the anchor did not account for", () => {
    // The exact set, not a filter: a *new* `.extract(` anywhere under `src/` is a privacy-relevant
    // event — §5's payload rule has to be re-checked at the new site — so the guard names the five
    // files that carry one today. Four are the engine's (`run.ts` calling the stage, above); the fifth
    // is the named calibration exception.
    expect(
      productFiles
        .filter(shaped)
        .map((file) => file.rel)
        .sort(),
    ).toEqual([
      "worker/src/engine/adjudicate.ts",
      "worker/src/engine/domain.ts",
      "worker/src/engine/mechanism.ts",
      "worker/src/engine/run.ts",
    ]);
    expect(
      FILES.filter((file) => file.rel.startsWith(CALIBRATION) && shaped(file)).map(
        (file) => file.rel,
      ),
    ).toEqual(["worker/src/engine/calibration/w9-run.ts"]);
  });

  test("the calibration exception is script-only — no src module outside it imports the harness", () => {
    // "Named exception" has to mean *unreachable from the boot path*, or it is a hole with a comment on
    // it. Two halves: nothing the walk reaches outside `calibration/` imports it, and the only importer
    // is a dev script. `scripts/` is outside the walk by design (not a package's `src/`), so it is read
    // here directly — otherwise the second half would be prose.
    // The *import*, not the text: `store/src/config.ts` names the harness's path in a doc comment
    // (`W9_WIDE_TAUS`), and a text match would read a citation as a dependency.
    const importsHarness = (text: string): boolean =>
      specifiers(text).some((specifier) => /(^|\/)calibration\//.test(specifier));
    expect(
      FILES.filter((file) => !file.rel.startsWith(CALIBRATION) && importsHarness(file.text)).map(
        (file) => file.rel,
      ),
    ).toEqual([]);

    // `scripts/w9-calibrate.ts` fires the calibration and `scripts/w9-c5-fixture.ts` mints the C5
    // regression fixture from its artifact — both dev scripts. Non-empty, so the exception is a fact
    // about the tree and not an empty set that would read the same if the harness were orphaned.
    const scriptImporters = readdirSync(join(ROOT, "scripts"))
      .filter((name) => SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)))
      .filter((name) => importsHarness(readFileSync(join(ROOT, "scripts", name), "utf8")));
    expect(scriptImporters.length, "no dev script imports the calibration harness").toBeGreaterThan(
      0,
    );
  });
});
