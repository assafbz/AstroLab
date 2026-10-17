import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * ARCHITECTURE.md §4's trigger, as a *checked* invariant rather than a convention (issue #26 review).
 *
 * The failure this guards against is **forgetfulness, not malice**: a new vault-write path (iterate,
 * fork, delete, complete — V3/V4/V5) reaching for `writeTransaction` and forgetting the stamp leaves
 * a mutation that advances the vault with no run, or lets a stale run offer candidates for a revision
 * it was not cut from. Neither is visible: no error, no failing behaviour test.
 *
 * So: **every module that writes a vault table must reach it through `vaultMutation`** — checked by
 * import, not by a mention. A source scan is a coarse instrument; it is honest about its limit. It
 * cannot prove a call is *inside* the wrapper, only that the module has one. That is enough for the
 * failure mode it exists for, and it costs nothing to run.
 */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The four tables §4's trigger governs: an idea write *is* a candidate-affecting mutation. */
const VAULT_TABLES = ["idea_version", "provenance_edge", "decision", "idea"];

const DML = (table: string) =>
  new RegExp(`\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${table}\\b`, "i");

const VAULT_WRITE = new RegExp(
  `\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:${VAULT_TABLES.join("|")})\\b`,
  "i",
);

/**
 * Reaching the helper by name is not enough — the module must import it. Both spellings: the package's
 * own modules by relative path, and `worker/` (until L3 relocates it) by package name.
 */
const IMPORTS_HELPER =
  /import\s*\{[^}]*\bvaultMutation\b[^}]*\}\s*from\s*"[^"]*(?:@astrolab\/store|\/store\/(?:index|vault)\.js)"/;

/** Only these two modules may touch `spark_run`: the queue itself and the trigger's wrapper. */
const SPARK_RUN_OWNERS = ["core/src/store/runs.ts", "core/src/store/vault.ts"];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "artifacts", ".agents", "data"]);

/** Every non-test `.ts` under a package's `src/` — test fixtures are not production write paths. */
function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(join(dir, entry.name), found);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      const path = join(dir, entry.name);
      if (relative(ROOT, path).split(/[\\/]/).includes("src")) found.push(path);
    }
  }
  return found;
}

const FILES = sourceFiles(ROOT).map((path) => ({
  path,
  rel: relative(ROOT, path).split(/[\\/]/).join("/"),
  text: readFileSync(path, "utf8"),
}));

describe("vault writes go through vaultMutation (ARCHITECTURE.md §4)", () => {
  test("the scan actually sees the vault writes it is guarding", () => {
    // Without this, a broken regex would turn every assertion below into a silent pass. It asserts a
    // known writer is seen — not the exact set, which would make every new vault-write module
    // (V3/V4/V5) edit this test just to go green.
    const writers = FILES.filter((f) => VAULT_WRITE.test(f.text)).map((f) => f.rel);

    expect(writers).toContain("core/src/vault/capture.ts");
  });

  test("every module writing a vault table imports and calls vaultMutation", () => {
    const offenders = FILES.filter(
      (f) =>
        VAULT_WRITE.test(f.text) &&
        !(IMPORTS_HELPER.test(f.text) && f.text.includes("vaultMutation(")),
    ).map((f) => f.rel);

    expect(offenders).toEqual([]);
  });

  test("only the queue and its wrapper touch spark_run", () => {
    const offenders = FILES.filter(
      (f) => DML("spark_run").test(f.text) && !SPARK_RUN_OWNERS.includes(f.rel),
    ).map((f) => f.rel);

    expect(offenders).toEqual([]);
  });

  test("nothing re-implements the trigger: the vault_meta bump lives in one place", () => {
    const offenders = FILES.filter(
      (f) => /vault_meta\s+SET\s+revision/.test(f.text) && f.rel !== "core/src/store/runs.ts",
    ).map((f) => f.rel);

    expect(offenders).toEqual([]);
  });

  test("writeTransaction stays off the surface — asserted on the module, not on its source text", async () => {
    // A text grep of index.ts is blind to the one re-export form without braces: add
    // `export * from "./store.js"` and the text still looks clean while `writeTransaction` is back on
    // the namespace. Ask the module itself instead.
    const store = await import("../src/index.js");
    const exported = Object.keys(store);

    expect(exported).toContain("vaultMutation"); // sanity: the module loaded and does export things
    expect(exported).not.toContain("writeTransaction");
  });
});
