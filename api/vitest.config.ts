import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * The `api` workspace consumes `@astrolab/store`, whose package entry is the emitted `dist/` — the
 * shape the API and the worker load at runtime (`node dist/index.js`, `npm start`). Tests must not
 * depend on a prior `npm run build`, and CI runs `npm test` before `npm run build`, so here the
 * import resolves to the store's **source** instead.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@astrolab/store": fileURLToPath(new URL("../store/src/index.ts", import.meta.url)),
    },
  },
});
