import { TABS, matchScreen, routeHref, useHashPath } from "./router.ts";

/**
 * The shell — one placeholder per screen plus the bottom nav. No screen is built here; S2/S3/S4
 * are V8. The chrome (nav, gutters, tokens) is what V7 delivers.
 */
export function App() {
  const path = useHashPath();
  const screen = matchScreen(path);

  return (
    <div className="app">
      <main className="screen">
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
      </main>
      <nav className="tabbar" aria-label="Primary">
        {TABS.map((tab) => (
          <a
            key={tab.id}
            className="tab"
            href={routeHref(tab)}
            aria-current={tab === screen ? "page" : undefined}
          >
            {tab.title}
          </a>
        ))}
      </nav>
    </div>
  );
}
