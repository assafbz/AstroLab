# Client shell (V7)

The mobile-first PWA shell. Screens S2/S3/S4 are **not** built here — this is the harness they land
in.

- **Stack:** Vite + React + TypeScript (`docs/adr/0005-client-stack.md`).
- **Design tokens:** `src/styles/tokens.css`, lifted from `DESIGN.md` §2 (colour) and §5 (geometry).
  Brass is the only accent.
- **Layout:** 16px gutters, grown to the device safe area; `viewport-fit=cover` is set in
  `index.html`, and the tab bar pads the bottom inset.

## Routes

Hash routing (`#/vault`), not history routing: the PWA is served as static files, so a path the
host does not know would 404 on reload. One path per screen; the `FLOW.md` §2.1 screen ids are the
labels.

| Screen | Path | Status |
| :--- | :--- | :--- |
| S0 Onboarding | `#/onboarding` | placeholder |
| S1 Sparks (home) | `#/` | placeholder |
| S2 Capture | `#/capture` | placeholder |
| S3 Vault | `#/vault` | placeholder |
| S4 Idea detail | `#/ideas` | placeholder |
| S5 Fork | `#/fork` | placeholder |
| S6 Iterate | `#/iterate` | placeholder |

### The entry rule — where `/` goes

`#/` (and the bare URL) is the **home**, and the home is **S1 Sparks**: *"The home is a deck. It
opens on **"Sparks"** — one proposed idea at a time — **not** on the user's notes."* (`DESIGN.md`
§5). S0 is the **first-run entry**, not the home: `FLOW.md` §4.2 **T01** sends a first launch to
S0, and **T05** sends a return launch straight to S1. S0 therefore carries its own path
(`#/onboarding`), not the root.

The shell has no vault state, so it cannot make the T01/T05 choice itself — the **state-dependent
entry is V8** (`FLOW.md` §4.1 E0–E4). The shell's `/` is simply the home.

A trailing slash resolves (`#/vault/` is not a not-found). An unknown path lands on the shell's
own **not-found fallback** — the tab bar stays, the body reads "Not found" — never a blank screen.

### Deferred

S1b (Spark Detail) is not in S0–S6, so it has no route yet; it and the per-id paths (`/ideas/:id`)
land with V8.
