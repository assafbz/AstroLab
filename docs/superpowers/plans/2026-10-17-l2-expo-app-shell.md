# L2 — Expo App Shell + Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The AstroLab app runs on device as an Expo (React Native) app over `@astrolab/core`: S0–S6 render, the deck
judges, the six surfaces work with the provider down, and the E0–E4 band is composed — not asserted.

**Architecture:** `app/` is the composition root and holds no business logic. It opens the `SqliteConnection` (an
`expo-sqlite` adapter), supplies the `KeyStore` and the run driver, and renders what `core/vault` returns. Every
rule that can be a pure function already lives in `core/src/domain` (capture validation, spread gate, deck band,
swipe thresholds), so the app is composition and pixels. `core/` is consumed through its package entry — one
import surface, no app module reaching `engine/` or `provider/`.

**Tech Stack:** TypeScript · Expo (React Native) via `react-native-web` for the web target · `expo-sqlite` (device)
/ `node:sqlite` (tests, CI) · `react-navigation` · vitest (source-walk + pure tests only) · Nightfall tokens as RN
values.

**Spec:** `docs/ARCHITECTURE.md` (v2) §1, §4.2–§4.3, §6, §9, §13 · `docs/adr/0006-local-only-expo-app.md` ·
`DESIGN.md` §1–§9 · `docs/FLOW.md` §2.1, §4.1–§4.3, §5 · `docs/superpowers/plans/2026-10-17-l1-l4-local-only-rebuild.md`
(the lane breakdown; its **L2** section is this lane's scope and its invariants 1–11 bind here).

## Global Constraints

- **The composition root is `app/`** (invariant 4): it constructs the connection, the key store and the engine
  driver, and hands them to `core`. `core/` never imports `expo-*`; `app/` never re-implements a `core/` rule.
- **Adapter isolation** (invariant 5): `expo-sqlite` is imported only by `app/`; the device bundle must not
  contain `node:sqlite` (`core/test/boundary-node-adapter.test.ts` is the guard, and it walks `core/src`).
- **The engine is not the app's to call** (NFR-A1, §4.3): no screen, component or navigation module imports
  `core/src/engine/**` or `core/src/provider/**`. Enqueueing a run is a **table write** through `core/vault`; the
  driver observes the table (§4.1).
- **Design tokens bind, shadcn does not** (`DESIGN.md` header): Nightfall palette values, Geist / JetBrains Mono,
  **8px** radius, **44px** targets, `transform`/`opacity` motion, **no circular spinner** anywhere.
- **Judge the idea, not the pairing** (`DESIGN.md` §1): no distance / alignment / similarity readout, no "related
  ideas", provenance only once and muted on S4.
- **Never sleep or poll** in code or tests (`AGENTS.md` *Harness overrides* 1): the deck reacts to an in-process
  event (§4.2), never to a timer. `core/domain/deck-stream.ts`'s backoff table is the *retired* v1 transport and is
  not wired to anything in `app/`.
- **Device-only behaviour is manual sign-off** (invariant 9): each such item carries a deterministic core test in
  CI **plus** a named emulator sign-off in the PR.
- **A held-lane PR carries no closing keyword + `#n`**: write `Part of #165` throughout. Only the closing PR writes
  `Closes #165` — and, because this lane re-homes #148's requirement, `Closes #148` on **that same, closing** PR.
- **Any PR touching `.github/` must show the three required jobs still report** (`AGENTS.md` *Harness overrides* 4).
  This plan's design goal is that it needs **no** `.github/` change (Task 1, Task 9).

## Review Focus

1. **First launch with no key set** → S1 shows **E4 with the cause** (*"Add your AI key to see sparks."*), never a
   blank deck, a crash or a silent cold state (`ARCHITECTURE.md` §4.3). → Task 5.
2. **A swipe and a button tap fired together** → exactly **one** decision, keyed on `(spark_id, decision_id)`
   (`FLOW.md` §5.5). → Task 4.
3. **An OS kill mid-capture** → no typed value is lost *silently*: the draft is either restored or its discard is
   confirmed (`FLOW.md` §5, L2 Review Focus). → Task 3.
4. **A vault screen with the provider down** → capture / vault / detail / fork / iterate all answer (NFR-A1);
   only the deck says E4. → Task 7.
5. **Undo over all three resolving paths** → one step covers ACCEPT, DISMISS **and** the committed seeded save
   (`FLOW.md` §5.4). → Task 4.

---

### Task 1: `app/` shell, the core import surface, and boot to S0/S1

Folds the workspace wiring, the Metro/TS config, the theme tokens file and the navigation frame into one
deliverable: the app boots and the entry surface exists. Nothing is reviewable before this.

**Files:**
- Create: `app/package.json` · `app/app.json` · `app/metro.config.js` · `app/tsconfig.json` · `app/vitest.config.ts`
- Create: `app/src/App.tsx` (navigation + the boot sequence) · `app/src/bootstrap.ts` (the composition root)
- Create: `app/src/store/expoConnection.ts` (the `expo-sqlite` adapter — the only `expo-sqlite` importer)
- Create: `app/src/theme/tokens.ts` (`DESIGN.md` §2–§3 as exported values, one name per token)
- Create: `app/src/screens/Sparks.tsx` (a placeholder the shell can boot to; replaced in Task 4)
- Modify: `core/src/index.ts` (the entry's surface — Step 2) · `package.json` (root: the `workspaces` order — Step 3)
- Create: `core/test/entry-surface.test.ts` (the entry's guard — Step 2)
- Test: `app/src/theme/tokens.test.ts`

**Interfaces:**
- Consumes (from `core`, exact names): `SqliteConnection` (`exec` · `prepare` · `Statement.run/get/all` · `close`);
  `openStore(conn: SqliteConnection): void`; `migrate(db, MIGRATIONS)`; `seedDomainTaxonomy(db)`;
  `vaultSummary(db): VaultSummary` (`{ …, resolved: number }`); `engineState(db): EngineState`.
  **Not** consumed: `connection.node.ts` (invariant 5) and `writeTransaction` (deliberately unexported —
  `core/src/store/index.ts`).
- Produces: `openDatabase(): SqliteConnection` (expo adapter, `null → undefined` miss sentinel mapped per
  invariant 1c); `boot(): Promise<{ conn: SqliteConnection }>` running `migrate → seedDomainTaxonomy → render`;
  `tokens` (the Nightfall value map); `App()`.
- Produces the decision the guard in Task 7 reads: **the app resolves `core` only through `@astrolab/core`**.

- [ ] **Step 1: Create the workspace package and prove the install is real.**

`app/package.json`: `"private": true`, `"type": "module"`, `"name": "@astrolab/app"`, deps `@astrolab/core`
(workspace `*`), `expo`, `expo-sqlite`, `react`, `react-native`, `react-native-web`, `@react-navigation/native`,
`@react-navigation/bottom-tabs`; scripts `start` (`expo start`), `typecheck` (`tsc -p tsconfig.json --noEmit`),
`build` (`expo export --platform web --output-dir dist --clear`), `test` (`vitest run`).

Run: `npm install` from the repo root, then `npm ls expo-sqlite --workspace app`.
Expected: one `expo-sqlite@58.0.13` (the root `overrides` entry is the pin from invariant 1a — it must not be
re-declared loosely in `app/`).

- [ ] **Step 2: The core import surface — one entry, and two built doors.**

The app needs what `core/vault/*` and `core/domain/*` export, and nothing else; today `core/src/index.ts`
re-exports **`./store/index.js` only** (L1 left the shape to L2, flagged on PR #168). **Landed on this branch
2026-10-17** — the entry is now store ∪ vault ∪ domain, with four modules deliberately off it. The reason is
measured, not stylistic: **`export *` is not a union.** A scan of every shipped module's export names finds **15
cross-module collisions** — 13 of them `./types.ts` against `./vault/**` (`Idea` · `IdeaVersion` · `IdeaFields` ·
`IdeaDetail` · `VaultFilters` · `VaultSummary` · `Spark` · `SparkDetail` · `InspireSeed` · `Decision` ·
`CaptureInput` · `EngineState` · `ProvenanceRef`), plus `MonthlyCount` across the two metrics modules, plus
`isoTimestamp` (the store's own, legitimately re-exported by `vault/capture.ts`). The thirteen are **distinct
declarations with identical fields** — a v1 inheritance (the client's `api/types.ts` rode alongside the handlers),
not a rebuild defect — so a wildcard union re-exports **none** of them, silently; a union with a preference puts two
meanings of `Idea` in one namespace. The vault modules are the ones the app calls, so they are the ones on the
entry and `./types.ts` stays the package's internal contract.

Off the entry, each for its own reason (all four stated in `src/index.ts`): **`./types.ts`** (above) ·
**`./vault/metrics.ts` · `./vault/metrics-report.ts`** (the NFR-Q1 instrument and its reports — they collide with
each other on `MonthlyCount`, and a user-visible readout is the owner's call, §12 item 12) ·
**`./domain/deck-stream.ts`** (the retired v1 SSE/poll transport, §4.2 — nothing in `core/` imports it, and leaving
it off the entry is what keeps the app from picking a timer back up).

Prove it rather than assert it: `core/test/entry-surface.test.ts` (**new, this step**) derives the module list from
the tree, requires the entry's re-export set to equal it exactly, and checks at runtime that every **value** name of
every re-exported module is reachable from the entry. At the landing step: **24 modules · 62 type names · 118 value
names**, `npm test -w core` **501/501**. The plant was run: appending `export * from "./types.js";` fails the
module-set assertion while the runtime half *passes*, because the dropped names are all types — recorded in the
test's docstring so the load-bearing half is obvious.

**The doors — ruled by David 2026-10-17 (option A).** The engine and the provider are reached by their **built**
paths: `@astrolab/core/dist/engine/…` and `@astrolab/core/dist/provider/…`. One runtime mode (Metro already bundles
`core`'s `dist/` for the entry, `main: dist/index.js`), no `exports` map, and Task 7's guard stays a **specifier**
walk.

That choice costs one thing, and it is **not** build order: `core`'s build emits **no declarations at all** —
`find core/dist -name '*.d.ts' | wc -l` → `0` (verified, at `df6eea12`) — so a `dist/` specifier has **no types**
under `tsc` *whether or not* `dist/` exists. A probe fails
`TS7016: Could not find a declaration file for module '@astrolab/core/dist/store/index.js'`. So the type plane needs
`app/tsconfig.json` to map the deep specifiers to `core`'s **source**:
`"paths": { "@astrolab/core/dist/*": ["../core/src/*"] }` — the same `types: src` / `main: dist` duality the entry
already lives with, and a `tsc`-only mapping.

- [ ] **Step 3: Prove the two planes, then order the workspaces.**

`tsc` must resolve the deep specifier's **types** from source while the **runtime** resolves the built file — check
both, because only one of them is what CI runs:

```bash
# types: an app-side file importing a dist/ specifier must typecheck
npx tsc --noEmit -p app/tsconfig.json
# runtime: the same specifier resolves the built module (43 exports at df6eea12)
node --input-type=module -e "const m = await import('@astrolab/core/dist/store/index.js'); console.log('runtime exports:', Object.keys(m).length)"
```

**And then verify — do not assume — that Metro still bundles `dist/`.** Expo enables tsconfig `paths` in Metro, so
a bundle that followed the mapping into `core/src/**` (NodeNext `.js` specifiers and all) is the failure this step
exists to catch: after `npm run build -w app`, assert the bundle contains `core`'s built output and not its source.
Finally, `npm run build` is `--workspaces` in **array order** and `app` bundles `core`'s `dist/`, so
`workspaces` becomes `["core","app"]`: `rm -rf core/dist && npm run build && ls core/dist/index.js app/dist/index.html`,
then `npm run typecheck` — which must pass **without** `core/dist` present, because the types come from source.

- [ ] **Step 4: The connection adapter, and the parity test that keeps it honest.**

`app/src/store/expoConnection.ts` implements `SqliteConnection` over `openDatabaseSync`. Required mapping
(invariant 1c): `getFirstSync()` returns `T | null`; the port's miss sentinel is `undefined` — map it. Each
statement is finalised per call (`finalizeSync()` in a `finally`); no statement cache.

Test: the same round-trip assertions `core/src/store/connection.test.ts` makes (open in-memory, create a table,
insert, read back, read a missing row) — plus the one assertion the parity test exists for:
`expect(conn.prepare("SELECT 1 AS n WHERE 0").get()).toBeUndefined()`.

- [ ] **Step 5: Boot.**

`app/src/App.tsx`: `boot()` → `expoConnection` → `openStore` → `migrate` → `seedDomainTaxonomy` →
`vaultSummary(db).resolved >= 2 ? S1 : S0`. The boot is not a splash screen and does not block on the engine
(§4.1: a run is never awaited by a read path).

Test (`tokens.test.ts` is the cheap first red; the boot assertion is a pure one): `expect(tokens.canvas).toBe("#080A12")`,
`expect(tokens.radius).toBe(8)`, `expect(tokens.targetMin).toBe(44)`, and for each token in `DESIGN.md` §2 a value
— a token list that drifts from the table is the failure this test exists for. **Deviation is a task, not a typo**:
if a value must differ in RN (e.g. no `letterSpacing` on one platform), say so in the test's name.

- [ ] **Step 6: Run the full suite and commit.**

Run: `npm run lint && npm run format && npm run typecheck && npm test` (root — every workspace).
Expected: green, and `core`'s 499 tests unchanged.

```bash
git add app core docs
git commit -m "feat(app): Expo shell, the core import surface, and boot to S0/S1"
```

### Task 2: The Nightfall primitives (RN)

The token set is only binding if every surface is built from a small set of primitives that consume it. This is
where "shadcn does not survive" is made concrete.

**Files:**
- Create: `app/src/components/{Button,Card,Chip,Input,Shimmer,EmptyState,StarChart}.tsx`
- Test: `app/src/components/primitives.test.ts` (pure props → style mapping only)

**Interfaces:**
- Consumes: `tokens` (Task 1).
- Produces: `Button({ variant: "default" | "outline" | "ghost" | "destructive", label, onPress, disabled })`;
  `Card({ children })`; `Chip({ label, active?, onPress? })`; `Input({ label, helper?, error?, value, onChangeText })`;
  `Shimmer()` (Card dimensions, no spinner); `EmptyState({ headline, body?, actions })`;
  `StarChart({ points, arcs })`.

- [ ] **Step 1: Write the failing style-map test.**

Assert the four rules that are machine-checkable: a `Button`'s min height is `tokens.targetMin` (44); a `Card`'s
`borderWidth` is 1 and `borderRadius` is 8; a `Chip`'s `borderRadius` is fully rounded; **no** returned style
object contains a `shadow*` key or `elevation` (`DESIGN.md` §4: *borders over shadows*), and no prop named
`spinner`/`ActivityIndicator` exists in the module (the no-circular-spinner rule, §4 Loaders).

- [ ] **Step 2: Run it and watch it fail** (`Cannot find module './Button'`).

- [ ] **Step 3: Implement the primitives** as `StyleSheet.create` objects built from `tokens`; motion only
  `transform`/`opacity` (`DESIGN.md` §6).

- [ ] **Step 4: Run the test — PASS**, then `npm run typecheck -w app`.

- [ ] **Step 5: Commit** (`feat(app): Nightfall primitives as RN components`).

### Task 3: Onboarding (S0) and Capture (S2)

**Files:**
- Create: `app/src/screens/Onboarding.tsx` · `app/src/screens/Capture.tsx` · `app/src/components/DomainPicker.tsx`
- Create: `app/src/draft.ts` (the capture-draft autosave seam)
- Test: `app/src/draft.test.ts`

**Interfaces:**
- Consumes (from `core/domain`, exact names): `validateCapture(draft): CaptureErrors` · `HYPOTHESIS_MAX` (280) ·
  `counterText(length: number): string` · `addDomainTag`/`removeDomainTag`/`distinctDomainTags` ·
  `chooseCluster(cluster: DomainCluster): DomainChoice` · `chooseFreeText(raw: string): DomainChoice | null` ·
  `isProvisional(choice): boolean` · `seedToDraft(seed: InspireSeed): CaptureDraft` · `sameDraft(a, b): boolean`.
- Consumes (from `core/vault`): `createIdea(db, CaptureInput): Idea` (S0: `saveOnboardingIdea` in `core/domain`
  wraps it) · `inspireSeed(db, id): InspireSeed | null`.
- Produces: `saveDraft(draft)` / `loadDraft()` / `clearDraft()` — the capture-kill seam (Review Focus 3).

- [ ] **Step 1: Write the failing test for the two rules the screens must not own.**

`draft.test.ts`: (a) `counterText(279)` → `"279 / 280"`-shaped readout, and a 281-char draft is
`validateCapture(...).hypothesis` truthy (**the 280 counter blocks, it does not truncate silently**);
(b) a payload round-trips through the autosave seam: `saveDraft(d)` → `loadDraft()` deep-equals `d`, and
`clearDraft()` → `loadDraft()` is `null`. Assert the storage medium is the app's own store, **never**
`localStorage` (`AGENTS.md`'s web posture; the key rule is L3's, but the principle is the same).

- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement** `draft.ts` (a `capture_draft` row or app-sandbox file, one slot) and the two screens:
  S0 walks `ONBOARDING_PROMPTS` (`promptFor(index)`), the picker renders the seeded clusters plus the dashed
  **+ add domain** chip whose free-text lane is `chooseFreeText` (`DESIGN.md` §4, Input); the star chart reveals on
  each capture; the `x/3` readout comes from `progress(summary)` (`core/domain/onboarding.ts`). S2 is the same
  fields for a seeded or blank capture.
- [ ] **Step 4: The S0→S1 gate.** `See your sparks` renders **only** when `progress(summary).resolved >= 2`; the
  gate reads the same `resolved` count the engine's E0 check reads (`FLOW.md` T04, R1). `Skip` navigates without
  enqueueing (`FLOW.md` T03 — a recorded deviation, not a completion).
- [ ] **Step 5: Run the test — PASS**, then `npm run typecheck -w app && npm run lint`.
- [ ] **Step 6: Commit** (`feat(app): onboarding and capture, with the draft seam`).

### Task 4: The deck (S1) and spark detail (S1b)

**Files:**
- Create: `app/src/screens/SparkDetail.tsx` · `app/src/components/SparkCard.tsx` · `app/src/deck.ts`
- Modify: `app/src/screens/Sparks.tsx` (the placeholder from Task 1 becomes the deck)
- Test: `app/src/deck.test.ts`

**Interfaces:**
- Consumes (from `core/domain/deck-state`): `deckBand(state, deck, coverage): DeckBand`.
- Consumes (from `core/domain/deck-interaction`): `SWIPE_DISTANCE_PX` (48) · `TAP_SLOP_PX` (10) ·
  `swipeKind(...)` · `isTap(...)`. **These are already pure and testable; they are the axis/threshold half of the
  retired `deck-interaction.test.ts` and currently have no test at all in `core` (the v1 test retired with the
  screens).** Re-assert them here and see Task 7 for the structural half.
- Consumes (from `core/domain/decision`): `createDecisionResolver(deps): DecisionResolver` ·
  `resolutionNotice(error)` · `isRetryable(error)` · `ResolutionKind`.
- Consumes (from `core/vault`): `listOfferedSparks(db)` · `sparkDetail(db, id)` · `resolveDecision(db, input)` ·
  `inspireSeed(db, id)` · `undoDecision(db, decisionId)` · `UNDO_WINDOW_SECONDS`.
- Produces: `deck.ts` — `resolve(sparkId, kind, decisionId)`, the app's **single** `onResolve` call site
  (Task 7 asserts the count), and `undo(decisionId)`.

- [ ] **Step 1: Write the failing tests for the two failure modes this task owns.**

(a) **one decision per gesture pair**: with a stubbed `resolveDecision` recording its arguments, driving a swipe
right *and* a tap on `Good` for the same card yields `calls.length === 1`, and its `decision_id` is the card's
`decision_id` — i.e. the guard is not the UI's debounce but the **idempotency key** (`FLOW.md` §5.5; the DB is the
enforcer, `ARCHITECTURE.md` §6).
(b) **the thresholds are the core's, not the screen's**: `swipeKind(47, …)` is not a swipe while
`swipeKind(48, …)` is, and a 10px-moved tap is still `isTap` (`SWIPE_DISTANCE_PX` / `TAP_SLOP_PX` read from the
core module, so a re-declared literal in `app/` cannot pass).
(c) **undo covers three paths**: `undo` after ACCEPT, after DISMISS and after a committed seeded save each take
the same one-step path, and a second undo is refused (`FLOW.md` §5.4).

- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement the card** — `THE IDEA` (≤ 3 lines) · `THE CLAIM` · `FIRST STEP` · mono domain chips ·
  actions **Good** / **Not for me** at ≥ 44px, plus one-step undo. **No origin line, no score**
  (`DESIGN.md` §4, §7). Swipe right/left map to the same single `onResolve`.
- [ ] **Step 4: `View all` appears only when `n > 1`** (`DESIGN.md` §9 E2); `INSPIRE` on S1b opens **seeded
  Capture** (`createIdea` with `seedToDraft`) and writes **no** `decision` (§6: inspire is not a resolution).
- [ ] **Step 5: Run the tests — PASS**, then typecheck + lint.
- [ ] **Step 6: Commit** (`feat(app): the deck, the spark card and the decision seam`).

### Task 5: The engine band E0–E4, including the no-key arm

**Files:**
- Create: `app/src/components/EngineBand.tsx` · `app/src/engine-state.ts` (the app's state subscription seam)
- Modify: `app/src/screens/Sparks.tsx` (the band composes into the deck's position, it does not replace the frame)
- Test: `app/src/engine-state.test.ts`

**Interfaces:**
- Consumes: `engineState(db): EngineState` (`{ phase: "E0"|"E1"|"E2"|"E3"|"E4", … }`, `core/src/vault/engine-state.ts`);
  `deckBand(state, deck, coverage)`; `progress(summary)`; `MIN_IDEAS` / `FLOOR` = 2 / `TARGET` = 3.
- Produces: `bandFor(engine: EngineState, deck: Spark[], summary: VaultSummary, keyPresent: boolean): BandView`
  — a **pure** function, so the precedence table is testable in CI without an emulator.

- [ ] **Step 1: Write the failing precedence test** — the four rules from `DESIGN.md` §9 as assertions:
  **E0 dominates all** (an E0 vault renders E0 even with `phase === "E4"`); **E4 > E3**; **E1 coexists with E2**
  (in-flight shimmer renders *above* live cards; E1 is never a full-screen takeover); **E3-at-exactly-2** adds the
  widening nudge and E3-at-3+ does not.
- [ ] **Step 2: The no-key arm (Review Focus 1).** `bandFor(…, keyPresent: false)` returns E4 with the copy
  *"Add your AI key to see sparks."* — asserted as a case, so the first launch cannot render a blank deck or E0.
  (`ARCHITECTURE.md` §4.3; L3 owns the `NoKeyError` that produces the same arm from a live call — this task owns
  the *rendered* arm, and the seam is `keyPresent`, supplied by the composition root.)
- [ ] **Step 3: Run it and watch it fail.**
- [ ] **Step 4: Implement the band**: E0 = star-chart mark + mono `domains covered x / 3` + the reason line + one
  brass **Add idea**; E1 = staggered shimmer at Card dimensions, **no circular spinner**; E2 = the top card with
  `n > 1` toggling `View all`; E3 = *"No sparks left — for now."* + **Add idea** / **Fork** / mono **Recompute**;
  E4 = quiet *"Sparks are paused. Your vault is fully available."* + **Retry**, never a modal, and already-offered
  cards stay judgeable (`FLOW.md` §5.6).
- [ ] **Step 5: `Recompute` writes a `PENDING` `spark_run` row through `core/vault`** — the app must not import
  the engine to trigger a run (§4.1, invariant 2). Task 7's guard is what proves it.
- [ ] **Step 6: Run the tests — PASS**, typecheck, lint, commit
  (`feat(app): the E0–E4 band and the no-key arm`).

### Task 6: Vault (S3), detail (S4), fork (S5), iterate (S6)

**Files:**
- Create: `app/src/screens/{Vault,IdeaDetail,Fork,Iterate}.tsx`
- Test: `app/src/screens/lineage-view.test.ts` (pure projection only)

**Interfaces:**
- Consumes (from `core/vault`): `listIdeas(db, filters)` · `parseVaultFilters(query)` · `getIdeaDetail(db, id)` ·
  `forkIdea(db, id, input)` · `parseForkInput(body)` · `iterateIdea(db, id, fields)` · `deleteIdea(db, id)` ·
  `readSnapshot(db, read)`.
- Consumes (from `core/domain`): `deleteWarning(refs)` · `danglingParentId(idea, lineage)` ·
  `draftFromIdea(idea)` · `missingFields(idea)` · `needsCompletion(ideas)` · `completionPrompt(idea)` ·
  `sameDraft(a, b)`.
- Produces: `lineageView(detail: IdeaDetail)` — the one place that decides *chain* (lineage, S4's LIVING LINEAGE)
  vs *provenance* (muted, once).

- [ ] **Step 1: Write the failing projection test.** A lineage chain and a provenance pair render through
  **different** projections: the provenance ref is `muted` in the returned view and carries no brass node marker;
  a version list is **flat** and shows no connectors (`DESIGN.md` §8: borrowing lineage vocabulary for versions
  would read a version as an ancestor). Assert `iterateIdea` produces a **new version of the same id** and creates
  **no lineage edge** — the distinction is the point of the screen.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement the four screens.** Vault = cards, single column, the filter row clipping at the right
  edge as the one sanctioned horizontal scroll (`DESIGN.md` §5). S4 = fields + tags + history + delete with the
  `deleteWarning` copy. S5 = fork rejects a same-domain target **and offers Iterate** instead. S6 = the Iterate
  editor pre-filled from `draftFromIdea`, "No changes yet" CTA while `sameDraft(current, draft)`, validation on
  save, **no silent autosave** (`DESIGN.md` §8).
- [ ] **Step 4: Run the tests — PASS**, typecheck, lint, commit
  (`feat(app): vault, detail, fork and iterate`).

### Task 7: The re-homed guards — and #148

The v1 `client/src/domain/deck-interaction.test.ts` was a node-only source-text walk over `../screens/*.tsx`; it
could not move (ARCHITECTURE §13.3) and its requirement is still true. This task re-homes it as an `app/`-side
walk and closes **#148**.

**Files:**
- Create: `app/src/domain/deck-interaction.test.ts` (the source walk; **no `react-native` import**, so it runs
  under plain vitest in CI)
- Test: this file **is** the test.

**Interfaces:**
- Consumes: the resolved import surface from Task 1 (`@astrolab/core` and nothing else from the package) and the
  single `onResolve` call site in `app/src/deck.ts` (Task 4).

- [ ] **Step 1: Write the walk with its non-vacuity assertions first.**

Three claims, each with the check that stops it scanning nothing:

1. **A vault screen reaches no engine module.** Walk `app/src/**/*.{ts,tsx}`, strip comments, extract specifiers
   (all three forms — reuse the extractor shape proven in `core/test/boundary-node-adapter.test.ts`, **including
   its own self-test**). The rule is the ruled one (David, 2026-10-17): a `@astrolab/core/dist/**` specifier under
   `app/src/screens/**` or `app/src/components/**` is a violation, while the composition root and
   `app/src/{engine,provider}/**` are the allowed reach. A screen reaches engine *state* through `core/vault` reads
   (`engineState`), never by importing the engine. Non-vacuity pair: assert the walk read `>= 6` screen/component
   files, **and** drive the matcher with a literal fixture specifier
   (`import { engineFromProvider } from "@astrolab/core/dist/engine/compose.js"`) so "no offenders" is a verdict
   and not a regex that quietly stopped matching (the boundary test's own discipline — a silent matcher is the
   classic false-green).
2. **A single `onResolve` call site.** Assert `resolve(` is called from exactly one module (`app/src/deck.ts`),
   counted across the tree — a card that also called it directly is the failure.
3. **Gesture axis and thresholds come from `core`.** Assert `app/` declares no literal `48` or `10` for
   `SWIPE_DISTANCE_PX` / `TAP_SLOP_PX`, and that `deck.ts` imports them from `@astrolab/core`.

- [ ] **Step 2: Watch it fail in the state it forbids — and make it fail *only* for the right reason.**
  Plant `import { engineState } from "../core/src/engine/run.js"` in `app/src/screens/Sparks.tsx`; the walk must
  report exactly that offender. Then a second plant: a direct `resolve(...)` in `SparkCard.tsx` for claim 2.
  Restore both (`git checkout -- <file>`) and confirm green. **A green plant means the plant is broken, not that
  the guard has no hole** — there is no "one reasonable thing" here, so the plant is the evidence.
- [ ] **Step 3: Commit** (`test(app): re-home the deck-interaction guard and close #148's requirement`).

### Task 8: NFR-U1 re-homed — the onboarding completion test

v1's `api/src/nfr-u1.test.ts` drove `createApp` over HTTP; the transport retires, the **requirement** does not, and
L1's plan records the re-home as this lane's (`u1 → L2 (a completed-flow test)`). L0's lane breakdown attributes
NFR-U1 to L2 (§11: `U1 → L2`).

**Files:**
- Create: `app/src/domain/nfr-u1.test.ts`
- Test: this file **is** the test.

**Interfaces:**
- Consumes: `openStore` · `migrate` · `MIGRATIONS` · `seedDomainTaxonomy` (`core`) under a `node:sqlite`
  connection, and the app-side flow seams from Tasks 3–5 (`saveOnboardingIdea` path, `progress(summary)`,
  `bandFor(...)`).

- [ ] **Step 1: Port the three claims of the v1 file, verbatim in substance** (its shape is recoverable with
  `git show bf98e12:api/src/nfr-u1.test.ts`): (1) `>= 2` distinct **resolved** domains at exit; (2) E0 is not Cold
  on the first run; (3) the vault holds only user-authored ideas. Each keeps its **discriminating fixture** —
  notably claim 2's: *one idea spanning two clusters*, where `eligible` is true and the **idea-count arm** still
  says E0. No provider is reachable on any path exercised (`0` provider calls) — this is the NFR-A1 posture read
  from the flow, not a stub.
- [ ] **Step 2: Run it and watch it fail** (the fixtures must fail before the assertions pass — a fixture that
  cannot falsify is not evidence).
- [ ] **Step 3: Run it and watch it pass** against `node:sqlite`.
- [ ] **Step 4: Commit** (`test(app): re-home NFR-U1 as an in-process completed-flow test`).

### Task 9: The build job, and the emulator sign-off this lane owes

**Files:**
- Modify: `app/package.json` (the `build` script) · `app/src/store/expoConnection.ts` (only if Step 1 finds a gap)
- Create: `docs/RUNBOOK.md`? **No** — retired as history (§13.1). Create: `app/README.md` (the sign-off procedure)
- Test: `app/src/store/expoConnection.test.ts` (the parity test from Task 1, extended with a device row it skips)

**Interfaces:**
- Consumes: nothing new.
- Produces: the **manual sign-off record** the lane owes on #165 (L1's carry-forward criterion: *the store/vault
  suites run on a device or emulator and the result is recorded on the issue*; plan invariant 8).

- [ ] **Step 1: Make the required `build` job real for `app/` without touching `.github/`.** CI runs
  `npm run build`, which is `npm run build --workspaces --if-present` — so an `app` `build` script is picked up
  automatically and `ci.yml` needs **no** change (`ARCHITECTURE.md` §12 item 15; `AGENTS.md` §4's freeze risk).
  Verify locally: `npm run build` from the root must build `core` **and** `app`, offline, deterministic — and the
  existing built-core seed probe must still print `5730 bytes`. If `expo export --platform web` proves
  non-deterministic or network-hungry, fall back to `tsc --noEmit` **plus** a bundle smoke check and say so in the
  PR — a `build` step that stops asserting anything is the failure this step exists to avoid.
- [ ] **Step 2: The device row.** The migration suite's device rows (`0003`/`0004` table rebuilds,
  `PRAGMA foreign_keys`, `ux_spark_live`, `ON CONFLICT`, WAL) are proven against `node:sqlite` in CI only; the
  **emulator / web-OPFS** row needs a device run (`node:sqlite` and `expo-sqlite` diverge in a way that is
  CI-green and device-broken). Add the suite entry point (`npm test -w app -- device`) and record the procedure
  in `app/README.md`.
- [ ] **Step 3: Record the sign-off — this row does not hold the lane (ruled, David 2026-10-17).** Two rows, not
  one: **web-OPFS is runnable here headless** (Playwright browsers are in the shared cache) and is recorded on
  #165 with its evidence; the **native/emulator** row is **named unrun** with the cause — no `/dev/kvm`, no
  `vmx`/`svm`, no `adb`/Android SDK on this box, so an emulator cannot run at all. It is a named, deferred
  acceptance criterion (invariant 9's pre-release device pass, now owner item **D**), not part of Done: #165 closes
  on merge, as #164 did. Do not assert a row that was not run.
- [ ] **Step 4: Commit** (`chore(app): build script, device parity row and the sign-off procedure`).

---

## Self-review

- **Spec coverage:** §1 layout → T1/T2 · §4.2 delivery (in-process events) → T5 · §4.3 degradation incl. the
  no-key arm → T5 · §6 in-process calls → T3/T4/T6 · §8 export UI → **L4** (not this lane) · §9 stack +
  native-first → T1/T9 · §11 A1 → T7, U1 → T8, P1 read posture → T5 · §12 item 15 (the `build` job) → T9 ·
  §13.3 `deck-interaction` re-home → T7 · §13.4 A1 guard's app half → T7 · `FLOW.md` §2.1 surfaces → T3–T6 ·
  `FLOW.md` §5 edge cases → Review Focus 1–5, pinned to T3/T4/T5.
- **Type consistency:** one name each for `openDatabase` · `boot` · `tokens` · `bandFor` · `resolve` · `undo` ·
  `deckBand` · `saveDraft`/`loadDraft`/`clearDraft`; `KeyStore` is **L3's** (`core/src/provider/key.ts`) and is
  consumed here only through the composition root's `keyPresent` seam — the app does not re-declare it.
- **Proportion:** this plan decides files, signatures, thresholds and the tests; it does not write the screens.

## Corrections

Amendments after the plan's first commit (`d7921bf`), each from evidence rather than preference — the L1 plan's
convention.

- **The core doors (Task 1 Step 2) — ruled A by David, 2026-10-17.** The entry stays engine-free and the reach is
  `@astrolab/core/dist/engine/…` / `@astrolab/core/dist/provider/…`. Two alternatives were priced on evidence and
  dropped: a committed shim pair at the package root (`core/engine.js` + `core/engine.d.ts`) — verified working
  end to end, but it adds two hand-kept files for no gain once the ruling landed — and a **source** subpath, which
  would make Metro compile `core`'s TS with NodeNext `.js` specifiers and put two instances of `core`'s modules in
  one bundle.
- **Why the type plane needs `paths` — and it is not build order (Task 1 Step 2/3).** `core`'s build emits **no**
  declarations (`find core/dist -name '*.d.ts' | wc -l` → `0`), so a `dist/` specifier has no types **even with**
  `core/dist` present; a probe fails `TS7016`. `app/tsconfig.json` therefore maps `@astrolab/core/dist/*` →
  `../core/src/*`. Recorded because the shorthand *"build `core` before typechecking `app`"* reads like a fix and
  is not one.
- **`workspaces` order (Task 1 Step 3).** `["app","core"]` → `["core","app"]`: the app bundles `core`'s `dist/`,
  and root `build` runs the workspaces in **array** order (David, reproduced on a throwaway monorepo). L2 lands
  first, so the edit is L2's.
- **The entry is not a union, and its shape is now measured (Task 1 Step 2).** 15 cross-module export-name
  collisions — 13 of them `./types.ts` against `./vault/**` (identical fields, distinct declarations) — mean a
  wildcard re-export would drop every one of them silently. The entry is therefore store ∪ vault ∪ domain, with
  `./types.ts`, `./vault/metrics.ts`, `./vault/metrics-report.ts` and `./domain/deck-stream.ts` deliberately off it,
  and `core/test/entry-surface.test.ts` guards the set.
- **Task 7's rule restated** from a pattern list to a directory-scoped specifier rule, so it bites on the door
  names that actually exist rather than on a guess about which specifier the engine arrives on.
- **E4's cause vocabulary** (`RunFailureCause`: `no-key` · `invalid-key` · `offline` · `timeout` · `rate-limited` ·
  `cors-blocked` · `invalid-output`) lands in `core/src/types.ts` with L3's T4, because `vault → provider` is
  forbidden while `vault/engine-state.ts` is what reports E4. Task 5's arm consumes `keyPresent` until then.

## What this lane does not decide (and who does)

| Item | Owner | Why it is not in this plan |
| :--- | :--- | :--- |
| `KeyStore` adapters (`expo-secure-store` / web session memory) and the foreground run driver | **L3** (`app/src/provider/*`, `app/src/engine/runScheduler.ts`) | L2 lands the seam (`keyPresent`, a no-op driver) so E4's no-key arm is exercisable before L3's app half; L3 replaces the stubs on the same branch ordering already agreed (`#166`). L3's app half imports the engine/provider through the ruled built door (`@astrolab/core/dist/{engine,provider}/…`, Task 1 Step 2); the E4 **cause** vocabulary (`RunFailureCause` in `core/src/types.ts`) is L3's, so Task 5's no-key arm keys off `keyPresent` until then |
| `app/app.json` backup exclusion (`allowBackup=false`, `NSURLIsExcludedFromBackupKey`) | **L4** (`#167`) | L4 modifies this file; L2 must land it so the L4 edit is **additive** — flag in the PR |
| Export / Import screens | **L4** (`#167`) | `core/export.exportVault` is L4's codec; the app UI lands with it |
| A local spark-quality readout in S1/S3 | **owner queue** (ARCHITECTURE §12 item 12) | user-facing behaviour; routed, not invented |
| The web export paging under the 1 MiB sync cap | **L4** (invariant 10) | L2's web row only asks that sync reads are row-bounded |
