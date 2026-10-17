import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { MIGRATIONS } from "../store/index.js";
import { describe, expect, test } from "vitest";

/**
 * The provider boundary and the privacy pin, as *checked* invariants (W2's pin 1 + pin 4;
 * `ARCHITECTURE.md` §5, §9, §11 PRIV1; L3 · #166).
 *
 * v1 walked every *non-worker* package and failed if one imported the provider. The rebuild moves the
 * boundary inside `core/`, so the edge is re-drawn rather than dropped:
 *
 * 1. **The vault cannot reach the provider** — re-homed at the other end of the same edge by L1
 *    (`core/test/boundary-a1.test.ts`, which walks `core/src/vault/**`). Not duplicated here; this
 *    file's first claim is the *door* instead: nothing but the boundary's own two directories may
 *    reach it, and `core/src/index.ts` — the package entry the app resolves — stays closed, so the
 *    app's engine-free entry is a fact and not a promise.
 * 2. **Every call pins `provider.zdr`.** One call site, guarded — an assertion inside `buildRequest`
 *    would only restate the field it just set.
 * 3. **The boundary reaches nothing but its own siblings.** No DB handle, no vault, no second
 *    transport: every specifier under `provider/` resolves inside the directory.
 * 4. **The selection-internal vocabulary never leaves the selector** — the descriptor, its table, the
 *    alignment axis, the thresholds and the adjudication draft are internal (§3.3 items 2–4;
 *    `PRD.md` §3.3), which holds only while no surface can name them.
 * 5. **One call site per operation** — how many places can hand user text to a model (§11 PRIV1).
 * 6. **No synthetic seeds, no note import** (§7; `PRD.md` §3.4 item 3).
 *
 * Every claim is mutation-checked in the PR: plant the violation, watch it fail, restore.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The boundary: the AI provider, and the engine that is its only caller. */
const SELECTOR_DIRS = ["core/src/provider", "core/src/engine"];
/**
 * The **app's** two reach directories, plus its composition root — door A of the 2026-10-17 ruling:
 * the app bundle reaches the engine and the provider at `@astrolab/core/dist/…`, so these files may
 * name them, and every other `app/src/**` file (the screens and the components) may not. Named here
 * so the landing of L2 does not turn a correct import into a red walk (found by Eli, 2026-10-17).
 */
const APP_REACH = ["app/src/engine", "app/src/provider", "app/src/bootstrap.ts"];
/** Every directory whose files may name the boundary, in one list: the selectors and the app door. */
const MAY_REACH = [...SELECTOR_DIRS, ...APP_REACH];
/** The one non-selector that legitimately names the internal vocabulary: the schema and cache owner. */
const SCHEMA_OWNER = "core/src/store";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "artifacts", ".agents", "data"]);

/**
 * The workspaces, read from the root manifest rather than hardcoded — the v1 guard's hardcoded
 * `["api","store"]` left `client/` unguarded, and nothing said so (§1 forbids the client reaching the
 * provider too). A new workspace is guarded the day it exists.
 */
const WORKSPACES = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { workspaces: string[] }
).workspaces;
/** `app/` does not exist until L2 (#165); the walk and the app leg follow whatever is on disk. */
const EXISTING = WORKSPACES.filter((name) => existsSync(join(ROOT, name)));

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
      // one, and an app provider import is the same bug as a vault one.
      if (relative(ROOT, path).split(/[\\/]/).includes("src")) found.push(path);
    }
  }
  return found;
}

const FILES = EXISTING.flatMap((workspace) => sourceFiles(join(ROOT, workspace))).map((path) => ({
  rel: relative(ROOT, path).split(/[\\/]/).join("/"),
  text: readFileSync(path, "utf8"),
}));

const relOf = (file: { rel: string }): string => file.rel;
const inDir = (file: { rel: string }, dir: string): boolean =>
  file.rel === dir || file.rel.startsWith(`${dir}/`);

/** Every module specifier in a file, static or dynamic — including a side-effect import. */
function specifiers(text: string): string[] {
  return [...text.matchAll(/(?:from\s+|import\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm)].map(
    (match) => match[1] ?? "",
  );
}

/**
 * Whether a specifier resolves into the provider boundary — the module or its directory, by whole
 * path segment (`../provider/index.js`, `@astrolab/core/dist/provider/index.js`) — or into `core/`'s
 * **source** through a bare package name, which the door ruling forbids (`@astrolab/core/src/…` is the
 * second consumption mode; the app reaches the engine at `dist/` — David's ruling, 2026-10-17).
 */
function reachesProvider(specifier: string): boolean {
  if (/^@astrolab\/core\/src\//.test(specifier)) return true;
  return specifier
    .split("/")
    .map((segment) => segment.replace(/\.(?:[cm]?[jt]sx?)$/, ""))
    .some((segment) => segment === "provider");
}

/** The engine, by the same rule — the boundary's only caller, and what a vault screen must not reach. */
function reachesEngine(specifier: string): boolean {
  if (/^@astrolab\/core\/src\//.test(specifier)) return true;
  return specifier
    .split("/")
    .map((segment) => segment.replace(/\.(?:[cm]?[jt]sx?)$/, ""))
    .some((segment) => segment === "engine");
}

describe("the walk is real — it sees the tree it is guarding (non-vacuity)", () => {
  test("every workspace on disk was reached, and the guard's own directories are in the set", () => {
    // Without this, a broken walk turns every assertion below into a silent pass.
    expect(FILES.length).toBeGreaterThan(30);
    for (const workspace of EXISTING) {
      expect(
        FILES.some((file) => file.rel.startsWith(`${workspace}/`)),
        `the scan reached no files under ${workspace}/`,
      ).toBe(true);
    }
    // Per directory, because a typo'd path narrows the scan silently — the same failure mode as the
    // `from`-only specifier extractor.
    for (const dir of [...SELECTOR_DIRS, SCHEMA_OWNER, "core/src/vault", "core/src/export"]) {
      expect(
        FILES.some((file) => inDir(file, dir)),
        `the scan reached no shipped files under ${dir}`,
      ).toBe(true);
    }
    expect(FILES.map(relOf)).toContain("core/src/provider/openrouter.ts");
  });

  test("the specifier extractor sees every import form — a side-effect import has no `from`", () => {
    // This is the form that got past the first version of this guard: `import "@astrolab/core";` has no
    // `from` clause, so a `from`-only regex walks straight past it. Pinned as a unit test so the hole
    // cannot reopen silently.
    const text = [
      'import "@astrolab/core";',
      'import { a } from "./a.js";',
      'import type { B } from "@astrolab/core/dist/provider/index.js";',
      'export * from "./schema.js";',
      'const c = await import("./c.js");',
    ].join("\n");

    expect(specifiers(text)).toEqual([
      "@astrolab/core",
      "./a.js",
      "@astrolab/core/dist/provider/index.js",
      "./schema.js",
      "./c.js",
    ]);
  });
});

describe("the AI boundary is reachable only from inside the selector (ARCH §5, §13.4)", () => {
  test("nothing outside the provider, the engine or the app's reach reaches the provider", () => {
    const mayReach = (file: { rel: string }): boolean => MAY_REACH.some((dir) => inDir(file, dir));
    const offenders = FILES.filter((file) => !mayReach(file)).flatMap((file) =>
      specifiers(file.text)
        .filter(reachesProvider)
        .map((specifier) => `${file.rel} → ${specifier}`),
    );

    expect(offenders).toEqual([]);
  });

  test("the package entry stays closed — the app's door is a `dist/` subpath, not the entry", () => {
    // The property the `#148` app-side guard leans on: a screen imports `@astrolab/core` for the vault
    // and the domain, and that specifier must not also hand it the engine (David's door ruling, A).
    const entry = FILES.find((file) => file.rel === "core/src/index.ts");
    expect(entry).toBeDefined();
    const reached = specifiers(entry?.text ?? "").filter(
      (specifier) => reachesProvider(specifier) || reachesEngine(specifier),
    );
    expect(reached).toEqual([]);
    // Non-vacuity: the entry does re-export something, so "no reach" is a verdict about a live file.
    expect(specifiers(entry?.text ?? "")).toContain("./store/index.js");
  });

  test("no shipped source takes the second consumption mode (`@astrolab/core/src/…`)", () => {
    // `scripts/` reads `core/`'s source by *relative* path under tsx (the shape the W9 harness always
    // used) — that is not a package specifier and is outside this walk. Inside a package's `src/`, the
    // door is `dist/`; a `src/` specifier would put core's modules in a bundle twice.
    const offenders = FILES.flatMap((file) =>
      specifiers(file.text)
        .filter((specifier) => specifier.startsWith("@astrolab/core/src/"))
        .map((specifier) => `${file.rel} → ${specifier}`),
    );

    expect(offenders).toEqual([]);
  });

  test("the app's own reach directories are allowed by name, and only those", () => {
    // The allow-list is the one place a new reach directory is added, so its rule is pinned: the
    // engine/provider adapters, the composition root — and neither a screen nor a component.
    expect(MAY_REACH.map((dir) => inDir({ rel: `${dir}/x.ts` }, dir))).toEqual(
      MAY_REACH.map(() => true),
    );
    expect(inDir({ rel: "app/src/engine/runScheduler.ts" }, "app/src/engine")).toBe(true);
    expect(inDir({ rel: "app/src/screens/Sparks.tsx" }, "app/src/engine")).toBe(false);
    expect(inDir({ rel: "app/src/bootstrap.ts" }, "app/src/bootstrap.ts")).toBe(true);
  });

  test("when `app/` exists, no screen or component reaches the engine", () => {
    // L2's `#148` guard is the app-side walk; this is the same edge from the core side, so a regression
    // shows up whichever lane introduced it. Until L2 lands, the leg states the fact it would assert.
    const app = join(ROOT, "app");
    if (!existsSync(app)) {
      expect(EXISTING).not.toContain("app");
      return;
    }
    expect(EXISTING).toContain("app");
    const offenders = FILES.filter(
      (file) => inDir(file, "app/src/screens") || inDir(file, "app/src/components"),
    ).flatMap((file) =>
      specifiers(file.text)
        .filter((specifier) => reachesProvider(specifier) || reachesEngine(specifier))
        .map((specifier) => `${file.rel} → ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("the boundary reaches nothing but its own siblings (ARCH §5, §11 PRIV1)", () => {
  const PROVIDER_FILES = FILES.filter((file) => inDir(file, "core/src/provider"));

  test("the boundary is scanned at all", () => {
    // Same non-vacuity rule as above: an empty list would make the assertion below pass by default.
    expect(PROVIDER_FILES.map(relOf)).toContain("core/src/provider/openrouter.ts");
    expect(PROVIDER_FILES.length).toBeGreaterThan(3);
  });

  test("every specifier under core/src/provider/ resolves inside the directory", () => {
    // The adapter's *only* route to the vault would be an import, so closing the import closes the
    // route: this is what makes "invalid output ⇒ nothing stored" true by construction rather than by
    // discipline. A `node:` builtin reaches no state, so one is allowed; a **DB handle** is the
    // exception, named and refused (`node:sqlite`). A later stage that wants any other specifier
    // arrives as a *named* exception with its reason.
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
    for (const allowed of ["./schema.js", "./key.js", "node:crypto", "../failure.js"]) {
      expect(boundarySpecifierAllowed(allowed), allowed).toBe(true);
    }
    for (const refused of [
      "node:sqlite",
      "@astrolab/core",
      "../store/index.js",
      "../failure",
      "./schema",
    ]) {
      expect(boundarySpecifierAllowed(refused), refused).toBe(false);
    }
  });
});

/**
 * Which specifiers a file under `core/src/provider/` may use: a `./sibling.js` (the boundary's own
 * modules), or a `node:` builtin that reaches no state. Refused: any bare package, any `../` escape —
 * and **`node:sqlite`**, a DB handle, which would let the adapter write and demote *"invalid output ⇒
 * nothing stored"* from a construction to a promise.
 */
function boundarySpecifierAllowed(specifier: string): boolean {
  if (specifier === "node:sqlite") return false;
  // One named exception, with its reason (L3 · #166): `RunFailureCause` has to be shared by the engine
  // (which writes the row) and the vault (which reports E4) without a `vault → provider` edge, so the
  // vocabulary lives in the portable, provider-free `core/src/failure.ts`. It reaches no state.
  if (specifier === "../failure.js") return true;
  return /^\.\/[A-Za-z0-9_.-]+\.js$/.test(specifier) || specifier.startsWith("node:");
}

const PROVIDER_MODULE = "core/src/provider/openrouter.ts";

describe("the selection-internal vocabulary never leaves the selector (ARCH §3.3 items 2–4; PRD §3.3)", () => {
  // The descriptor, its cache table, the alignment axis, the gate thresholds and the adjudication draft
  // are internal: §0 and §3.3 forbid a `mechanism`, a distance, an alignment or a "related ideas"
  // readout on any surface — which holds only while no surface can reach them. The **selector** is
  // `engine/` + `provider/`; `store/` is excluded because it owns the shipped DDL and the cache writes
  // (the schema of record is not a surface).
  const SURFACES = FILES.filter(
    (file) => !SELECTOR_DIRS.some((dir) => inDir(file, dir)) && !inDir(file, SCHEMA_OWNER),
  );
  const VOCABULARY: Array<{ name: string; pattern: RegExp; bites: string }> = [
    {
      name: "the mechanism descriptor / its cache table",
      pattern: /idea_mechanism|MechanismDescriptor/,
      bites: "core/src/engine/mechanism.ts",
    },
    {
      name: "Axis 1 (the distance, the normaliser, its method)",
      pattern: /\bDomainDistance\b|TagNormalizer|normalizeTag/,
      bites: "core/src/engine/domain.ts",
    },
    {
      name: "Axis 2 (the similarity, the gated pair, the thresholds)",
      pattern:
        /descriptorSimilarity|gatedPairs|GatedPair|readGateConfig|min_domain_distance|min_alignment/,
      bites: "core/src/engine/gate.ts",
    },
    {
      name: "Stage 2's adjudication and the draft it carries",
      pattern:
        /SparkDraft|SparkAdjudicator|createAdjudicator|ConfirmedSpark|RejectedPair|\bAdjudication\b|\bAdjudicator\b/,
      bites: "core/src/engine/adjudicate.ts",
    },
  ];

  test("the scan reaches the surfaces, and every alternative bites inside the selector", () => {
    expect(SURFACES.length).toBeGreaterThan(15);
    for (const dir of ["core/src/vault", "core/src/domain", "core/src/export"]) {
      expect(
        SURFACES.some((file) => inDir(file, dir)),
        `no surface files under ${dir}`,
      ).toBe(true);
    }
    // A typo'd pattern passes silently; show each one matching something real.
    for (const { name, pattern, bites } of VOCABULARY) {
      expect(FILES.filter((file) => pattern.test(file.text)).map(relOf), name).toContain(bites);
    }
  });

  test("no surface names any of it", () => {
    const offenders = SURFACES.flatMap((file) =>
      VOCABULARY.filter(({ pattern }) => pattern.test(file.text)).map(
        ({ name }) => `${file.rel} → ${name}`,
      ),
    );

    expect(offenders).toEqual([]);
  });
});

describe("every call pins provider.zdr (ARCH §5, NFR-PRIV1) — pin 4", () => {
  test("exactly one source file writes the pin, and exactly one sends a request", () => {
    // The pin's *form*, not the bare word — so a comment mentioning ZDR does not fail the suite while a
    // second `provider: { zdr: … }` site does. (The brand makes a second site unusable anyway; this is
    // the belt to that braces.)
    const pins = FILES.filter((file) => /provider\s*:\s*\{[^}]*\bzdr\b/i.test(file.text)).map(
      relOf,
    );
    const callers = FILES.filter((file) => file.text.includes(".send(")).map(relOf);

    expect(pins).toEqual([PROVIDER_MODULE]);
    expect(callers).toEqual([PROVIDER_MODULE]);
  });
});

describe("one call site per operation (ARCH §11 PRIV1, data-flow audit) — EV6", () => {
  // **How many places can hand user text to a model?** §5's payload rule — "only the operation's
  // payload is sent" — is checkable *at a call site*, and it is unenumerable the moment a second one
  // appears. A **provider call site** is a `.op(` whose receiver is *declared with that operation's
  // interface type* in the same file: the anchor is the declaration, not the method name, because
  // `run.ts` calls `adjudicator.adjudicate(eligible)` on the engine's own stage. "Declared with that
  // interface" is read off the annotation **as written**, normalised — an `import("…").X` qualifier, a
  // renamed import (`X as Y`), a local `type Y = X` alias and a namespace import's member (`P.X`) all
  // name the same declaration, and the interface module's own aggregate alias (`Provider`) counts for
  // all three operations (#171; the `P.X` spelling is #174). What the normalisation does *not* reach is
  // stated at the anchored arm's own test and in the residual below the exact-set arm.
  const IFACES: Record<string, string> = {
    extract: "MechanismExtractor",
    adjudicate: "SparkAdjudicator",
    normalizeTag: "TagNormalizer",
  };
  /** A literal regex from a name read out of source — `$` is not special *and* not a word character. */
  const literal = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /**
   * The module that **declares** the three interfaces, and its own alias for them: `Provider` is
   * `MechanismExtractor & SparkAdjudicator & TagNormalizer`, so a receiver annotated `Provider` is the
   * same declaration one hop out — the spelling `compose.ts` and the app's composition root both use.
   */
  const IFACE_MODULE = FILES.find((file) => file.rel === "core/src/provider/types.ts")?.text ?? "";
  /**
   * Every name a text binds to `interfaceName`: the name itself, a renamed import (`X as Y`), a local
   * type alias (`type Y = X`, itself possibly `import(…).X`), chained to a fixpoint — plus, for every
   * namespace import the text holds (`import * as P from "…"`), that namespace's member spelling
   * (`P.X`). The anchor reads an **annotation**, and an annotation's spelling is not the declaration:
   * a qualified, aliased or renamed annotation declares the same interface, and all of them walked past
   * the literal-adjacency anchor (#171, found by mutation in review of #170; the namespace-qualified
   * spelling was the one #171's list still missed, #174 — it is bound only where the file actually
   * imports the namespace, so a qualified annotation is not counted on the prefix alone).
   * Qualification applies to bare names only — `P.X` is not itself re-qualified — so the fixpoint
   * terminates.
   */
  const boundNames = (texts: readonly string[], interfaceName: string): string[] => {
    const names = new Set([interfaceName]);
    const namespaces = new Set<string>();
    for (const text of texts) {
      for (const match of text.matchAll(/\bimport\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][\w$]*)/g)) {
        if (match[1] !== undefined) namespaces.add(match[1]);
      }
    }
    for (let added = true; added;) {
      added = false;
      for (const name of [...names]) {
        if (!name.includes(".")) {
          for (const namespace of namespaces) {
            const qualified = `${namespace}.${name}`;
            if (names.has(qualified)) continue;
            names.add(qualified);
            added = true;
          }
        }
        for (const text of texts) {
          for (const pattern of [
            `\\b${literal(name)}\\s+as\\s+([A-Za-z_$][\\w$]*)`,
            `\\btype\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:import\\([^)]*\\)\\.)?${literal(name)}(?![\\w$])`,
          ]) {
            for (const match of text.matchAll(new RegExp(pattern, "g"))) {
              const found = match[1];
              if (found === undefined || names.has(found)) continue;
              names.add(found);
              added = true;
            }
          }
        }
      }
    }
    return [...names];
  };
  const opCalls = (text: string): Array<{ receiver: string; op: string }> =>
    [...text.matchAll(/([A-Za-z_$][\w$]*)\.(extract|adjudicate|normalizeTag)\s*\(/g)].map(
      (match) => ({ receiver: match[1] ?? "", op: match[2] ?? "" }),
    );
  const isProviderSite = (
    file: { text: string },
    call: { receiver: string; op: string },
  ): boolean => {
    const interfaceName = IFACES[call.op];
    if (interfaceName === undefined) return false;
    const names = boundNames([IFACE_MODULE, file.text], interfaceName).map(literal).join("|");
    // `(?<![\w$])`/`(?![\w$])` rather than `\b`: `$` is neither a word character nor a regex literal, so
    // the `\b` form matched no `$`-named receiver at all (measured — that spelling walked past it too).
    return new RegExp(
      `(?<![\\w$])${literal(call.receiver)}\\s*:\\s*(?:import\\([^)]*\\)\\.)?(?:${names})(?![\\w$])`,
    ).test(file.text);
  };

  /** The three operations, and the one product module each is called from (`ARCHITECTURE.md` §3.3). */
  const OPERATIONS = [
    { op: "extract", module: "core/src/engine/mechanism.ts" },
    { op: "adjudicate", module: "core/src/engine/adjudicate.ts" },
    { op: "normalizeTag", module: "core/src/engine/domain.ts" },
  ];
  /** The W9 calibration driver is a *named* exception: it fires the same prompts on purpose. */
  const CALIBRATION = "core/src/engine/calibration";
  const productFiles = FILES.filter((file) => !inDir(file, CALIBRATION));
  /** The operation **names**, as whole words — the data-flow vocabulary (deliberately over-inclusive). */
  const OP_NAME = /\b(?:extract|adjudicate|normalizeTag)\b/;
  const namesOperation = (file: { text: string }): boolean => OP_NAME.test(file.text);

  test("the tripwire sees a call with, and without, a receiver — the hole it was widened for", () => {
    const anchored = { text: "const d = await extractor.extract(text);" };
    const valueRef = { text: "const { extract } = provider;\nreturn extract(text as never);" };
    expect(namesOperation(anchored)).toBe(true);
    expect(namesOperation(valueRef)).toBe(true);
    expect(opCalls(anchored.text)).toHaveLength(1);
    expect(opCalls(valueRef.text)).toEqual([]);
    // A near-miss the rule must not swallow: the *word* `extraction` is not the operation `extract`.
    expect(namesOperation({ text: "import { extractionUser } from './prompts.js';" })).toBe(false);
  });

  test("the anchor is the receiver's declaration, not the method name", () => {
    const holder = {
      text: "function f(provider: SparkAdjudicator) { return provider.adjudicate(a, b); }",
    };
    const stage = {
      text: "function g(adjudicator: Adjudicator) { return adjudicator.adjudicate(ps); }",
    };
    expect(opCalls(holder.text).filter((call) => isProviderSite(holder, call))).toHaveLength(1);
    expect(opCalls(stage.text).filter((call) => isProviderSite(stage, call))).toHaveLength(0);
  });

  test("the anchor normalises the annotation's spelling, not just its adjacency (#171)", () => {
    // The anchor used to be the literal adjacency `<receiver>: <InterfaceName>`. A receiver declared
    // with the interface through a qualifier, a rename or an alias is the same declaration, and all
    // three walked past it — measured by mutation in review of #170 (#171).
    const SPELLINGS: Array<{ label: string; text: string }> = [
      { label: "plain", text: "declare const ex: MechanismExtractor;\nawait ex.extract(t);" },
      {
        label: "import(...) qualifier",
        text: 'declare const ex: import("../provider/index.js").MechanismExtractor;\nawait ex.extract(t);',
      },
      {
        label: "local type alias",
        text: "type ME = MechanismExtractor;\ndeclare const ex: ME;\nawait ex.extract(t);",
      },
      {
        label: "renamed import",
        text: 'import type { MechanismExtractor as MEx } from "../provider/types.js";\ndeclare const ex: MEx;\nawait ex.extract(t);',
      },
      {
        label: "renamed import, aliased again",
        text: 'import type { MechanismExtractor as MEx } from "../provider/types.js";\ntype ME2 = MEx;\ndeclare const ex: ME2;\nawait ex.extract(t);',
      },
      {
        label: "the interface module's aggregate alias",
        text: "declare const ex: Provider;\nawait ex.extract(t);",
      },
      {
        label: "$-named receiver",
        text: "declare const $ex: MechanismExtractor;\nawait $ex.extract(t);",
      },
      {
        label: "namespace-qualified import",
        text: 'import type * as P from "../provider/types.js";\ndeclare const ex: P.MechanismExtractor;\nawait ex.extract(t);',
      },
    ];
    for (const { label, text } of SPELLINGS) {
      const file = { text };
      expect(
        opCalls(text).filter((call) => isProviderSite(file, call)),
        label,
      ).toHaveLength(1);
    }

    // Near-miss controls for the namespace leg — the two ways the widening could have been bought by
    // over-matching instead of by binding. A longer name qualified by the same namespace is not the
    // interface (`P.MechanismExtractorLike`), and a qualified annotation with no `import * as` in the
    // file is not a bound name: the leg keys on the import, not on the dot.
    const qualifiedPrefix = {
      text: 'import type * as P from "../provider/types.js";\ndeclare const ex: P.MechanismExtractorLike;\nawait ex.extract(t);',
    };
    const unimportedNamespace = {
      text: "declare const ex: P.MechanismExtractor;\nawait ex.extract(t);",
    };
    for (const control of [qualifiedPrefix, unimportedNamespace]) {
      expect(opCalls(control.text).filter((call) => isProviderSite(control, call))).toHaveLength(0);
    }

    // The residual, pinned rather than left to prose: resolution is same-file plus one hop into the
    // module that *declares* the interfaces, so an annotation that does not spell the interface as a
    // bound name — here an alias imported from a third module — is not counted. A utility/mapped type
    // is the same shape.
    const thirdModule = {
      text: 'import type { ME } from "./helpers.js";\ndeclare const ex: ME;\nawait ex.extract(t);',
    };
    expect(
      opCalls(thirdModule.text).filter((call) => isProviderSite(thirdModule, call)),
    ).toHaveLength(0);

    // A near-miss the resolution must keep swallowing: `Adjudicator` is the engine's own stage, and its
    // method deliberately shares the operation's name (`run.ts`).
    const stage = {
      text: "declare const stage: Adjudicator;\nawait stage.adjudicate(a, b);",
    };
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

  test("no product file names an operation the anchor did not account for", () => {
    // The exact set, not a filter: a *new* naming of an operation anywhere under a package's `src/` is
    // a privacy-relevant event — §5's payload rule has to be re-checked at the new site — so the guard
    // **names every file that mentions one today**, call or citation. Three of these name an operation
    // only in an import path or a doc citation (`compose.ts`, `suppression.ts`, `prompts.ts`), and they
    // are here precisely so a *documentation* mention in a new file is also a stop-and-look.
    expect(productFiles.filter(namesOperation).map(relOf).sort()).toEqual([
      "core/src/engine/adjudicate.ts",
      "core/src/engine/compose.ts",
      "core/src/engine/domain.ts",
      "core/src/engine/mechanism.ts",
      "core/src/engine/run.ts",
      "core/src/engine/suppression.ts",
      "core/src/provider/openrouter.ts",
      "core/src/provider/prompts.ts",
      "core/src/provider/types.ts",
    ]);
    // Non-vacuity, the way the walk's are: the tripwire must reach the three modules whose *call* the
    // arm above counts, or a typo'd pattern would pass by matching nothing.
    for (const { module } of OPERATIONS) {
      expect(productFiles.filter(namesOperation).map(relOf), module).toContain(module);
    }
    // Named, not filtered: the calibration harness names all three ops on purpose.
    expect(
      FILES.filter((file) => inDir(file, CALIBRATION) && namesOperation(file)).map(relOf),
    ).toEqual(["core/src/engine/calibration/w9-run.ts"]);
    // The residual, stated rather than hidden — and now in the two parts #171 separated. This arm moves
    // only on a new **file** in the vocabulary, so a second naming *inside* a file already listed does
    // not move the set. What covers that is the anchored arm above, whose anchor is the receiver's
    // *annotation*: it resolves the qualifier, the rename, the alias and a namespace import's member
    // (`P.X`), but **not** an annotation that does not spell the interface as a bound name — a
    // utility/mapped type, or an alias imported from a third module (pinned in that test). Neither
    // residual is a privacy
    // regression on its own: a second call site still has to sit under `provider/` or `engine/`, and it
    // still goes through the one ZDR-pinned `buildRequest` (`pins == [PROVIDER_MODULE]` above).
  });

  test("the calibration exception is script-only — no src module outside it imports the harness", () => {
    // "Named exception" has to mean *unreachable from the boot path*, or it is a hole with a comment on
    // it. Two halves: nothing the walk reaches outside `calibration/` imports it, and the only importers
    // are dev scripts.
    const importsHarness = (text: string): boolean =>
      specifiers(text).some((specifier) => /(^|\/)calibration\//.test(specifier));
    expect(
      FILES.filter((file) => !inDir(file, CALIBRATION) && importsHarness(file.text)).map(relOf),
    ).toEqual([]);

    // `scripts/w9-calibrate.ts` fires the calibration and `scripts/w9-c5-fixture.ts` mints the C5
    // regression fixture from its artifact — both dev scripts, both reading `core/`'s source by path.
    const scriptImporters = readdirSync(join(ROOT, "scripts"))
      .filter((name) => SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)))
      .filter((name) => importsHarness(readFileSync(join(ROOT, "scripts", name), "utf8")));
    expect(scriptImporters.length, "no dev script imports the calibration harness").toBeGreaterThan(
      0,
    );
  });
});

describe("Done 5 — no synthetic seeds, no note import (ARCH §7; PRD §3.4 item 3) — W7", () => {
  // The negative requirement: **neither the engine nor an app surface generates ideas on the user's
  // behalf**, and **nothing imports a user's notes**. Nothing does the forbidden thing, so there is no
  // positive surface to test — the risk is that a check nobody wrote regresses silently the first time
  // someone reaches for the obvious shortcut.

  test("A: no source outside the vault writes an idea table", () => {
    // `\b` after the table name so `idea_mechanism` (a cache row, written by the engine) is not pulled
    // in: `\b` fails between `idea` and `_`.
    const IDEA_WRITE = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:idea|idea_version)\b/i;
    const writers = FILES.filter((file) => IDEA_WRITE.test(file.text)).map(relOf);

    // Positive control: the user-intent path is the writer, and the walk reaches it.
    expect(writers).toContain("core/src/vault/capture.ts");
    expect(
      FILES.filter((file) => !inDir(file, "core/src/vault") && IDEA_WRITE.test(file.text)).map(
        relOf,
      ),
    ).toEqual([]);
  });

  test("B: the only file-reading call in a shipped src/ is the shipped taxonomy", () => {
    // "Imports existing notes" (`PRD.md` §3.4 item 3) is a file *read*. A live product can read exactly
    // one file — `core/src/store/domain-seed.ts`'s shipped taxonomy (`ARCHITECTURE.md` §3.2). The build
    // scripts under `scripts/` are tooling, not a package's `src/`. The **call**, not the name:
    // importing `readFileSync` reads nothing, and a comment mentioning it is not a read.
    const READ = /(?:readFileSync|readFile|createReadStream|readdirSync)\s*\(/;
    expect(FILES.filter((file) => READ.test(file.text)).map(relOf)).toEqual([
      "core/src/store/domain-seed.ts",
    ]);
    // Non-vacuity: the walk excludes test files, and every other reader in the repo is a test — so if
    // the walk ever started including one, this list would grow and the test would say so.
    expect(FILES.some((file) => file.rel.endsWith(".test.ts"))).toBe(false);
  });

  test("C: no exported provider operation returns an idea-shaped payload", () => {
    // The engine's only route to *mint* an idea would be a provider op whose output is one. The
    // provider's *inputs* carry idea text on purpose (`IdeaText` is the operation payload, §5); the
    // claim is about what an operation *returns*.
    const providerTypes = FILES.find((file) => file.rel === "core/src/provider/types.ts");
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
    // Positive control: the matcher and the field set are real — the input type does carry them.
    expect(IDEA_FIELDS.test(body("IdeaText"))).toBe(true);
  });
});

describe("thresholds stay out of the schema (ARCH §3.4; #30 Done) — W5", () => {
  test("the `config` table is created once — no migration adds a threshold", () => {
    const creators = MIGRATIONS.filter((migration) => /CREATE TABLE config\b/.test(migration.sql));
    expect(creators.map((migration) => migration.version)).toEqual([1]);
  });
});
