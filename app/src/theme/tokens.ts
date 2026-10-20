/**
 * The Nightfall design tokens as React Native values (`DESIGN.md` §2–§3, re-scoped 2026-10-17).
 *
 * **The tokens bind; shadcn does not.** Every colour, radius and target size below is a value from
 * `DESIGN.md` §2 (palette) and §2's *Geometry* paragraph, exported under one name each so a surface
 * reads `tokens.canvas` rather than re-typing a hex literal. There is no theme context and no
 * platform branch: a value that must differ per platform is a recorded deviation, not a silent one
 * (`tokens.test.ts` carries the token list, so drift from the table is a red test).
 *
 * Indigo is structure (surfaces, atmosphere); brass is the **only** accent. Brass is never a large
 * surface fill and indigo is never a control (`DESIGN.md` §2, *Banned*). Keeping the roles in the
 * names — `primary` vs `indigo`, `onPrimary` for the label that sits *on* brass — is what lets a
 * component choose without re-deciding the rule.
 */

export const tokens = {
  // --- Indigo structure: surfaces, hairlines, atmosphere (DESIGN.md §2) ---
  canvas: "#080A12", // App background. Never pure #000000.
  card: "#10131F", // Card and sheet fill.
  raised: "#1E2336", // Chips, badges, inner surfaces, segmented controls.
  hairline: "#2A3049", // 1px structural lines, card borders, separators.
  nav: "#0A0C15", // Bottom tab bar surface — one step lighter than canvas.

  // --- Text (DESIGN.md §2) ---
  ink: "#EAEDF7", // Primary text.
  muted: "#A9B0C8", // Secondary text, body copy at rest.
  dim: "#7C87A3", // Section labels, metadata, timestamps.
  faint: "#5C6684", // Placeholders, disabled, the quietest mono meta.

  // --- Brass: the single accent (DESIGN.md §2) ---
  primary: "#D69A4E", // Aged Brass. Primary action fill, active states, focus rings.
  onPrimary: "#0A0C15", // Label on brass. (Stitch records #0B0B0C; both are accepted — §4.)
  brassHighlight: "#F1CB8C", // Brass text on dark (ghost actions, active chip labels), star points.
  brassDeep: "#7E5218", // Brass shadow and pressed states.

  // --- Structural & state (DESIGN.md §2) ---
  indigo: "#4A55A0", // Atmosphere, depth, astrolabe rings — backgrounds only.
  outline: "#39405E", // Outline-button and input borders.
  destructive: "#E5484D", // Validation and delete only. Not decorative.

  // --- Geometry (DESIGN.md §2 *Geometry*, §5) ---
  radius: 8, // Cards, buttons and inputs. Chips are fully rounded (§4) — a per-component rule.
  targetMin: 44, // Minimum tap target (§5). Never a smaller control.
} as const;

export type Tokens = typeof tokens;
