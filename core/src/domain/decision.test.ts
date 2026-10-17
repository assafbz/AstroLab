import { expect, test, vi } from "vitest";

import type { Decision } from "../types.js";
import type { ResolutionKind } from "./deck-interaction.js";
import {
  createDecisionResolver,
  isRetryable,
  type ResolutionError,
  type ResolutionErrorCode,
} from "./decision.js";

/** The failure shape the resolver reports — §2's codes; the resolver reads only `code`. */
const failure = (code: ResolutionErrorCode): ResolutionError => ({ code });

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
 * A `post` whose outcome each call chooses, and whose arguments the test reads back. The call log is the
 * evidence: the module's whole job is *which* `decision_id` reaches the wire, and *how many* requests
 * carry it — the seam itself is `void`, so nothing here asserts on a return value.
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

/** The `decision_id` each post carried, in call order. */
function idsPosted(post: ReturnType<typeof vi.fn>): string[] {
  return post.mock.calls.map((call) => call[1] as string);
}

test("a press while a request is out is coalesced — one send, and the first kind wins (§4.3, §5.5)", async () => {
  // §4.3's raced swipe + tap: both reach the seam (§5.5 pins that they do), and they are **one**
  // decision. The key is held per spark, and the module does not send a second request while the first
  // is out — the in-flight one already carries the outcome. The kinds differ here on purpose: the
  // decision is the *spark's*, and a disagreement between the two calls is out of spec (§5.5's parity
  // says they are the same command), so the first kind stands.
  const { post, resolver } = harness(() => Promise.resolve(DECISION));

  resolver.resolve("s1", "ACCEPT");
  resolver.resolve("s1", "DISMISS");
  await flush();

  expect(post).toHaveBeenCalledTimes(1);
  expect(post.mock.calls[0]).toEqual(["s1", "id-1", "ACCEPT"]);
});

test("the coalesced pair reports one failure, never two — one decision, one outcome (§4.3)", async () => {
  const error = failure("network");
  const { post, onResolved, onFailed, resolver } = harness(() => Promise.reject(error));

  resolver.resolve("s1", "ACCEPT");
  resolver.resolve("s1", "ACCEPT");
  await flush();

  expect(post).toHaveBeenCalledTimes(1);
  expect(onFailed).toHaveBeenCalledTimes(1);
  expect(onFailed).toHaveBeenCalledWith("s1", error);
  expect(onResolved).not.toHaveBeenCalled();
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

test("a success ends the decision — nothing re-issues the key, so no failure can follow one (F)", async () => {
  // The ordering invariant's forbidden case: a failure emitted **after** a success for the same id.
  // It cannot arise here because the success removes the record before it is reported — so a later
  // retry has nothing to re-issue. The stub fails every send *after* the first, so an implementation
  // that kept the record on success would re-send and report a failure for a decision already recorded.
  let call = 0;
  const { post, onFailed, resolver } = harness(() => {
    call += 1;
    return call === 1 ? Promise.resolve(DECISION) : Promise.reject(failure("internal_error"));
  });

  resolver.resolve("s1", "ACCEPT");
  await flush();
  resolver.retry("s1");
  await flush();

  expect(post).toHaveBeenCalledTimes(1);
  expect(onFailed).not.toHaveBeenCalled();
});

test("a failure keeps the key and reports it — T29's notice needs the error, the Retry needs the id", async () => {
  const error = failure("network");
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

test("a press after a failure is the same decision too — the same key, with the user's latest kind", async () => {
  const error = failure("internal_error");
  const { post, resolver } = harness(() => Promise.reject(error));

  resolver.resolve("s1", "ACCEPT");
  await flush();
  // Not a Retry, and not a second decision: the failed attempt never committed, so the record is still
  // live and the press re-issues it — with the kind the user last chose.
  resolver.resolve("s1", "DISMISS");
  await flush();

  expect(post.mock.calls).toEqual([
    ["s1", "id-1", "ACCEPT"],
    ["s1", "id-1", "DISMISS"],
  ]);
});

test("a retry that succeeds reports the Decision, once each — a retry is the same decision", async () => {
  const error = failure("internal_error");
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
  // Failure then success is legal (a lost response, recovered by Retry); a success then failure is not,
  // and is covered above. Each is reported once.
  expect(onResolved).toHaveBeenCalledWith("s1", DECISION);
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

test("a retry while a request is out is coalesced too — the in-flight request carries the outcome", async () => {
  const error = failure("network");
  const { post, resolver } = harness(() => Promise.reject(error));

  resolver.resolve("s1", "ACCEPT");
  resolver.retry("s1");
  await flush();

  expect(post).toHaveBeenCalledTimes(1);
});

test("a `null` post is not a resolution — nothing is reported and nothing is kept (§4.14's INSPIRED)", async () => {
  // `postDecision` answers `null` for the one kind that is not a resolution (§4.14 writes no `decision`
  // row). Neither callback fires, and no record is kept: there is no `Decision` to re-read for and no
  // failed commit to retry.
  const { post, onResolved, onFailed, resolver } = harness(() => Promise.resolve(null));

  resolver.resolve("s1", "INSPIRED");
  await flush();
  expect(onResolved).not.toHaveBeenCalled();
  expect(onFailed).not.toHaveBeenCalled();

  // Nothing kept: a later press is a fresh decision, minting a fresh key.
  resolver.resolve("s1", "ACCEPT");
  await flush();
  expect(idsPosted(post)).toEqual(["id-1", "id-2"]);
});

test("only a failure that can differ on a second try is retryable — a `409` is a statement, not a blip", () => {
  // T29's surface is Retry, and Retry re-issues the *same* request. A `409` says the spark is not
  // `OFFERED`; a `not_found` says the id is unknown; `validation_failed`/`unauthorized` say the request
  // or the token is wrong. Re-issuing any of them draws the same answer, so none may offer Retry.
  expect(isRetryable(failure("network"))).toBe(true);
  expect(isRetryable(failure("internal_error"))).toBe(true);

  expect(isRetryable(failure("conflict"))).toBe(false);
  expect(isRetryable(failure("not_found"))).toBe(false);
  expect(isRetryable(failure("validation_failed"))).toBe(false);
  expect(isRetryable(failure("unauthorized"))).toBe(false);
});

test("the resolver mints one key per decision and invents none — the ids on the wire are the ids it minted", async () => {
  // Non-vacuity for `newId`: over a flow with two decisions the module mints exactly two keys, and every
  // key it sends is one it minted. A test pinning reuse therefore cannot pass by the module never
  // minting at all.
  const error = failure("network");
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
  await flush();
  resolver.retry("s1");
  await flush();
  resolver.resolve("s2", "ACCEPT");
  await flush();

  expect(minted).toEqual(["id-1", "id-2"]);
  expect(idsPosted(post)).toEqual(["id-1", "id-1", "id-2"]);
  for (const id of idsPosted(post)) expect(minted).toContain(id);
});
