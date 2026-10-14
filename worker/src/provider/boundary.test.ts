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
 *
 * Both are mutation-checked in the PR: plant a violation, watch it fail, restore.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PROVIDER_MODULE = "worker/src/provider/openrouter.ts";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "artifacts", ".agents", "data"]);
/** Where the vault lives. A provider import anywhere under these is the bug this file exists for. */
const VAULT_PACKAGES = ["api", "store"];

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(join(dir, entry.name), found);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      const path = join(dir, entry.name);
      // Only a package's `src/` — test fixtures are not production code paths.
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

  test("no api/ or store/ source imports the provider module", () => {
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
