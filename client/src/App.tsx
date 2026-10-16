import { EmptyState } from "./components/EmptyState.tsx";
import {
  TABS,
  forkParentIdFromPath,
  ideaIdFromPath,
  iterateIdFromPath,
  matchScreen,
  routeHref,
  seedSparkIdFromPath,
  sparkIdFromPath,
  useHashPath,
} from "./router.ts";
import { Capture } from "./screens/Capture.tsx";
import { Fork } from "./screens/Fork.tsx";
import { IdeaDetail } from "./screens/IdeaDetail.tsx";
import { Iterate } from "./screens/Iterate.tsx";
import { Onboarding } from "./screens/Onboarding.tsx";
import { SparkDetail } from "./screens/SparkDetail.tsx";
import { Sparks } from "./screens/Sparks.tsx";
import { Vault } from "./screens/Vault.tsx";

/**
 * The shell — the bottom nav, the shared frame, and the route table.
 *
 * V8 filled S2, S3 and S4 (plus the per-id S4 route), O3 filled S0, O4 `#24` gives S1 its E0
 * branch (`screens/Sparks.tsx`; the deck is K2 `#36`), K3 `#37` adds S1b (`#/sparks/<id>`), #119
 * adds the seeded S2 (`#/capture/<spark_id>`), and V9 `#20` adds S5's and S6's per-id routes
 * (`#/fork/<id>`, `#/iterate/<id>`). All five per-id routes are resolved **first**: `#/ideas/<id>`,
 * `#/sparks/<id>`, `#/capture/<id>`, `#/fork/<id>` and `#/iterate/<id>` are each not one of `SCREENS`
 * (whose S4 entry is the bare `#/ideas`, whose S1 entry is `/`, and whose S2/S5/S6 entries are the bare
 * `#/capture`, `#/fork` and `#/iterate`), so `matchScreen` alone would call them a not-found.
 */
export function App() {
  const path = useHashPath();
  const ideaId = ideaIdFromPath(path);
  const sparkId = sparkIdFromPath(path);
  const seedId = seedSparkIdFromPath(path);
  const iterateId = iterateIdFromPath(path);
  const forkParentId = forkParentIdFromPath(path);
  const screen = matchScreen(path);

  // D8 — S4 is reached from the Vault, so the Vault tab is the active tab on `#/ideas`,
  // `#/ideas/<id>`, and the S5/S6 routes reached from it (`#/fork`, `#/fork/<id>`, `#/iterate`,
  // `#/iterate/<id>` — V9 `#20`), the bare compositions included, since each is the same "choose one
  // from the vault" landing the bare `#/ideas` is: a screen with no tab of its own must not read as
  // "nowhere". S1b follows the same rule towards the deck it was
  // opened from — the Sparks tab stays lit — and the seeded S2 keeps the Capture tab lit, since it is S2.
  //
  // S0 is the exception and deliberately so: it is the **first-run entry**, reached before home
  // (`FLOW.md` T01/T05), so no tab is active on it — the tab bar stays usable, but lighting "Sparks"
  // or "Add" while the user is still onboarding would claim a position in the app they have not taken.
  const vaultScreen =
    ideaId !== null ||
    iterateId !== null ||
    forkParentId !== null ||
    screen?.id === "S4" ||
    screen?.id === "S5" ||
    screen?.id === "S6";
  const activeTab =
    sparkId !== null
      ? TABS.find((tab) => tab.id === "S1")
      : seedId !== null
        ? TABS.find((tab) => tab.id === "S2")
        : vaultScreen
          ? TABS.find((tab) => tab.id === "S3")
          : screen;

  return (
    <div className="app">
      <main className="screen">
        {sparkId !== null ? (
          <SparkDetail id={sparkId} />
        ) : seedId !== null ? (
          <Capture sparkId={seedId} />
        ) : ideaId !== null ? (
          <IdeaDetail id={ideaId} />
        ) : iterateId !== null ? (
          <Iterate id={iterateId} />
        ) : forkParentId !== null ? (
          <Fork parentId={forkParentId} />
        ) : screen?.id === "S0" ? (
          <Onboarding />
        ) : screen?.id === "S1" ? (
          <Sparks />
        ) : screen?.id === "S2" ? (
          <Capture />
        ) : screen?.id === "S3" ? (
          <Vault />
        ) : screen?.id === "S4" ? (
          <>
            <h1 className="screen__title">Idea detail</h1>
            {/* D10 — a bare `#/ideas` has no id to show; it composes a choice, never a blank. */}
            <EmptyState
              title="Choose an idea."
              body="Open one from the vault to read its fields, its lineage and its provenance."
              action={{ label: "Go to the vault", href: "#/vault" }}
            />
          </>
        ) : screen?.id === "S5" ? (
          // E3's entry: bare `#/fork` carries no parent, so S5 composes the parent picker rather than
          // forking nothing (§4.7 needs a parent id).
          <Fork />
        ) : screen?.id === "S6" ? (
          <>
            <h1 className="screen__title">Iterate</h1>
            {/* T22 is S4 → S6, so a bare `#/iterate` names no node. It composes a choice — the bare
                `#/ideas` D10 rule — rather than an editor over nothing. */}
            <EmptyState
              title="Choose an idea to refine."
              body="Iteration writes a version of one idea, not a branch — open it from the vault."
              action={{ label: "Go to the vault", href: "#/vault" }}
            />
          </>
        ) : (
          <section className="placeholder">
            <p className="placeholder__id">
              {screen ? `${screen.id} · ${screen.title}` : "Not found"}
            </p>
            <h1>{screen ? screen.title : "Not found"}</h1>
            <p>
              {screen
                ? "Placeholder — this screen is not built yet."
                : `No screen at ${path || "/"}.`}
            </p>
          </section>
        )}
      </main>
      <nav className="tabbar" aria-label="Primary">
        {TABS.map((tab) => (
          <a
            key={tab.id}
            className="tab"
            href={routeHref(tab)}
            aria-current={tab === activeTab ? "page" : undefined}
          >
            {tab.title}
          </a>
        ))}
      </nav>
    </div>
  );
}
