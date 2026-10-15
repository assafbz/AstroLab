import { EmptyState } from "./components/EmptyState.tsx";
import {
  TABS,
  ideaIdFromPath,
  matchScreen,
  routeHref,
  sparkIdFromPath,
  useHashPath,
} from "./router.ts";
import { Capture } from "./screens/Capture.tsx";
import { IdeaDetail } from "./screens/IdeaDetail.tsx";
import { Onboarding } from "./screens/Onboarding.tsx";
import { SparkDetail } from "./screens/SparkDetail.tsx";
import { Sparks } from "./screens/Sparks.tsx";
import { Vault } from "./screens/Vault.tsx";

/**
 * The shell — the bottom nav, the shared frame, and the route table.
 *
 * V8 filled S2, S3 and S4 (plus the per-id S4 route), O3 filled S0, O4 `#24` gives S1 its E0
 * branch (`screens/Sparks.tsx`; the deck is K2 `#36`), and K3 `#37` adds S1b (`#/sparks/<id>`). S5/S6
 * stay placeholders until their own issues land. Both per-id routes are resolved **first**:
 * `#/ideas/<id>` and `#/sparks/<id>` are each not one of `SCREENS` (whose S4 entry is the bare
 * `#/ideas`, and whose S1 entry is `/`), so `matchScreen` alone would call them a not-found.
 */
export function App() {
  const path = useHashPath();
  const ideaId = ideaIdFromPath(path);
  const sparkId = sparkIdFromPath(path);
  const screen = matchScreen(path);

  // D8 — S4 is reached from the Vault, so the Vault tab is the active tab on both `#/ideas` and
  // `#/ideas/<id>`: a screen with no tab of its own must not read as "nowhere". S1b follows the same
  // rule towards the deck it was opened from — the Sparks tab stays lit.
  //
  // S0 is the exception and deliberately so: it is the **first-run entry**, reached before home
  // (`FLOW.md` T01/T05), so no tab is active on it — the tab bar stays usable, but lighting "Sparks"
  // or "Add" while the user is still onboarding would claim a position in the app they have not taken.
  const onS4 = ideaId !== null || screen?.id === "S4";
  const activeTab =
    sparkId !== null
      ? TABS.find((tab) => tab.id === "S1")
      : onS4
        ? TABS.find((tab) => tab.id === "S3")
        : screen;

  return (
    <div className="app">
      <main className="screen">
        {sparkId !== null ? (
          <SparkDetail id={sparkId} />
        ) : ideaId !== null ? (
          <IdeaDetail id={ideaId} />
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
