/**
 * The AI-provider boundary (`ARCHITECTURE.md` §5; `ADR-0003`).
 *
 * **One interface, no vendor.** The engine depends on these two operations — Stage 1's extraction and
 * Stage 2's adjudication — and a single adapter implements both. The boundary is a *module*: nothing in
 * `api/` or `store/` may import it, which is what makes NFR-A1 hold by construction rather than by
 * discipline (`store` and `api` have no reachable path to a provider at all).
 * `worker/src/provider/boundary.test.ts` fails the suite if such an import appears.
 *
 * W4's tag normalisation (`§3.2` step 2) is a **third** operation on this same adapter; it is not built
 * here because §5's interface list and #27's Done list both name exactly these two.
 */

/**
 * The idea text an operation may send — and nothing else (§5: *"only the operation's payload"*). No
 * account identity, no vault listing, no unrelated ideas; `domain_tags` is absent because mechanism
 * extraction is about structure, not classification.
 */
export interface IdeaText {
  hypothesis: string;
  problem: string;
  monetization: string;
}

/**
 * Stage 1's normalised descriptor (`ARCHITECTURE.md` §3.3 step 1). Internal — never surfaced
 * (`PRD.md` §3.3 items 2–4). The field set is **confirmed by the W9 calibration run** (§12.2), so these
 * are §3.3's four names, not a settled schema.
 */
export interface MechanismDescriptor {
  verb: string;
  object_class: string;
  constraint: string;
  transferable_structure: string;
}

/** Both sides of a gated pair, so Stage 2 compares two descriptors (`§3.3` step 2 → step 3). */
export interface MechanismPair {
  a: MechanismDescriptor;
  b: MechanismDescriptor;
}

/**
 * Stage 2's draft (`ARCHITECTURE.md` §2.3, §3.3 step 3). `mechanism` is the shared mechanism the call
 * confirms — **internal, never surfaced** (`§2.3`), but it is what the `spark.mechanism` column stores,
 * so it travels with the draft rather than being re-derived later.
 */
export interface SparkDraft {
  mechanism: string;
  direction: string;
  claim: string;
  what_it_takes: string;
  first_step: string;
}

/** Stage 1 (`§3.3` step 1): one call per idea, cached by W3. */
export interface MechanismExtractor {
  extract(idea: IdeaText): Promise<MechanismDescriptor>;
}

/**
 * Stage 2 (`§3.3` step 3): one call per **gated** pair. `null` is a real answer — the model found no
 * shared mechanism — and is **not** an error; the pair becomes suppressed noise (W6/W7). Conflating it
 * with a failure would suppress a pair for the wrong reason.
 */
export interface SparkAdjudicator {
  adjudicate(
    ideaA: IdeaText,
    ideaB: IdeaText,
    mechanisms: MechanismPair,
  ): Promise<SparkDraft | null>;
}

/** `ARCHITECTURE.md` §5: *"a single adapter implements both"*. */
export type Provider = MechanismExtractor & SparkAdjudicator;

/**
 * The provider failed — an error response, a transport rejection, or a timeout. §4's matrix maps this to
 * a **failed call**: W1's `runOnce` marks the run `FAILED`, and the vault is untouched (NFR-A1).
 */
export class ProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderError";
  }
}

/**
 * The provider answered, but not in the shape the contract agreed (§5: *"invalid output = a failed
 * call"*, never stored). Kept distinct from `ProviderError` because it means something different
 * operationally — the boundary worked, the model's output did not — even though §4 treats both as a
 * failed call. Nothing is ever returned from an invalid response: not `undefined`, not a partial object.
 */
export class InvalidOutputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InvalidOutputError";
  }
}
