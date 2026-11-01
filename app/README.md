# `app/` — the AstroLab Expo app

The composition root. One Expo (React Native) codebase → iOS + Android store builds, plus web via
`react-native-web`. It holds **no** business logic: every rule it runs is a `core` function, reached
through the one import surface (`@astrolab/core`). The app is native-first; web is a constrained
second target (`docs/ARCHITECTURE.md` v2 §1, ADR-0006).

```sh
npm ci                        # from the repo root — npm workspaces: core, app
npm run typecheck -w app      # tsc over the app
npm test -w app               # vitest
npm run build -w app          # expo export --platform web --output-dir dist  (static web bundle)
```

`app` resolves `@astrolab/core` → **`core/dist`**, so `core` must be built before the app bundles.
The root `npm run build` does that in workspace order (`core`, then `app`).

## Running it

### Web

The web target **requires a cross-origin-isolated page**. `expo-sqlite`'s web build runs SQLite in a
worker against an OPFS-backed VFS and uses `SharedArrayBuffer` for its sync calls, so the page must be
served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`.
Without them the page is not isolated, `SharedArrayBuffer` is undefined, and the vault cannot open.

```sh
npm run build                          # root: builds core → app, so app/dist is current
node scripts/serve-web.mjs             # serves app/dist on http://127.0.0.1:8090 with the two headers
```

Open `http://127.0.0.1:8090/`. A working build renders **S0** — the heading `S0`, the word `Astrolab`,
and *"Add a few ideas across unrelated domains to see sparks."* `crossOriginIsolated` reads `true` in
the console. `node scripts/serve-web.mjs <dir> <port>` serves any other build output.

### Device / emulator

```sh
npm run start                          # expo start — scan the QR with Expo Go, or press i / a for a simulator
```

This needs a device or a simulator. **It has not been run from the build box** — there is no emulator
there (no `/dev/kvm`, no `adb`, no Android SDK), so the native row is a manual sign-off, recorded as
*unrun with that cause* rather than claimed (#165).

## Where cross-origin isolation comes from, per artefact

An exported web bundle is plain static files, and **no Expo config can put response headers on it** —
headers belong to whatever serves the build. That is why this repo ships its run host instead of leaving
the requirement in a scratch directory.

| artefact | host | cross-origin isolated |
| :-- | :-- | :-- |
| **`app/dist`** — the static export this lane's S0/S1 run serves | `scripts/serve-web.mjs`, or any static host that sends `COOP: same-origin` + `COEP: credentialless` | **yes** — measured `crossOriginIsolated === true`, the vault opens, S0 renders |
| **`npx expo start --web`** — the Metro dev server | the dev server itself | **no, and it cannot be** on Expo SDK 58 — see below |
| **a shipped web build** | **undecided** | n/a — picking the host is an owner-level call, still open |

### Why the dev server is not cross-origin isolated

The vendor skill (`expo-sqlite`'s `references/web-and-config.md`) prescribes adding the two headers from
`config.server.enhanceMiddleware`. **On SDK 58 that hook cannot reach the page.** The dev server serves
the HTML document from `ManifestMiddleware`, and `MetroBundlerDevServer` *prepends* that handler to the
front of the middleware stack, ahead of everything `enhanceMiddleware` wraps:

```
$ curl -sD - -o /dev/null http://127.0.0.1:8081/ | head -3
HTTP/1.1 200 OK
Content-Type: text/html                      ← the document: no COOP/COEP
$ curl -sD - -o /dev/null 'http://127.0.0.1:8081/app/index.bundle?platform=web&dev=true' | grep -i cross-origin
Cross-Origin-Embedder-Policy: credentialless ← the bundle: headers present, and irrelevant
Cross-Origin-Opener-Policy: same-origin
```

Isolation is decided by the **document**, so the bundle's headers do not help: the page still reports
`crossOriginIsolated === false` and dies at import with `SharedArrayBuffer is not defined`. Source:
`node_modules/@expo/cli/build/src/start/server/metro/MetroBundlerDevServer.js` — `prependMiddleware(
middleware, manifestMiddleware.getHandler())` (the helper is `stack.unshift`, in
`.../middleware/mutations.js`). The config therefore sets **no** such middleware; a middleware that
cannot deliver the isolation reads as if it works. `app/metro.config.js` carries the same note.

**Consequence, plainly:** `expo start --web` is not a runnable web target today. Use the build + serve
path above — one `npm run build` is the whole loop. A reverse proxy that adds the two headers in front of
`expo start --web`, or an SDK whose dev server serves the document through Metro's stack, would each make
it one again; neither is in place here.

## Reference

| Doc | Why |
| :-- | :-- |
| `docs/ARCHITECTURE.md` v2 | The technical design the app composes — §1 (the client), §4 (the read paths) |
| `DESIGN.md` | The Nightfall design system the screens bind to |
| `docs/FLOW.md` | The user journey and state machine (the screens this shell frames) |
| `../AGENTS.md` | Repo rules for agent work — skills, review, PR flow |
