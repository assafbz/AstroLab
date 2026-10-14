import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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
    // `node:` builtins are allowed (none today) so a future `node:crypto` hash — which reaches no
    // state — does not have to fight the guard. Anything else (a bare package, a `../` escape) is
    // refused; a later stage that wants one should arrive as a *named* exception with its reason.
    // W3's `idea_mechanism` cache write stays above this line, in engine code, for exactly that reason.
    const offenders: string[] = [];
    for (const file of PROVIDER_FILES) {
      for (const specifier of specifiers(file.text)) {
        if (!/^\.\/[A-Za-z0-9_.-]+\.js$/.test(specifier) && !specifier.startsWith("node:")) {
          offenders.push(`${file.rel} → ${specifier}`);
        }
      }
    }

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
