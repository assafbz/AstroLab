# DEPLOY — client serving & the access boundary

> **Deliverable:** consult item 2 — *"client serving and the token exposure"* — opened by David on the
> `astrolab` deploy thread, 2026-10-16 22:17Z. **Author:** Eli. **Reviewer:** Max (with the host-layer
> artifact). **Status:** position paper for the deploy consult. Companion: the host layer (proxy config,
> Dockerfile, compose, backup timer) is Ari's; this document states what that layer must *serve* and
> what must stand *in front of* it. No host is touched before the owner's call.

This fixes two things: **how the built client is served** (§2), and **what the exposure of the bearer
token actually is, and the options for gating it** (§3–§5). It does not choose where it runs, the
hostname, or TLS — those are the host layer and the owner.

---

## 1. What the client already is — the facts the serving shape must fit

| fact | source | why it binds the serving shape |
| :-- | :-- | :-- |
| The client is a **static bundle**: `index.html` + hashed `assets/*.js` + `assets/*.css` + `icon.svg` + `manifest.webmanifest` | built at `ece5e6f` (§6 evidence) | the host serves files; there is no client runtime server |
| Every API call is **origin-relative** — `fetch("/v1/…")`, no base URL, no `VITE_API_URL` | `client/src/api/*.ts` | **one origin is a hard requirement today**; a second origin is a code change, not a config value |
| Assets are referenced **root-absolute** (`/assets/index-…js`), `base` is `/` | `client/dist/index.html` (§6) | the client must be served at the origin **root**, never under a path prefix |
| Routing is **hash** routing (`#/vault`), chosen *because* the PWA is static | `client/README.md` | the proxy needs **no SPA fallback / no `try_files … /index.html`** — only `/` must return `index.html` |
| The manifest is `display: standalone`, `scope: "/"`, `start_url: "/"` | `client/public/manifest.webmanifest` | installable at root; a subpath deploy would break it |
| There is **no service worker** — no `sw.js`, no `vite-plugin-pwa`, no `registerSW` | `client/dist` (§6); `grep` of `client/` | the app is **installable, not offline-capable**; do not claim offline |
| The bearer is **inlined at build time** into the JS bundle | `client/src/api/client.ts:35`; §3 proof | see §3 — this is the whole exposure |
| `/healthz` is deliberately **unauthenticated** | `docs/API.md` §1 | a gate in front of the origin must leave `/healthz` reachable, or a probe fails exactly when the secret is broken |

---

## 2. The serving shape — one origin, three path classes

**One origin, always.** The proxy terminates TLS and serves two things from the same host: the built
client at `/`, and `/v1` reverse-proxied to the API. This is the shape `docs/ARCHITECTURE.md` §1 already
describes ("one host, three units"), and it is the only shape the client supports without a code change.

```
                      ┌──────────────┐  HTTPS  ┌──────────────────────────────┐
   phone / browser ──▶│  reverse     │────────▶│ static: client/dist at  /    │  index.html, /assets/*,
   (PWA, same origin) │  proxy :443  │         │ proxy :  /v1, /healthz       │  icon.svg, manifest
                      │  + TLS       │────────▶│ api:8080                     │
                      └──────────────┘         └──────────────────────────────┘
```

The proxy contract the client needs (this is the interface to Ari's config, not a config of its own):

| path | behaviour | why |
| :-- | :-- | :-- |
| `/` , `/index.html` | serve `index.html`, `Cache-Control: no-cache` | a redeploy must be picked up; the hashed asset names make `no-cache` on the shell safe |
| `/assets/*` | serve file, `Cache-Control: public, max-age=31536000, immutable` | Vite hashes asset names, so the bytes at a name never change |
| `/icon.svg`, `/manifest.webmanifest` | serve file; `manifest` short-TTL | install metadata; not content-hashed |
| `/healthz` | proxy to `api:8080`, **not gated** | `docs/API.md` §1: liveness must not depend on the secret |
| `/v1/*` | proxy to `api:8080` **verbatim** (no URI rewrite); **do not buffer**; do not gzip the stream | the deck subscribes to `GET /v1/sparks/events` (SSE) — proxy buffering or gzip turns a live stream into a stalled response; and a rewritten prefix moves the auth gate off the route |
| `*` (anything else) | `404` | hash routing means no screen needs a server path |

Four integration notes that bite in practice (examples use nginx; the contract is proxy-agnostic):

- **Forward `/v1/*` verbatim — never rewrite or strip the prefix.** nginx: `proxy_pass http://api:8080;`
  with **no URI part**. A trailing slash (`proxy_pass http://api:8080/;`) strips `/v1`, so the API sees
  `/ideas` and answers `not_found`; a `rewrite` on `/v1/*` does the same. The API's own path normaliser —
  decode, *then* collapse repeated slashes — is the single authority its auth gate and its router both
  consult (`api/src/server.ts`), and it exists precisely because `//v1/ideas` and `/v1%2Fideas` once walked
  past the gate. Keep normalisation in one place: let the proxy match on the path it normalises, but hand
  the API the original URI (which `proxy_pass` without a URI part does). Max's G2.3 gates exactly these
  spellings.
- **Any access gate (§4) is scoped to the static paths — never to `/v1` or `/healthz`.** This is not a
  preference. The client sends `Authorization: Bearer <token>` on *every* `/v1` call (`client/src/api/client.ts:70`),
  and a browser does not attach cached Basic credentials to a request that already carries an
  `Authorization` header — so a Basic gate over `/v1` would answer `401` to every API call the app makes,
  and the app would be broken at the boundary the gate was added to protect. Gate `/`, `/assets/*`,
  `/icon.svg`, `/manifest.webmanifest`; leave `/v1/*` to the API's own bearer (`docs/API.md` §1) and
  `/healthz` open. **Operationally (nginx): `auth_basic` goes *inside* each static `location` — never at
  `server` level.** nginx inherits a server-level directive into *every* location, so `/healthz` and `/v1`
  get gated too: the probe then fails exactly when the secret is broken, and the app's own calls fail with
  it. (Raised in review by Max.)
- **Do not buffer `/v1/sparks/events`.** nginx: `proxy_buffering off;` and a raised
  `proxy_read_timeout` for that location (or respond `X-Accel-Buffering: no`). Reverse proxies commonly
  buffer `text/event-stream`, which looks like "the deck never updates".
- **CSP is deferred to the live-host pass, with a candidate to test.** `default-src 'self'; img-src 'self'
  data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'` is the shape to try — `connect-src
  'self'` must be exercised against the SSE `fetch`, and it is verified on the host, never assumed. Ship
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and HSTS regardless.

---

## 3. The exposure — the built bundle *is* a bearer credential

`VITE_API_TOKEN` is read at **build** time and inlined as a literal, so the shipped JS file contains the
token in clear text. Proven, not asserted: building the client at `ece5e6f` with
`VITE_API_TOKEN=CANARY-TOKEN-DO-NOT-SHIP-3931` produced

```
client/dist/assets/index-OjP7eIbW.js:  …function se(){return`CANARY-TOKEN-DO-NOT-SHIP-3931`}…
```

and no service worker. Four consequences follow, and they are the reason "private" is not a property of
how the files are hosted:

1. **Static hosting is not access control.** Anyone who can `GET /` receives the token, and can then call
   `/v1` directly with `curl`. The API's gate (`docs/API.md` §1) authenticates *the app instance*, not a
   *person*; it is a door with the key taped to it.
2. **The build artifact is secret-bearing.** The image in the registry — and any CI artifact or log that
   carries the built bundle — contains the bearer. Anyone who can `docker pull`, or read the artifact,
   reads the token. The build step must not echo it.
3. **Rotating `API_TOKEN` forces a client rebuild.** The token is baked into the bundle, so rotation is
   *rebuild → new image → redeploy*, not an env change. That coupling is avoidable (§4, G5) but it is the
   status quo.
4. **"URL-only privacy" is an illusion on a public origin.** An unguessable hostname raises the cost of
   discovery; it does not gate the file. Treated as a control, it is obscurity.

What is **already right** and must not regress: the token travels in the `Authorization` **header** —
including on the SSE path, which is deliberately a `fetch` stream rather than `EventSource` precisely so
a header can be set (`client/src/api/sparks.ts`). A token in the query string would leak into proxy
access logs, `Referer`, and browser history. Any future shortcut that moves the token into a URL is a
regression.

---

## 4. The options — what can stand in front of the origin

| option | gate | what it protects | cost / moving parts | trade-off |
| :-- | :-- | :-- | :-- | :-- |
| **G0 · no gate** ("URL-only") | none | nothing — the bundle is public | 0 | the vault is world-readable **and writable** by whoever learns the URL. Rejected as a control; this is what Shape A is *if the proxy adds nothing* |
| **G1 · HTTP Basic at the proxy** | one shared credential, on the **static paths only** (§2) | the static origin — incl. the bundle, so the token is not served before the gate | ~3 lines of proxy config + an htpasswd secret | cheapest thing that actually gates. One shared credential (fine at one user); browser-cached, so **no per-session revocation** — changing the password needs each browser's auth cache cleared or a restart; HTTPS required. **Residual: it gates who can *load* the app, not the bearer** — anyone past it can read the token out of the bundle and call `/v1` without Basic (§3) |
| **G2 · identity-aware proxy** (Cloudflare Access / oauth2-proxy / Caddy `forward_auth`) | a real identity (SSO/MFA) | the static origin, with per-user identity, revocation, and an audit trail | an extra service, or a vendor free tier with its own admin surface + DNS/IdP coupling | the only option that gives *user* auth, revocation and audit; heavier than one user needs today, and the right answer the moment a second person appears. Same bearer-extraction residual as G1 |
| **G3 · private network only** (Tailscale / WireGuard — David's Shape C) | reachability | everything — there is no public listener to gate | a tailnet; every client device joins it | strongest privacy and zero spend; availability is that box, and a link cannot be shared outside the tailnet. PWA still installs over the tailnet |
| **G4 · edge allowlist** (IP/geo) | a network origin | the origin | proxy/WAF rule | home and mobile IPs are dynamic — brittle unless the allowlist is identity- or device-based (i.e. G2 or G3) |
| **G5 · move the token out of the bundle** | *orthogonal hardening* | artifact secrecy + rotation | a small client change (read a per-deploy `config.json` at boot) + the config fetch must itself be gated | with any gate above it, makes the registry artifact non-secret and rotation env-only; **with G1 specifically it also closes G1's residual**, because the bearer is then never in a static artifact. Adds one boot-time request and its failure mode. Not a substitute for a gate |

**The floor.** G0 must not ship. G1 is the cheapest gate that closes the bundle leak; G3 is the
strongest and the zero-spend fallback. G2 is deferred until a second user or an audit trail is required.
G5 is a follow-up, not a blocker.

**G1 rests on one premise that is a host check, not a premise to assume.** The mechanism assumes a browser
will not let a cached Basic credential override the explicit `Authorization: Bearer` the app sets on every
`/v1` call. That is spec-consistent — an explicitly set `Authorization` suppresses automatic credential
attachment — but G1's viability hinges on it: were a browser to send `Basic …` instead, the API would
`401` every call and the gate would break the app it exists to protect. Verify it on the host (§6);
do not carry it as settled. (Raised in review by Max.)

---

## 5. Recommendation (for the owner's "exposure model" item)

- **If the owner wants a link he can open from any device, anywhere → G1 (Basic at the proxy), now.**
  It gates the bundle with a few lines of config and nothing else changes. **Scope it to the static paths** —
  `/`, `/assets/*`, `/icon.svg`, `/manifest.webmanifest`; *not* `/v1` or `/healthz` (§2). Recommended default.
- **If the owner wants "private" to mean *unreachable* → G3 (Tailscale).** Strongest and free; the cost is
  that every device must join the tailnet and no link leaves it. This is already David's leaning; the
  trade-off to make explicit is device enrolment, not security.
- **Not G0** — the token-in-bundle means an ungated public origin publishes the vault.
- **G5 is a separate, later call** — and the natural second step after G1, since G1's one residual is that
  the bearer stays extractable from the bundle; G5 closes it. Say so now, so the token-rebuild coupling in
  §3.3 is a known, accepted residual rather than a surprise.

Either way the API bearer stays: it is the API's own fail-closed gate (`docs/API.md` §1), independent of
the edge. Be precise about what G1 buys: it gates **who can load the app**, not the bearer. Anyone who
passes it can read the token out of the bundle and call `/v1` without Basic. For one owner that is the
intended semantics; it is not "the API is now protected by a password".

---

## 6. Evidence & handoffs

- **Build evidence** (reproduce): `VITE_API_TOKEN=<canary> npm run build --workspace client` then
  `grep -rl <canary> client/dist` → the bundle. At `ece5e6f`: dist is `index.html`, `assets/index-*.js`,
  `assets/index-*.css`, `icon.svg`, `manifest.webmanifest`; no `sw.js`.
- **To Ari (host layer):** the `/`, `/assets/*`, `/healthz`, `/v1/*` contract in §2, and no-buffering on
  `/v1/sparks/events`.
- **To Max (go-live evidence):** exercise the SSE stream *through the proxy* (not just against the API),
  confirm a gated request without credentials is refused, and confirm `/healthz` still answers. Plus
  **G1's own hinge** (§4): with Basic cached, a `fetch("/v1/…")` that sets `Authorization: Bearer` must
  still reach the API as `Bearer` (200 with a valid token; the API's own `401` without one) — if the
  cached Basic credential ever won, every call would fail.
- **Open, for the host layer / owner:** where it runs, the hostname + TLS (owner); whether the gate is G1
  or G3 (owner, on this thread).
