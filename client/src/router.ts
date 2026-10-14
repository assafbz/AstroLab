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
