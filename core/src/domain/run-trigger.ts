/**
 * The cold-start run trigger's **single-flight** rule (`FLOW.md` §4.2 T04; `docs/API.md` §4.16).
 *
 * T04's side effect is *kick engine run*, and the `See your sparks` CTA is the only exit that carries
 * it — `Skip` (T03) has none, so the run belongs to the exit the user chose, not to S1's mount. This
 * module owns the one client-side rule that side effect needs and nothing else: **a press while its own
 * POST is still in flight is ignored**, so a rapid double-press cannot enqueue two runs.
 *
 * Why a guard at all, when §4.16 is "idempotent per revision": the dedup is per **`PENDING`** run at a
 * revision (`core/src/store/runs.ts`), and a second POST while a run at that stamp is already `RUNNING`
 * inserts a second row. Re-running one revision is sanctioned (`ARCHITECTURE.md` §4) — the cost is a
 * duplicated run, never a wrong deck — so the client carries this guard rather than a server change. A
 * revision-keyed guard is not available to the client: no read it may call *before firing* returns
 * `vault_revision`, and `VaultSummary` carries none.
 *
 * What never enters: a persisted "we just fired one" flag, or any S1 render — S1 reads the engine
 * state from the server (§4.10), never from this. The guard is process-local and press-scoped.
 *
 * Pure: no request, no React. The caller supplies `enqueue`; the screen renders, the rule stays here.
 */

/** The POST the trigger fires — `enqueueRun` in the screen; any promise in a test. */
export type EnqueueRun = () => Promise<unknown>;

export interface RunTrigger {
  /**
   * Start a run unless a prior POST is still in flight. Returns whether **this** call sent one, so the
   * caller (and the test) can tell a real fire from an ignored press.
   */
  fire(): boolean;
}

/**
 * A press-scoped, single-flight trigger over `enqueue`. Fire-and-forget: `fire` starts the POST and
 * returns without awaiting it (NFR-P1 — nobody waits on the engine).
 *
 * A failed POST is **dropped, not surfaced**: leaving S0 hands the user to S1, which reports the engine
 * truth from `GET /v1/sparks/state` — a run that never enqueued shows there as E0/E2 and is recoverable
 * (Recompute, K2). S0 has no error surface for this, and inventing one is out of O5's fence.
 */
export function createRunTrigger(enqueue: EnqueueRun): RunTrigger {
  let inFlight = false;

  return {
    fire(): boolean {
      if (inFlight) return false;
      inFlight = true;
      // `catch` resets the guard on failure too: `.finally` alone would also reset, but would leave the
      // rejection unhandled (the promise is never awaited). Swallowing here is the documented drop.
      void enqueue()
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
      return true;
    },
  };
}
