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

/**
 * #187. `withRetry`'s default sleep used to be a module-scope `SharedArrayBuffer` + `Atomics.wait`.
 * Neither global survives the app's real path — outside a cross-origin-isolated page the
 * `SharedArrayBuffer` constructor is undefined, and on the **web main thread** `Atomics.wait` throws
 * `TypeError: Atomics.wait cannot be called in this context` *inside* a COI page too. Node defines
 * both, so no ordinary test can see the defect: these two remove the globals and then look.
 *
 * The import is dynamic and after `vi.resetModules()`, because the defect was at **module
 * evaluation** — a static import would have been evaluated long before the globals were removed.
 */
describe("the default sleep is portable (#187)", () => {
  const withoutGlobals = async <T>(run: () => Promise<T> | T): Promise<T> => {
    const realSab = globalThis.SharedArrayBuffer;
    const realWait = Atomics.wait;
    Object.defineProperty(globalThis, "SharedArrayBuffer", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(Atomics, "wait", { value: undefined, configurable: true });
    try {
      vi.resetModules();
      return await run();
    } finally {
      Object.defineProperty(globalThis, "SharedArrayBuffer", {
        value: realSab,
        configurable: true,
      });
      Object.defineProperty(Atomics, "wait", { value: realWait, configurable: true });
    }
  };

  test("the module still imports when neither global exists", async () => {
    const fresh = await withoutGlobals(() => import("./retry.js"));
    expect(typeof fresh.withRetry).toBe("function");
  });

  test("a busy write still retries when neither global exists", async () => {
    // The stubs have to stay removed **while `withRetry` runs**: the defect is not only at import
    // time, it is the sleep itself. (Restoring the globals around the import alone would make this
    // case vacuous — seen while planting the old implementation back: it stayed green.)
    let calls = 0;
    const result = await withoutGlobals(async () => {
      const fresh = await import("./retry.js");
      return fresh.withRetry(
        () => {
          if (++calls < 2) throw busy();
          return "ok";
        },
        { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      );
    });

    expect(result).toBe("ok");
    expect(calls).toBe(2);
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
