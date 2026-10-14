import { expect, test, vi } from "vitest";

import { createRunTrigger } from "./run-trigger.ts";

/** A promise whose settlement the test drives — the only way to observe "still in flight". */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("a fire enqueues once and reports that it sent one", async () => {
  const enqueue = vi.fn(() => Promise.resolve({ run_id: "r-1", vault_revision: 1 }));
  const trigger = createRunTrigger(enqueue);

  expect(trigger.fire()).toBe(true);
  expect(enqueue).toHaveBeenCalledTimes(1);
  await enqueue.mock.results[0]!.value;
});

/**
 * The guard itself: two presses while the first POST is unresolved send **one** POST. Remove the guard
 * and this is `toHaveBeenCalledTimes(2)` — the duplicated-run edge §4.16's PENDING-only dedup leaves open.
 */
test("a second press while the first POST is in flight is ignored", () => {
  const first = deferred<unknown>();
  const enqueue = vi.fn(() => first.promise);
  const trigger = createRunTrigger(enqueue);

  expect(trigger.fire()).toBe(true);
  expect(trigger.fire()).toBe(false);
  expect(trigger.fire()).toBe(false);
  expect(enqueue).toHaveBeenCalledTimes(1);

  first.resolve(undefined);
});

test("the guard releases once the POST settles, so a later press sends again", async () => {
  const enqueue = vi.fn(() => Promise.resolve(undefined));
  const trigger = createRunTrigger(enqueue);

  trigger.fire();
  // Let the microtask queue drain so the `.finally` releases the guard.
  await Promise.resolve();
  await Promise.resolve();

  expect(trigger.fire()).toBe(true);
  expect(enqueue).toHaveBeenCalledTimes(2);
});

/** A dropped failure is not a wedged guard: the rejection is swallowed and the next press still sends. */
test("a rejected POST is dropped and still releases the guard", async () => {
  const enqueue = vi
    .fn<() => Promise<unknown>>()
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce(undefined);
  const trigger = createRunTrigger(enqueue);

  trigger.fire();
  await Promise.resolve();
  await Promise.resolve();

  expect(trigger.fire()).toBe(true);
  expect(enqueue).toHaveBeenCalledTimes(2);
});
