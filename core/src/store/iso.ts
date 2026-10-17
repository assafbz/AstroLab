/**
 * docs/API.md §1 — ISO-8601 UTC, e.g. `2026-10-13T05:14:05Z`. The one timestamp shape the vault
 * rows (`core/src/vault/capture.ts`) and the run rows (`runs.ts`) share, so the two writers cannot drift.
 */
export function isoTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
