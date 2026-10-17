/**
 * `core/` — everything portable: the store, the vault use-cases, the domain modules and the engine,
 * consumed by the Expo app and compiled by `tsc` (`ARCHITECTURE.md` §1, §2;
 * `docs/superpowers/plans/2026-10-17-l1-l4-local-only-rebuild.md`).
 *
 * Two rules hold for this surface. The **device supplies the engine**: the port's types are exported
 * and the `node:sqlite` adapter deliberately is not, so the app bundle cannot reach it
 * (`core/test/boundary-node-adapter.test.ts`). And the **composition root is the app**: it opens the
 * connection, the key store and the engine driver, and hands them in.
 *
 * The entry is the app's **only** import surface for the vault and the domain. `engine/` and
 * `provider/` are deliberately absent: they are reached through their built door
 * (`@astrolab/core/dist/…`), and the app-side guard (`app/src/domain/deck-interaction.test.ts`)
 * exists so a screen cannot take them. L2 (#165) widened this entry for the app; the exclusions and
 * their reasons are at the bottom of this file.
 */
export * from "./store/index.js";

// The vault use-cases (`ARCHITECTURE.md` §6 — v1's HTTP surface, transport stripped): create / read /
// iterate / fork / delete, decisions, undo, the deck read, the state read, the summary, inspire.
export * from "./vault/capture.js";
export * from "./vault/decision.js";
export * from "./vault/delete.js";
export * from "./vault/engine-state.js";
export * from "./vault/fork.js";
export * from "./vault/idea.js";
export * from "./vault/ideas.js";
export * from "./vault/inspire.js";
export * from "./vault/iterate.js";
export * from "./vault/sparks.js";
export * from "./vault/undo.js";
export * from "./vault/vault-summary.js";

// The pure domain rules (`ARCHITECTURE.md` §1): capture validation, completion, spread gate,
// onboarding, deck band, the gesture thresholds, lineage, the delete warning, the run trigger. No IO,
// no framework, no provider.
export * from "./domain/capture.js";
export * from "./domain/completion.js";
export * from "./domain/decision.js";
export * from "./domain/deck-interaction.js";
export * from "./domain/deck-state.js";
export * from "./domain/delete-warning.js";
export * from "./domain/lineage.js";
export * from "./domain/onboarding.js";
export * from "./domain/run-trigger.js";
export * from "./domain/spread-gate.js";
export * from "./domain/taxonomy.js";

/**
 * Four modules are deliberately **not** re-exported, and the reasons *are* this entry's shape:
 *
 * - **`./types.ts`** — the shared contract `./vault/**` and `./domain/**` compile against. It declares
 *   `Idea` · `IdeaVersion` · `IdeaFields` · `IdeaDetail` · `VaultFilters` · `VaultSummary` · `Spark` ·
 *   `SparkDetail` · `InspireSeed` · `Decision` · `CaptureInput` · `EngineState` · `ProvenanceRef`
 *   **in parallel** with the vault modules' own declarations of the same thirteen names: identical
 *   fields, distinct declarations — a v1 inheritance (`client/src/api/types.ts` rode alongside the
 *   route handlers), not a rebuild defect, and not this lane's to refactor. A wildcard union drops
 *   every one of those names **silently**; a union with a preference would put two meanings of `Idea`
 *   in one namespace. The vault modules are the ones the app calls, so they are the ones on the entry.
 * - **`./vault/metrics.ts` · `./vault/metrics-report.ts`** — the NFR-Q1 instrument and its monthly
 *   reports. They collide with each other on `MonthlyCount`, and neither is app surface: metrics are
 *   computed locally with no telemetry, and a *user-visible* readout is the owner's call
 *   (`ARCHITECTURE.md` §12 item 12, still open).
 * - **`./domain/deck-stream.ts`** — the retired v1 SSE-plus-poll transport (`ARCHITECTURE.md` §4.2:
 *   "both retire"). Nothing in `core/` imports it; leaving it off the entry is what keeps the app from
 *   picking a timer back up (`AGENTS.md`, *Harness overrides* 1 — never sleep or poll).
 *
 * `app/src/domain/deck-interaction.test.ts` asserts that every one of the included modules' exported
 * names is reachable from here, so a name dropped by a future wildcard cannot pass unnoticed.
 */
