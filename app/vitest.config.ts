import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// The app's suite runs in **plain Node** — pure logic and the composition root (tokens, the adapter's
// mappings, the boot sequence over `node:sqlite`). `expo-sqlite` is a native module: any test that
// needs it is a `*.device.test.ts`, excluded here and run with the lane's device procedure (Task 9).
const coreSrc = fileURLToPath(new URL("../core/src", import.meta.url));

export default defineConfig({
  resolve: {
    // Tests read `core` from **source**, so an app test never needs `core/dist` to exist. This mirrors
    // the app tsconfig's `paths` (`@astrolab/core/dist/*` → `../core/src/*`) — the same
    // `types: src` / `main: dist` duality the entry already lives with. It changes no shipped specifier:
    // Metro resolves `@astrolab/core` to the built `dist/` entry, and only these two specifier shapes
    // are rewritten here.
    alias: [
      { find: /^@astrolab\/core$/, replacement: `${coreSrc}/index.ts` },
      { find: /^@astrolab\/core\/dist\/(.*)$/, replacement: `${coreSrc}/$1` },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "src/**/*.device.test.ts"],
  },
});
