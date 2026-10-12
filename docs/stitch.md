# Stitch — Project Reference

Living record of the Google Stitch artifacts for Astrolab. Keep this in sync when screens or the design system change.

---

## Project

| Field | Value |
| :--- | :--- |
| **Title** | Astrolab |
| **Project ID** | `4338030708250296192` |
| **Resource name** | `projects/4338030708250296192` |
| **Visibility** | Private |
| **Type** | PROJECT_DESIGN |
| **Origin** | STITCH |

> A previous project, `projects/16979453171935321870`, was the first (dark astrolabe) attempt and has been **deleted**.

---

## Design System

| Field | Value |
| :--- | :--- |
| **Display name** | Astrolab |
| **Asset ID** | `2228152258463041364` |
| **Resource name** | `assets/2228152258463041364` |
| **Version** | 1 |

**Theme tokens**
- Color mode: **LIGHT**; variant: NEUTRAL
- Headline font: `GEIST` · Body: `GEIST` · Label: `JETBRAINS_MONO`
- Roundness: `ROUND_EIGHT` (8px)
- Primary / custom color: `#D69A4E` (aged brass)

> ⚠️ **Stale:** this design system's embedded `designMd` still says *"collision bridge," "Collide,"* and *"The Collision Card"* — it predates the **Spark** renames. Refresh via `update_design_system`.

---

## Visual direction — **Nightfall** (locked 2026-10-12)

The chosen visual language is **Nightfall**: deep indigo-black canvas, one accent (**aged brass**), indigo as
a structural tone only. Full token set and rules: `DESIGN.md` §1/§2.

Nightfall screens are **hand-built** (SVG → PNG at 2x) because agent-side Stitch generation fails — calls time
out at ~60s and return copies of existing screens. Sources and 2x PNGs live with David in
`OUTBOX/screens/nightfall/`, in the screen-prompts order §1–§7:

| # | Screen |
| :--- | :--- |
| §1 | Sparks — the deck (swipe right = good, left = not for me) |
| §2 | Idea expanded |
| §3 | Capture (seeded from a spark) |
| §4 | Vault |
| §5 | Idea detail + lineage |
| §6 | Fork |
| §7 | Onboarding — star chart |

**Do not treat the asset's `namedColors` as canonical.** Stitch regenerates the palette from seeds, so the asset
carries tones nobody chose (e.g. `secondary #bbc3ff`, `outline #9d8e7f`, `surface #0f141a`). `DESIGN.md` §2 is the
source of truth; the asset will only ever be "close, Stitch-generated".

**Known design gap:** the flow spec (`docs/FLOW.md`, S6) has an **Iterate** surface with no visual spec here and no
screen in the set below — it is the one flow surface still unspecified. Owner: design.

**Stitch-side actions still pending (need the Stitch UI / an editable asset):**

- Project `designTheme` still says **"Collide"** — every regeneration drifts until it is corrected.
- The v3 design system swapped the mono label font for **Public Sans** (banned — must be `JETBRAINS_MONO`).
- Color mode is still **LIGHT**; Nightfall needs **DARK** (or at least a dark custom palette).
- ~~Roundness~~ — **resolved:** the asset is pinned at `ROUND_EIGHT` (a `ROUND_TWELVE` write is accepted by the
  dry run, applied, then reverted server-side), so the screens and `DESIGN.md` use **8px** too.

---

## Screens

| Title | Screen ID | Resource name | Device | Size |
| :--- | :--- | :--- | :--- | :--- |
| The Vault | `d1c61eb49e6a4e758623d82f2a60ff13` | `projects/4338030708250296192/screens/d1c61eb49e6a4e758623d82f2a60ff13` | MOBILE | 780×2678 |
| New pivots — Astrolab Home | `1999b711d2f649bf90d5f36c18586b5d` | `projects/4338030708250296192/screens/1999b711d2f649bf90d5f36c18586b5d` | MOBILE | 780×2788 |

> ⚠️ **Stale:** the home screen is titled *"New pivots"* and its origin line says *"the two ideas that collided."* Needs regeneration with **Spark** vocabulary.

---

## Vocabulary (single source of truth)

- Engine: **the Spark**
- Output: **a spark** / **sparks** (the suggested directions)
- Signature component: **Spark Card**
- Retired terms: ~~collision~~, ~~pivot~~ (as the output noun — "Pivot" survives only in the slogan `Spark. Pivot. Build.`)

---

## Source-of-truth files (in this repo)

| File | Role |
| :--- | :--- |
| `DESIGN.md` | The design system (mobile-first shadcn + brass). Mirrors the Stitch design system. |
| `docs/stitch-prompts.md` | Per-screen generation prompts (Nightfall global style + §1–§7). |
| `docs/PRD.md` | Product scope and requirements. |
| `docs/VISION.md` | Strategic layer. |

---

## Tool-call reference

- Tool arguments take the **bare ID** (no `projects/` or `assets/` prefix):
  - `projectId`: `4338030708250296192`
  - `assetId` / `designSystem`: `2228152258463041364`
  - `selectedScreenIds`: `d1c61eb49e6a4e758623d82f2a60ff13`, `1999b711d2f649bf90d5f36c18586b5d`
- `generate_screen_from_text` `designSystem` argument takes the **prefixed** form: `assets/2228152258463041364`.
- Generation calls frequently **time out at the tool level** (~60s) while continuing server-side; recover results with `list_screens` after a short wait rather than retrying.
