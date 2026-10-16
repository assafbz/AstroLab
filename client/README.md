# Client (V8)

The mobile-first PWA. S2 Capture, S3 Vault and S4 Idea Detail are built (V8, `#19`), S0 Onboarding
(O3, `#23`), S1 Sparks' **E0 branch** (O4, `#24` — the deck is K2 `#36`) with its **S1b Spark Detail**
(K3 `#37`); S5 Fork and S6 Iterate are built as of V9 `#20`. S1 and S1b
**resolve** sparks (ACCEPT / DISMISS through §4.13) as of K7 `#41`.

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
| S1 Sparks (home) | `#/` | built (O4) — E0 Cold; the deck is K2 `#36` |
| S2 Capture | `#/capture` | built (V8) |
| S3 Vault | `#/vault` | built (V8) |
| S4 Idea detail | `#/ideas` | built (V8) — the bare path is a "choose an idea" landing |
| S4 Idea detail | `#/ideas/<id>` | built (V8) — the per-id route |
| S1b Spark detail | `#/sparks/<id>` | built (K3 `#37`) — the per-id route, reached by tapping a card |
| S5 Fork | `#/fork` | built (V9 `#20`) — the bare path is E3's parent picker |
| S5 Fork | `#/fork/<id>` | built (V9 `#20`) — seeded with the parent (T24) |
| S6 Iterate | `#/iterate` | built (V9 `#20`) — the bare path composes a "choose an idea" landing |
| S6 Iterate | `#/iterate/<id>` | built (V9 `#20`) — the node it edits (T22) |

The per-id routes are resolved **before** `matchScreen`: `#/ideas/<id>`, `#/sparks/<id>`,
`#/capture/<spark_id>`, `#/fork/<id>` and `#/iterate/<id>` are each *not* one of `SCREENS` (whose S4
entry is the bare `#/ideas`, whose S1 entry is `/`, and whose S2/S5/S6 entries are the bare `#/capture`,
`#/fork` and `#/iterate`), so the matcher alone would call them a not-found. The S4 paths — and the
S5/S6 routes reached from them — leave the **Vault** tab active, because that is where they are reached
from; `#/sparks/<id>` leaves the **Sparks** tab active, since S1b is reached from the deck: a screen
with no tab of its own must not read as "nowhere".

### The entry rule — where `/` goes

`#/` (and the bare URL) is the **home**, and the home is **S1 Sparks**: *"The home is a deck. It
opens on **"Sparks"** — one proposed idea at a time — **not** on the user's notes."* (`DESIGN.md`
§5). S0 is the **first-run entry**, not the home: `FLOW.md` §4.2 **T01** sends a first launch to
S0, and **T05** sends a return launch straight to S1. S0 therefore carries its own path
(`#/onboarding`), not the root.

The shell has no vault state, so it cannot make the T01/T05 choice itself — the **state-dependent
entry** (`FLOW.md` §4.1 E0–E4) is still unbuilt. The shell's `/` is simply the home. O4 `#24` gave `/`
its first real content on that path: S1 reads `GET /v1/vault/summary` and lands **E0 Cold** whenever
the vault is below the spark floor, which is the same screen either S0 exit arrives on.

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
- **The exits are here (O4 `#24`).** T04's **See your sparks** renders iff `spreadGate(summary)` —
  the server's `eligible`, read and never recomputed — and T03's quiet mono **skip for now** is always
  present. Both are anchors onto `#/`, the home `router.ts` already owns. While the summary is unread
  or unreachable the gate CTA is **absent rather than guessed**.
- S0 has no active tab because it is reached before the app's home.

## Tests

`npm test -w client`. Pure logic is tested in the node environment; the screens are rendered in
`jsdom` with `@testing-library/react` (`// @vitest-environment jsdom`), both **dev-only** — the app
itself still ships `react`/`react-dom` and nothing else. The rendered suite is what holds the
user-visible claims: inline per-field errors and the 280 counter (T17), the three absent states on
the Vault (T19/T20/T29), the lineage chain and muted provenance (T21), and the delete confirm
(T26).

## S1 Sparks (O4 `#24`)

- **The gate is the server's.** `src/domain/spread-gate.ts` returns `summary.eligible` —
  `vault-summary.ts` computes it as `resolved_domains >= floor`, which *is* T04's "≥ 2 distinct
  **resolved** domains". Recomputing it here would make the gate a second source of truth for one
  boolean, so it is read. `provisional_domains` and `target` never enter the gate.
- **E0 renders from a sufficient condition, not from a derived E0.** `FLOW.md` §5.2 makes the floor
  *"the only condition"* that puts S1 in E0, so `!eligible` **implies** the engine's E0. The client
  never derives E0's full definition (the `< 2 ideas` clause) from `VaultSummary` — that is the
  engine's own read (`GET /v1/sparks/state`, W8 `#33`), and T03's *"else → E1 Computing"* waits for it
  with K2 `#36`. Only the E0 branch is built; the other four states are K2's.
- **The Skip deviation has no wire form.** T03 permits `Skip` and calls it *"recorded as a
  deviation"*, but the frozen contract has no endpoint and no field for it (`ARCHITECTURE.md` §6 has
  no row; `API.md` §3.2/§4.3 have no field). Nothing is persisted: the recorded fact is already the
  vault's own `resolved_domains < floor`, and Skip's only consequence is S1 landing in E0.

### Deferred

S1b (Spark Detail) is not in S0–S6 and has no route yet; the deck and the engine's E0–E4 read are K2
`#36` / W8 `#33` (so `#/` still shows the deck's placeholder wherever the gate is open), the seeded
capture path (`origin_spark_id`/`decision_id`) needs the spark deck. (V9 `#20` has since landed the
S4 Iterate/Fork actions, S5 Fork and S6 Iterate — see below.) Self-hosted Geist / JetBrains Mono are deferred — the token file falls back to system stacks
until a screen needs the real faces.

## Forking and iterating — S5 and S6 (V9 `#20`)

- **A fork's request is the frozen two fields.** `POST /v1/ideas/{id}/fork` (§4.7) carries only
  `mutation_delta` + `domain_tags`; the fork's `hypothesis` / `problem` / `monetization` are the
  **parent's, copied server-side**. So S5 shows the parent (dimmed, labelled `PARENT`) and never an
  editor for those three: what the user writes is what **changed**. A test pins the body to exactly the
  two fields, because a third key would be a `422`.
- **Same-domain is set equality, order- and duplicate-insensitive** (§4.7). The fork's domain set must
  **differ** from the parent's, and a **superset differs** — that is the widening case the flywheel runs
  on. `sameDomainSet` (`src/domain/capture.ts`) mirrors the server's own rule, so the screen makes the
  decision *before* the request and answers a server `409` with the same **Iterate instead** offer: one
  answer, two ways of arriving at it.
- **Bare `#/fork` is E3's entry**, and §4.7 needs a parent — so it composes a **parent picker** over
  §4.4, the same read the Vault renders. No second idea list, no second transport; an empty vault
  composes an invitation, not a blank list.
- **An iterate's request is the four mandatory fields verbatim** (§4.6), so S6's draft *is* the body:
  it starts from the idea's own fields via `draftFromIdea`, the same function S4's completion editor
  uses, rather than a second spelling of the four. A committed save **returns to S4** instead of
  patching itself — the node's own read is the snapshot that cannot drift (§4.10's rule).
- **"A refinement that changes nothing is not a version"** (`DESIGN.md` §8). `sameDraft` decides it:
  `domain_tags` as a **set** (removing and re-adding a tag in another position is the same domains),
  the three text fields **as typed** (a whitespace edit is a real change, because §4.6 stores what was
  written). The CTA is disabled with the mono *"No changes yet"* while the form matches the current
  version; otherwise it stays tappable, and validation runs on the first press then live — Capture's
  rule (§5.2/T17), so the inline error can follow the tap.
- **Version history is not lineage.** S6's rows are a **flat** list opening read-only: no brass node
  markers, no connectors, and no *"iterate from this version"* affordance — that is a branch, and a
  branch is Fork. The chain vocabulary belongs to LIVING LINEAGE on S4, and a version is not an ancestor
  (`DESIGN.md` §8, L1).
- **E3 composes three levers** (`DESIGN.md` §9): *Add idea* (S2) · *Fork an idea into a new domain*
  (`#/fork`) · *Recompute*. `EmptyState`'s `tertiary` exists for that composition alone.
- **Guards.** `src/domain/deck-interaction.test.ts` holds the vault-screen import rule — S2/S3/S4 **and**
  the two screens this lane adds may not reach `api/sparks.ts` or the run policy, since a vault write
  must succeed with the AI down (NFR-A1). Each guard in this lane was planted and watched red.

## Resolving a spark — S1 and S1b (K7 `#41`)

- **One module, two screens.** `src/domain/decision.ts` owns §2.2's decision identity — one
  `decision_id` per decision, minted once, reused on a retry, never regenerated — and
  `src/api/decisions.ts` is §4.13's transport. Each screen wires its **own** resolver, so the deck's
  re-read stays in the screen that owns the deck, and the seam stays **`void`**: the outcome reaches the
  screen only through `onResolved` / `onFailed`. An injected `onResolve` overrides it — that seam is how
  S1b's §5.5 parity check compares the two screens' commands.
- **A raced swipe + tap is one *request*.** §4.3 resolves them to one decision, and §5.5 makes them the
  same command, so the module **coalesces**: while a request for a spark's decision is out, a further
  press does not send. Only one request per key is ever in flight, and a success retires the record
  before it is reported — so a failure can only be emitted by its own settling request and never follows
  a success.
- **A commit re-reads; nothing is removed locally.** The ladder and the deck are the server's (§4.10,
  §4.9), so the screen re-reads both and renders whatever they answer — a card shown as resolved before
  the server says so would be exactly the drift §4.10 exists to prevent.
- **A failure is non-destructive (T29).** A **retryable** one (`network` / `internal_error`;
  `isRetryable`) keeps the card and draws a notice whose one lever is **Retry**, re-issuing the *same*
  `decision_id`. Anything else is the server **stating** something — a `409` that the spark is not
  `OFFERED`, a `404`, a bad token — so the screen **re-reads** rather than offering a Retry that could
  only loop.
- **S1b returns to the deck.** On a commit the detail goes back to `#/`: the card is gone from §4.9, so
  a detail of a just-resolved spark would show what the server no longer offers. A `409` goes there too,
  rather than retrying.
- **`INSPIRED` posts nothing.** It is §4.14's *seeded capture*, not a resolution — it writes no
  `decision` row — so the transport's `INSPIRED` arm is a no-op and S1b draws no lever for it (#119
  owns that half).
- **The one `api/ → domain/` edge is a *type*.** `api/decisions.ts` imports the seam's `ResolutionKind`
  as `import type`, so the union has **one** declaration rather than a second spelling in the transport.
  `src/api/boundary.test.ts` holds the line: every other edge in the client runs `domain/ → api/`, and a
  *value* import back the other way would make the two packages mutually dependent at runtime.
