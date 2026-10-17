/**
 * Why a run failed, in the vocabulary the engine writes, the vault reports and the app renders
 * (`FLOW.md` §4.1, §5.6; `ARCHITECTURE.md` §4.3, §5; L3 · #166, T4).
 *
 * **E4 has a cause, and one vocabulary carries it end to end.** v1's E4 was one bit — *the last run
 * failed* — so the surface could only say "Unavailable". §4.3 gives the app a first-run arm (*"Add your
 * AI key…"*), and the ladder's own `E4` must render *something* specific when the reason is a 429 or an
 * offline device. The three lanes that touch it do not share a module — the provider classifies, the
 * engine's run lifecycle writes the row, the vault reads it, the app prints it — so the vocabulary has
 * to be shared *below* all of them and reachable from `core/src/vault/**` without crossing NFR-A1's
 * `vault → provider` edge. This module is that floor: portable, dependency-free, key-free.
 *
 * **How it travels: a tag on the row's `error` text.** `spark_run.error` is `TEXT` (the store's
 * schema), so the cause rides it as a stable prefix — `failure:no-key: …` — rather than as a new
 * column: no migration, and a v1 row without a tag simply parses as "unknown", which is what it is.
 * `failureTag` writes it, `parseRunFailure` reads it back, and both are here so the two halves cannot
 * drift.
 */
export type RunFailureCause =
  /** No key is set — the call was never made (§4.3's *"Add your AI key…"* arm). */
  | "no-key"
  /** The provider rejected the key (HTTP 401/403). */
  | "invalid-key"
  /** The transport failed before any response: no connectivity, DNS, or a blocked origin. **On the
   * web a CORS block and an offline device are the same `fetch` rejection** — the transport's `surface`
   * decides which of the two the user is told, see `provider/failure.ts`. */
  | "offline"
  /** The request was aborted by our own timeout. */
  | "timeout"
  /** HTTP 429. */
  | "rate-limited"
  /** The browser refused the call: the provider has no direct-browser path (web only). */
  | "cors-blocked"
  /** The provider answered, but not in the agreed shape — nothing is stored (§5). */
  | "invalid-output"
  /** Anything else: a 5xx, an unknown status, a failure that carried no information. */
  | "unavailable";

/** Every cause, in one list — the parser validates against it, so a typo cannot enter the wild. */
export const RUN_FAILURE_CAUSES: readonly RunFailureCause[] = [
  "no-key",
  "invalid-key",
  "offline",
  "timeout",
  "rate-limited",
  "cors-blocked",
  "invalid-output",
  "unavailable",
];

/** The tag's prefix. Stable: it is written into rows that outlive the process that wrote them. */
export const FAILURE_TAG = "failure:";

/** `failure:no-key` — the machine-readable head of a failed run's `error` text. */
export function failureTag(cause: RunFailureCause): string {
  return `${FAILURE_TAG}${cause}`;
}

/**
 * The cause a run's `error` text names, or `null` when it names none (a v1 row, a discarded run's
 * informational note, a plain thrown message). Never guesses: an unknown tag is `null`, not
 * `"unavailable"` — a reader can then tell "we do not know why" from "we know it was not specific".
 */
export function parseRunFailure(error: string | null): RunFailureCause | null {
  if (error === null || !error.startsWith(FAILURE_TAG)) return null;
  const cause = error.slice(FAILURE_TAG.length).split(/[:\s]/, 1)[0];
  return RUN_FAILURE_CAUSES.find((known) => known === cause) ?? null;
}
