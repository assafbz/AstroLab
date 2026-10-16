import { expect, test, vi } from "vitest";

import { ApiError } from "../api/client.ts";
import type { Decision } from "../api/types.ts";
import type { ResolutionKind } from "./deck-interaction.ts";
import { createDecisionResolver } from "./decision.ts";

const DECISION: Decision = {
  decision_id: "id-1",
  spark_id: "s1",
  kind: "ACCEPT",
  result_idea_id: "9f1c",
  spark_status: "RESOLVED-ACCEPTED",
  decided_at: "2026-10-13T05:14:05Z",
  undoable: true,
};

/** Let the resolver's `.then` chain settle. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * A `post` whose outcome each call chooses, and whose arguments the test can read back. The call log is
 * the evidence: the whole point of the module is *which* `decision_id` reaches the wire, so every
 * assertion below is about the ids in `post.mock.calls`, not about a returned value the seam (void)
 * never carries.
 */
type PostImpl = (
  sparkId: string,
  decisionId: string,
  kind: ResolutionKind,
) => Promise<Decision | null>;

function harness(impl: PostImpl, ids: string[] = ["id-1", "id-2", "id-3"]) {
  const post = vi.fn(impl);
  const onResolved = vi.fn();
  const onFailed = vi.fn();
  let next = 0;
  const resolver = createDecisionResolver({
    post,
    onResolved,
    onFailed,
    // Deterministic and countable: a fresh id cannot hide behind `crypto`.
    newId: () => ids[next++]!,
  });
  return { post, onResolved, onFailed, resolver };
}

/** A deferred promise the test settles by hand — for the raced-twin case. */
function deferred() {
  let settle!: (decision: Decision | null) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<Decision | null>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

/** The `decision_id` each post carried, in call order. */
function idsPosted(post: ReturnType<typeof vi.fn>): string[] {
  return post.mock.calls.map((call) => call[1] as string);
}

test("a second press for one spark reuses the id — keyed on the spark, not the kind (§2.2, §4.3)", async () => {
  // §4.3's raced swipe + tap: both reach the seam identically (§5.5), and the client must not mint a
  // second key — with two ids the server records **two** decisions, which is the defect the key exists
  // to remove. The kinds differ here on purpose: the key is the *spark's*, not the kind's.
  const { post, resolver } = harness(() => Promise.resolve(DECISION));

  resolver.resolve("s1", "ACCEPT");
  resolver.resolve("s1", "DISMISS");
  await flush();

  expect(post).toHaveBeenCalledTimes(2);
  expect(idsPosted(post)).toEqual(["id-1", "id-1"]);
});

test("distinct sparks get distinct ids — one decision per spark, not one per session", async () => {
  const { post, resolver } = harness(() => Promise.resolve(DECISION));

  resolver.resolve("s1", "ACCEPT");
  resolver.resolve("s2", "ACCEPT");
  await flush();

  expect(idsPosted(post)).toEqual(["id-1", "id-2"]);
});

test("the kind reaches the wire unchanged — the module narrows nothing (§4.13's two are the route's)", async () => {
  const { post, resolver } = harness(() => Promise.resolve(DECISION));

  resolver.resolve("s1", "DISMISS");
  await flush();

  expect(post.mock.calls[0]).toEqual(["s1", "id-1", "DISMISS"]);
});

test("a success reports the Decision and spends the key — the next press is a new decision", async () => {
  const { post, onResolved, resolver } = harness(() => Promise.resolve(DECISION));

  resolver.resolve("s1", "ACCEPT");
  await flush();
  expect(onResolved).toHaveBeenCalledWith("s1", DECISION);

  // Recorded ⇒ the key is spent. Re-posting `id-1` for a *later* press would be answered by §4.13's
  // hoisted repeat — the first `Decision`, unchanged — instead of resolving what the user just asked.
  resolver.resolve("s1", "DISMISS");
  await flush();
  expect(idsPosted(post)).toEqual(["id-1", "id-2"]);
});

test("a failure keeps the key and reports it — T29's notice needs the error and the Retry needs the id", async () => {
  const error = new ApiError("network", 0, "Could not reach the API");
  const { post, onResolved, onFailed, resolver } = harness(() => Promise.reject(error));

  resolver.resolve("s1", "ACCEPT");
  await flush();

  expect(onFailed).toHaveBeenCalledWith("s1", error);
  expect(onResolved).not.toHaveBeenCalled();

  // The whole of §2.2: the retry re-issues **the same** `decision_id`, so an interrupted commit that
  // the server did record is answered with the first `Decision` rather than resolving a second time.
  resolver.retry("s1");
  await flush();
  expect(idsPosted(post)).toEqual(["id-1", "id-1"]);
});

test("a retry that succeeds reports the Decision and spends the key", async () => {
  const error = new ApiError("internal_error", 500, "boom");
  let attempt = 0;
  const { onResolved, onFailed, resolver } = harness(() => {
    attempt += 1;
    return attempt === 1 ? Promise.reject(error) : Promise.resolve(DECISION);
  });

  resolver.resolve("s1", "ACCEPT");
  await flush();
  expect(onFailed).toHaveBeenCalledTimes(1);

  resolver.retry("s1");
  await flush();
  expect(onResolved).toHaveBeenCalledWith("s1", DECISION);
  // Reported once each, in order — a retry is the same decision, not a second one.
  expect(onFailed).toHaveBeenCalledTimes(1);
  expect(onResolved).toHaveBeenCalledTimes(1);
});

test("a retry with nothing pending is a no-op — a decision that committed is not re-postable", async () => {
  const { post, resolver } = harness(() => Promise.resolve(DECISION));

  resolver.resolve("s1", "ACCEPT");
  await flush();

  resolver.retry("s1");
  resolver.retry("never-started");
  await flush();

  expect(post).toHaveBeenCalledTimes(1);
});

test("one decision, one outcome — a twin's late failure after the commit is not a failure (§4.3)", async () => {
  // The raced swipe + tap post the same key twice; if one twin's response is lost, reporting it would
  // show a Retry for a decision already recorded — a notice the server would answer 200 to. The
  // *decision* resolved, so no failure is reported for that spark.
  const second = deferred();
  let call = 0;
  const { onResolved, onFailed, resolver } = harness(() => {
    call += 1;
    return call === 1 ? Promise.resolve(DECISION) : second.promise;
  });

  resolver.resolve("s1", "ACCEPT");
  resolver.resolve("s1", "ACCEPT");
  await flush();
  expect(onResolved).toHaveBeenCalledTimes(1);

  second.fail(new ApiError("network", 0, "dropped"));
  await flush();
  expect(onFailed).not.toHaveBeenCalled();
});

test("a `null` post is not a resolution — nothing is reported and nothing is kept (§4.14's INSPIRED)", async () => {
  // `postDecision` answers `null` for the one kind that is not a resolution (§4.14 writes no `decision`
  // row). Neither callback fires: there is no `Decision` to re-read for and no failed commit to retry.
  const { onResolved, onFailed, resolver } = harness(() => Promise.resolve(null));

  resolver.resolve("s1", "INSPIRED");
  await flush();

  expect(onResolved).not.toHaveBeenCalled();
  expect(onFailed).not.toHaveBeenCalled();
});

test("the resolver holds no id across sparks or across outcomes — every key is minted or reused, never invented", async () => {
  // The non-vacuity of `newId`: over the whole flow the module mints exactly as many ids as there were
  // *decisions*, and the ids in the log are a subset of the ids it minted — so a test that pins reuse
  // cannot pass by the module never calling `newId` at all.
  const error = new ApiError("network", 0, "dropped");
  const minted: string[] = [];
  const post = vi.fn((spark: string, id: string, kind: ResolutionKind) => {
    void spark;
    void id;
    void kind;
    return Promise.reject(error);
  });
  let next = 0;
  const resolver = createDecisionResolver({
    post,
    onResolved: vi.fn(),
    onFailed: vi.fn(),
    newId: () => {
      const id = `id-${++next}`;
      minted.push(id);
      return id;
    },
  });

  resolver.resolve("s1", "ACCEPT");
  resolver.retry("s1");
  resolver.retry("s1");
  resolver.resolve("s2", "ACCEPT");
  await flush();

  expect(minted).toEqual(["id-1", "id-2"]);
  for (const id of idsPosted(post)) expect(minted).toContain(id);
});
