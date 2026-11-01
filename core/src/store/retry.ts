/**
 * Bounded retry-with-backoff for `SQLITE_BUSY` (ARCHITECTURE.md §9, ADR-0001 as amended by ADR-0006).
 *
 * SQLite takes one file-wide write lock, so **two connections** — not two processes, since the app is
 * the only writer now — can collide. WAL + `busy_timeout` absorb most of it; this is the backstop, and
 * it is deliberately *bounded*: a write that cannot get through must fail loudly rather than retry
 * forever. With one in-process writer it is a **guard, not a routine cost** — the same posture
 * `store.ts` states at `openStore`/`writeTransaction`, and it must keep agreeing with it.
 */

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  /** First backoff in ms; doubles each attempt. */
  baseDelayMs?: number;
  /** Backoff ceiling in ms. */
  maxDelayMs?: number;
  /** Injected by tests; defaults to {@link spinSleep}. */
  sleep?: (ms: number) => void;
}

const DEFAULTS = { attempts: 5, baseDelayMs: 20, maxDelayMs: 250 } as const;

/**
 * Synchronous sleep: the store's API is synchronous (`SqliteConnection`), so a promise would not do.
 *
 * **Portable by construction (#187).** It derefs neither of the globals the device and the browser
 * take away: `SharedArrayBuffer` is undefined outside a cross-origin-isolated page, and
 * `Atomics.wait` throws `TypeError: Atomics.wait cannot be called in this context` on the **web main
 * thread** — even inside a COI page, which is where this guard runs. `expo-sqlite` may block with
 * `Atomics.wait` because it does so *inside a Worker* (`connection.ts:35`); a retry on the caller's
 * thread cannot.
 *
 * The cost is a bounded spin: this is a **guard, not a routine cost** (a second in-process writer is
 * the only way in), and the whole ladder is at most four waits of at most `maxDelayMs`.
 */
function spinSleep(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Spin on the clock: no timer, no worker, no global — just the deadline.
  }
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

/** {@link RetryOptions}, with the sleep allowed to be awaited — the async channel's shape. */
export interface AsyncRetryOptions extends Omit<RetryOptions, "sleep"> {
  /** Injected by tests; defaults to a timer, **never** a blocking wait (see below). */
  sleep?: (ms: number) => void | Promise<void>;
}

/**
 * Async sleep. Deliberately **not** {@link blockingSleep}: an `Atomics.wait` on the web main thread
 * throws (`Atomics.wait cannot be called in this context`), and the whole point of the async channel is
 * to let the main thread yield. A timer does exactly that.
 */
function timerSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * {@link withRetry} for the async channel (#186) — the same bounded policy, the same `isBusyError` test,
 * the same `DEFAULTS`, over awaited operations. Only the sleep differs, and it has to: the sync path's
 * `Atomics.wait` cannot run on the web main thread.
 */
export async function withRetryAsync<T>(
  fn: () => Promise<T>,
  options: AsyncRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULTS.attempts;
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const sleep = options.sleep ?? timerSleep;
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError("attempts must be >= 1");

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts - 1 || !isBusyError(err)) throw err;
      await sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** attempt));
    }
  }
}

export function withRetry<T>(fn: () => T, options: RetryOptions = {}): T {
  const attempts = options.attempts ?? DEFAULTS.attempts;
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const sleep = options.sleep ?? spinSleep;
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
