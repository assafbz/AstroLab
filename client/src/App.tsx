import { EmptyState } from "./components/EmptyState.tsx";
import { TABS, ideaIdFromPath, matchScreen, routeHref, useHashPath } from "./router.ts";
import { Capture } from "./screens/Capture.tsx";
import { IdeaDetail } from "./screens/IdeaDetail.tsx";
import { Vault } from "./screens/Vault.tsx";

/**
 * The shell — the bottom nav, the shared frame, and the route table.
 *
 * V8 fills S2, S3 and S4 (plus the per-id S4 route); S0/S1/S5/S6 stay placeholders until their own
 * issues land. The per-id route is resolved **first**: `#/ideas/<id>` is not one of `SCREENS`
 * (whose S4 entry is the bare `#/ideas`), so `matchScreen` alone would call it a not-found.
 */
export function App() {
  const path = useHashPath();
  const ideaId = ideaIdFromPath(path);
  const screen = matchScreen(path);

  // D8 — S4 is reached from the Vault, so the Vault tab is the active tab on both `#/ideas` and
  // `#/ideas/<id>`: a screen with no tab of its own must not read as "nowhere".
  const onS4 = ideaId !== null || screen?.id === "S4";
  const activeTab = onS4 ? TABS.find((tab) => tab.id === "S3") : screen;

  return (
    <div className="app">
      <main className="screen">
        {ideaId !== null ? (
          <IdeaDetail id={ideaId} />
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
