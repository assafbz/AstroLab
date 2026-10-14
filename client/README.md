# Client (V8)

The mobile-first PWA. S2 Capture, S3 Vault and S4 Idea Detail are built (V8, `#19`), and S0 Onboarding
is built (O3, `#23`); S1/S5/S6 are still the shell's placeholders until their own issues land.

- **Stack:** Vite + React + TypeScript (`docs/adr/0005-client-stack.md`).
- **Design tokens:** `src/styles/tokens.css`, lifted from `DESIGN.md` §2 (colour and geometry) and §5 (layout).
  Brass is the only accent.
- **Layout:** 16px gutters, grown to the device safe area; `viewport-fit=cover` is set in
  `index.html`, and the tab bar pads the bottom inset.
- **Logic vs screens:** every rule lives in a pure module (`api/`, `domain/`, `router.ts`) tested
  directly; the screens render it. Nothing user-visible is asserted only on the pure modules.

## Routes

Hash routing (`#/vault`), not history routing: the PWA is served as static files, so a path the
host does not know would 404 on reload. One path per screen; the `FLOW.md` §2.1 screen ids are the
labels.

| Screen | Path | Status |
| :--- | :--- | :--- |
| S0 Onboarding | `#/onboarding` | built (O3) — the capture-and-stay loop |
| S1 Sparks (home) | `#/` | placeholder |
| S2 Capture | `#/capture` | built (V8) |
| S3 Vault | `#/vault` | built (V8) |
| S4 Idea detail | `#/ideas` | built (V8) — the bare path is a "choose an idea" landing |
| S4 Idea detail | `#/ideas/<id>` | built (V8) — the per-id route |
| S5 Fork | `#/fork` | placeholder |
| S6 Iterate | `#/iterate` | placeholder |

The per-id route is resolved **before** `matchScreen`: `#/ideas/<id>` is not one of `SCREENS`
(whose S4 entry is the bare `#/ideas`), so the matcher alone would call it a not-found. The S4
paths leave the **Vault** tab active — S4 is reached from the Vault, and a screen with no tab of
its own must not read as "nowhere".

### The entry rule — where `/` goes

`#/` (and the bare URL) is the **home**, and the home is **S1 Sparks**: *"The home is a deck. It
opens on **"Sparks"** — one proposed idea at a time — **not** on the user's notes."* (`DESIGN.md`
§5). S0 is the **first-run entry**, not the home: `FLOW.md` §4.2 **T01** sends a first launch to
S0, and **T05** sends a return launch straight to S1. S0 therefore carries its own path
(`#/onboarding`), not the root.

The shell has no vault state, so it cannot make the T01/T05 choice itself — the **state-dependent
entry** (`FLOW.md` §4.1 E0–E4) is still unbuilt. The shell's `/` is simply the home.

A trailing slash resolves (`#/vault/` is not a not-found). An unknown path lands on the shell's
own **not-found fallback** — the tab bar stays, the body reads "Not found" — never a blank screen.

## Talking to the API

The client reads the vault over `/v1` (`docs/API.md`). Every call goes through `apiRequest`
(`src/api/client.ts`), which attaches `Authorization: Bearer ${VITE_API_TOKEN}` and maps the single
error envelope (§2) onto `ApiError.code`. Copy `.env.example` to `.env` and set `VITE_API_TOKEN`;
Vite exposes only `VITE_`-prefixed vars to the bundle. With the token empty the header is omitted
and the server fails closed with `401`.

Two contract notes the screens depend on:

- `DELETE /v1/ideas/{id}` (§4.8) is implemented client-side from the frozen contract; the **route**
  lands in V5 (`#16`), so a live delete answers `not_found` today. The Delete action surfaces that
  envelope in its confirm panel rather than failing blankly.
- S2's save lands on the **created idea's detail** (`#/ideas/<id>`). That is a placeholder for
  T16's "origin", which has no renderable meaning yet; it re-opens when the deck (**K2 `#36`**) and
  onboarding (**O3 `#23`**) land the real origin.

## S0 Onboarding (O3)

- **Domain is picked from the shipped taxonomy, with an `Other → free text` escape**
  (`FLOW.md` §4.2/T02, r3.3). The picker's **value is the cluster key** (`ai-ml`) and its label is the
  cluster's `name` (`AI & ML`): the loader registers each key in its own cluster and never a name
  (`store/seed/README.md` rule 2), so a pick is *resolved by construction*. `src/domain/taxonomy.ts`
  mirrors the 28 clusters and `taxonomy.test.ts` reads the shipped YAML and fails on any drift — the
  client cannot reach the taxonomy otherwise (no endpoint exposes it; `client` may not import `store`).
- **A typed domain writes its `domain_tag` immediately** on `POST /v1/ideas`; "provisional" is not a
  stored state but what `GET /v1/vault/summary` computes at read time for a tag absent from
  `domain_map` (`docs/API.md` §3.2). The chip says so in words.
- **`domains covered x / 3` renders the summary's numbers** — `resolved_domains` over `target` — and
  never a local tally, so the readout and O4's spread gate read the same quantity (R1).
- **The mark has no distance arcs.** `DESIGN.md` §6 draws them between points "far apart", but no S0
  endpoint exposes `domain_cluster.adjacency` and `ARCHITECTURE.md` §6 bars the client from computing
  scores, so the mark is rings plus one brass point per resolved domain and one pale per provisional.
- **The exits are not here.** T03 Skip and T04's "See your sparks" gate are O4 (`#24`), and so is the
  first-run entry (T01/T05); S0 has no active tab because it is reached before the app's home.

## Tests

`npm test -w client`. Pure logic is tested in the node environment; the screens are rendered in
`jsdom` with `@testing-library/react` (`// @vitest-environment jsdom`), both **dev-only** — the app
itself still ships `react`/`react-dom` and nothing else. The rendered suite is what holds the
user-visible claims: inline per-field errors and the 280 counter (T17), the three absent states on
the Vault (T19/T20/T29), the lineage chain and muted provenance (T21), and the delete confirm
(T26).

### Deferred

S1b (Spark Detail) is not in S0–S6 and has no route yet; the seeded capture path
(`origin_spark_id`/`decision_id`) needs the spark deck; the S4 Iterate/Fork actions are V9
(`#20`). The taxonomy picker landed with S0 (O3). The spread gate and the Skip deviation are O4
(`#24`). Self-hosted Geist / JetBrains Mono are deferred — the token file falls back to system stacks
until a screen needs the real faces.
