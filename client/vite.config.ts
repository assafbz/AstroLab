import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Dev-only stand-in for the deployment's single-host shape (ARCHITECTURE.md §1).
    // The prefix is the frozen contract's (ARCHITECTURE.md §6) — bare /v1, no /api.
    proxy: { "/v1": "http://localhost:8080" },
  },
});
