import { describe, expect, test, vi } from "vitest";

import { isBusyError, withRetry } from "./retry.js";

const busy = () => Object.assign(new Error("database is locked"), { errcode: 5 });

describe("withRetry", () => {
  test("retries a busy write, doubling the backoff, and returns its value", () => {
    const sleep = vi.fn();
    let calls = 0;
    const result = withRetry(
      () => {
        if (++calls < 3) throw busy();
        return "ok";
      },
      { sleep },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([20, 40]);
  });

  test("gives up after the attempt budget and rethrows the busy error", () => {
    const sleep = vi.fn();
    expect(() =>
      withRetry(
        () => {
          throw busy();
        },
        { attempts: 3, sleep },
      ),
    ).toThrow(/locked/);
    // Three attempts means two waits — bounded, not endless.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test("caps the backoff at maxDelayMs", () => {
    const sleep = vi.fn();
    expect(() =>
      withRetry(
        () => {
          throw busy();
        },
        { attempts: 4, baseDelayMs: 100, maxDelayMs: 150, sleep },
      ),
    ).toThrow(/locked/);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 150, 150]);
  });

  test("does not retry a non-busy error", () => {
    const sleep = vi.fn();
    const boom = new Error("no such table: idea");
    expect(() =>
      withRetry(
        () => {
          throw boom;
        },
        { sleep },
      ),
    ).toThrow(boom);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("isBusyError", () => {
  test("recognises the busy/locked family and nothing else", () => {
    expect(isBusyError({ errcode: 5 })).toBe(true); // SQLITE_BUSY
    expect(isBusyError({ errcode: 517 })).toBe(true); // SQLITE_BUSY_SNAPSHOT, masked to 5
    expect(isBusyError({ errcode: 6 })).toBe(true); // SQLITE_LOCKED
    expect(isBusyError({ code: "ERR_SQLITE_ERROR", message: "database is locked" })).toBe(true);
    expect(isBusyError({ code: "ERR_SQLITE_ERROR", message: "no such table: idea" })).toBe(false);
    expect(isBusyError(new Error("nope"))).toBe(false);
    expect(isBusyError(null)).toBe(false);
  });
});
