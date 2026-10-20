import { NoKeyError } from "./types.js";

/**
 * The user's API key, read through a port (`ARCHITECTURE.md` §5, §11 PRIV1; L3 · #166, invariant 4).
 *
 * **The key belongs to the user, and this module is the only place `core/` reads it.** v1 kept a
 * server-side key in `OPENROUTER_API_KEY` and resolved it at boot; the rebuild has no server and no
 * env, so the key is read from a `KeyStore` the **app** supplies — `expo-secure-store` on device,
 * session memory on web (a browser store is XSS-readable, David's §12 item-13 ruling). `core/` never
 * imports `expo-*`; `core/src/provider/key.test.ts` fails the suite if it does.
 *
 * The port is **async** because both real adapters are (a secure-store read is a native call), and
 * because a key can change under a live process — the read happens **per request**
 * (`openrouter.ts`'s transport), not at construction, so a key added or rotated mid-session is picked
 * up without rebuilding the adapter.
 *
 * A missing or blank key is `NoKeyError`, never an unauthenticated request: `readKey` throws before
 * anything reaches the network, and §4 maps that to E4's *"Add your AI key…"* arm.
 */
export interface KeyStore {
  /** The key as the user stored it, or `null` when none is set. */
  get(): Promise<string | null>;
  /** Store it (device: the OS secure store; web: this session only). */
  set(key: string): Promise<void>;
  /** Forget it. */
  clear(): Promise<void>;
}

/**
 * Trim, and treat blank as absent: a whitespace-only secure-store value is a user who cleared the
 * field, not a key. Exported so the adapters share one definition of "set".
 */
export function normalizeKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
}

/** The key, or `NoKeyError`. The one read site — and the only value the adapter ever hands on. */
export async function readKey(store: KeyStore): Promise<string> {
  const key = normalizeKey(await store.get());
  if (key === null) {
    throw new NoKeyError(
      "no API key is set: the app must supply one before a run can reach a model",
    );
  }
  return key;
}
