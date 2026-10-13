import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { openStore } from "../src/store.js";
import { runChild } from "./harness.js";

/**
 * F2's acceptance criterion: "a test with two concurrent writers passes" (ARCHITECTURE.md §9).
 * Two *processes*, because the store's whole concurrency story is two processes on one file.
 */
const WRITERS = 2;
const ROWS_EACH = 40;

const dirs: string[] = [];
function tempStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "astrolab-writers-"));
  dirs.push(dir);
  return join(dir, "astrolab.sqlite");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test(
  "two concurrent writers both commit — WAL + busy_timeout + retry absorb the collisions",
  { timeout: 60_000 },
  async () => {
    const path = tempStorePath();
    const setup = openStore(path);
    setup.exec("CREATE TABLE t (k INTEGER)");
    setup.close();

    const write = () => runChild("writer.ts", [path, String(ROWS_EACH)]);
    const results = await Promise.all([write(), write()]);

    expect(results.map((r) => r.code)).toEqual([0, 0]);
    // Node 22 prints an `ExperimentalWarning` for `node:sqlite` in every process that imports it,
    // so stderr is not empty there. What must never appear is a failure.
    for (const r of results) expect(r.stderr).not.toMatch(/SQLITE_BUSY|Error:/);

    const check = openStore(path);
    try {
      expect(check.prepare("SELECT count(*) AS n FROM t").get()?.n).toBe(WRITERS * ROWS_EACH);
    } finally {
      check.close();
    }
  },
);
