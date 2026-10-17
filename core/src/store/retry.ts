/**
 * Bounded retry-with-backoff for `SQLITE_BUSY` (ARCHITECTURE.md §9, ADR-0001).
 *
 * SQLite takes one file-wide write lock, so the API and worker — two processes on one file — can
 * collide. WAL + `busy_timeout` absorb most of it; this is the backstop, and it is deliberately
 * *bounded*: a write that cannot get through must fail loudly rather than retry forever.
 */

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  /** First backoff in ms; doubles each attempt. */
  baseDelayMs?: number;
  /** Backoff ceiling in ms. */
  maxDelayMs?: number;
  /** Injected by tests; defaults to a synchronous sleep. */
  sleep?: (ms: number) => void;
}

const DEFAULTS = { attempts: 5, baseDelayMs: 20, maxDelayMs: 250 } as const;

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

/** Synchronous sleep: the store's API is synchronous (`SqliteConnection`), so a promise would not do. */
function blockingSleep(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

/**
 * The busy/locked family. `errcode` carries SQLite's primary code (5 BUSY, 6 LOCKED; extended codes
 * such as BUSY_SNAPSHOT 517 mask down to 5). The code+message arm covers runtimes that report only
 * the Node error code.
 */
export function isBusyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { errcode, code, message } = err as {
    errcode?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (typeof errcode === "number" && ((errcode & 0xff) === 5 || (errcode & 0xff) === 6))
    return true;
  return code === "ERR_SQLITE_ERROR" && /lock|busy/i.test(String(message));
}

export function withRetry<T>(fn: () => T, options: RetryOptions = {}): T {
  const attempts = options.attempts ?? DEFAULTS.attempts;
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const sleep = options.sleep ?? blockingSleep;
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError("attempts must be >= 1");

  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (attempt >= attempts - 1 || !isBusyError(err)) throw err;
      sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** attempt));
    }
  }
}
