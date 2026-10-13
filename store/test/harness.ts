import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_DIR = join(TEST_DIR, "..");

/**
 * Runs a child fixture (`writer.ts`, `boot.ts`) as its own process via `node --import tsx`.
 *
 * These tests need *real processes*: the store's concurrency story is two processes on one file,
 * and a single process cannot hold two SQLite write locks against each other.
 */
export function runChild(
  script: string,
  args: string[],
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(TEST_DIR, script), ...args], {
      cwd: PACKAGE_DIR,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

/** Sleeping on a timestamp is how two children are aimed at the same instant without a poll loop. */
export function sleepUntil(atEpochMs: number): void {
  const wait = Math.max(0, atEpochMs - Date.now());
  if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
}
