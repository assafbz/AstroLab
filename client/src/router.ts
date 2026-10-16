import { useEffect, useState } from "react";

/**
 * The client shell's routing (V7). The screens are `FLOW.md` §2.1's S0–S6; the paths are the
 * shell's own and are recorded in `client/README.md`.
 *
 * `#/` is the home and lands on **S1 (Sparks)** — "the home is a deck. It opens on 'Sparks' …
 * not on the user's notes" (`DESIGN.md` §5). S0 is the *first-run entry*, reached before home
 * (`FLOW.md` §4.2 T01/T05), so it carries its own path (`/onboarding`) rather than the root.
 *
 * Hash routing, not history routing: the PWA is served as static files, so a path the host does
 * not know would 404 on reload. `#/sparks` reloads on every host.
 */
export type ScreenId = "S0" | "S1" | "S2" | "S3" | "S4" | "S5" | "S6";

export interface Screen {
  id: ScreenId;
  path: string;
  title: string;
}

export const SCREENS: readonly Screen[] = [
  { id: "S0", path: "/onboarding", title: "Onboarding" },
  { id: "S1", path: "/", title: "Sparks" },
  { id: "S2", path: "/capture", title: "Capture" },
  { id: "S3", path: "/vault", title: "Vault" },
  { id: "S4", path: "/ideas", title: "Idea detail" },
  { id: "S5", path: "/fork", title: "Fork" },
  { id: "S6", path: "/iterate", title: "Iterate" },
];

function screen(id: ScreenId): Screen {
  const found = SCREENS.find((s) => s.id === id);
  if (!found) throw new Error(`unknown screen ${id}`);
  return found;
}

/** Bottom-nav destinations (DESIGN.md §4): Sparks · Vault · Add. */
export const TABS: readonly Screen[] = [screen("S1"), screen("S3"), screen("S2")];

/** The hash for a screen, e.g. `#/` (home) or `#/vault`. */
export function routeHref(target: Screen): string {
  return `#${target.path}`;
}

/**
 * The screen for a hash path; `undefined` is the shell's not-found. A trailing slash resolves, so
 * a pasted `#/vault/` is not a not-found; the bare hash normalises to `/`, which is S1 (home).
 */
export function matchScreen(hashPath: string): Screen | undefined {
  const path = hashPath.replace(/\/+$/, "") || "/";
  return SCREENS.find((s) => s.path === path);
}

/** The current hash path (e.g. `/vault`); `""` on the bare URL (which is the home). */
export function useHashPath(): string {
  const [path, setPath] = useState(() => window.location.hash.slice(1));
  useEffect(() => {
    const onHashChange = () => setPath(window.location.hash.slice(1));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return path;
}

/** The S4 detail route's hash for one idea (`#/ideas/<id>`). Ids are opaque — never encoded here. */
export function ideaHref(id: string): string {
  return `#/ideas/${id}`;
}

/**
 * The id in an `#/ideas/<id>` path, or `null` when the path is not a per-id route. A trailing slash
 * resolves, so a pasted `#/ideas/abc/` is not a not-found — the same courtesy `matchScreen` extends
 * to `#/vault/`. An empty id or a further `/` does not: `/ideas/a/b` is not a route. The server
 * agrees (`docs/API.md` §6 — it answers the `not_found` envelope), and the two must not be "fixed"
 * into disagreement.
 */
export function ideaIdFromPath(path: string): string | null {
  const match = /^\/ideas\/([^/]+)$/.exec(path.replace(/\/+$/, ""));
  return match ? match[1]! : null;
}

/** The S1b detail route's hash for one spark (`#/sparks/<id>`). Ids are opaque — never encoded here. */
export function sparkHref(id: string): string {
  return `#/sparks/${id}`;
}

/**
 * The **seeded S2** route's hash for one spark (`#/capture/<id>`, T09). The id is the spark Capture
 * prefills from (§4.14); the route carries it so a reload and a deep link render the same seeded form,
 * exactly as `#/sparks/<id>` renders S1b from its own read. Ids are opaque — never encoded here.
 */
export function captureHref(id: string): string {
  return `#/capture/${id}`;
}

/**
 * The id in an `#/sparks/<id>` path, or `null` when the path is not a per-id route — the same
 * contract as `ideaIdFromPath`, for the same reason: S1b is not an entry in `SCREENS` (S1 lives at
 * `/`), so `matchScreen` alone would call it a not-found, and the shell must resolve the id *before*
 * it matches. A trailing slash still resolves.
 *
 * **A bare `/sparks` is not a route.** `/sparks` is unclaimed by `SCREENS` and stays a not-found
 * rather than quietly aliasing the deck, so a path outside the route table keeps meaning exactly that.
 */
export function sparkIdFromPath(path: string): string | null {
  const match = /^\/sparks\/([^/]+)$/.exec(path.replace(/\/+$/, ""));
  return match ? match[1]! : null;
}

/**
 * The spark id in a `#/capture/<id>` path, or `null` when the path is not that per-id route — the same
 * contract as `ideaIdFromPath` / `sparkIdFromPath`, for the same reason: the **seeded** S2 is not an
 * entry in `SCREENS` (`SCREENS`'s S2 entry is the bare `/capture`), so the shell must resolve the id
 * *before* it matches. A trailing slash still resolves.
 *
 * **A bare `/capture` is not this route**: it is `SCREENS`' own blank capture and is matched as S2, so
 * the seeded path needs an id — a path with nothing after the slash is the blank form, not a seed of
 * nothing.
 */
export function seedSparkIdFromPath(path: string): string | null {
  const match = /^\/capture\/([^/]+)$/.exec(path.replace(/\/+$/, ""));
  return match ? match[1]! : null;
}
