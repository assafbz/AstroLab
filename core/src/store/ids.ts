/**
 * The **id source** — a port on the same seam as `SqliteConnection` and the `KeyStore`
 * (plan invariant 4): `core/` mints every id it writes through here, and the composition root
 * (`app/`) installs the implementation its platform can actually run.
 *
 * ## Why this is a port and not `node:crypto`
 *
 * `randomUUID` was imported from `node:crypto` in four writers (`store/runs.ts` · `store/sparks.ts` ·
 * `vault/capture.ts` · `vault/fork.ts`) and dereferenced as the bare global in a fifth
 * (`domain/decision.ts`). Metro resolves `node:crypto` to an empty module, so on device and web
 * **every vault write threw** — a failure the whole suite passes through, because CI runs on Node,
 * where all five work (issue #184).
 *
 * ## The default is lazy, and its failure is named
 *
 * `globalThis.crypto` is the standard global: Node ≥19 has it, so does every browser. React Native's
 * Hermes **does not** — so a default that derefs it eagerly, or that fails as `TypeError: Cannot read
 * properties of undefined`, is the same defect wearing a Node-green coat. The default therefore reads
 * the global **at call time** and, when it is missing, throws one named error that says what to
 * install and where. `app/` installs `expo-crypto`'s `randomUUID` once, at boot, with
 * {@link setIdSource}.
 *
 * The default is honest about being a **default**: on Node and on web it is the right source and
 * nothing needs to be installed. `core/test/ids.test.ts` pins both halves — a write through an
 * installed source, and the named error when there is none.
 */
export interface IdSource {
  /** One fresh id. `core/` never inspects the format; any unique string is a legal answer. */
  newId(): string;
}

/** The message a missing global throws. One place, so the test can assert it and the app can read it. */
export const NO_ID_SOURCE =
  "no id source installed: globalThis.crypto.randomUUID is unavailable — React Native's Hermes has " +
  "no Web Crypto. Install one at the composition root: setIdSource({ newId }) with expo-crypto's " +
  "randomUUID.";

/** `globalThis.crypto.randomUUID`, read at call time and refused by name when the platform lacks it. */
export const globalIdSource: IdSource = {
  newId(): string {
    const webCrypto = globalThis.crypto;
    if (typeof webCrypto?.randomUUID !== "function") throw new Error(NO_ID_SOURCE);
    return webCrypto.randomUUID();
  },
};

/**
 * Process-wide, because that is the shape of the seam: one process, one vault, one boot
 * (`ARCHITECTURE.md` §2 — "one process ⇒ writes serialized by construction"). The composition root
 * installs the platform's source before the first write; `core/test/ids.test.ts` restores
 * {@link globalIdSource} after each case.
 */
let installed: IdSource = globalIdSource;

/** Install the platform's id source. Called by the composition root (`app/src/bootstrap.ts`). */
export function setIdSource(source: IdSource): void {
  installed = source;
}

/** One id, from whichever source is installed — the standard global unless the app replaced it. */
export function newId(): string {
  return installed.newId();
}
