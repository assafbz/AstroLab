# Design System: Astrolab (Mobile)

> **Nightfall — dark, mobile-first, shadcn-based. One accent: aged brass.**
>
> **Vocabulary:** the engine is **the Spark**; its outputs are **sparks**. *(Never "collision.")*

---

## 1. Visual Theme & Atmosphere

A night sky, not a workspace. Deep indigo-black canvas, layered surfaces, one warm accent. The name is
earned: **ideas are stars, and a spark is a brass arc drawn between two distant ones.** The drama comes from
Geist display type and deep negative space — never from decoration.

- **Density:** 4 / 10 — *Daily App Balanced.*
- **Variance:** 5 / 10 — mobile is single-column; asymmetry lives in the deck and the star chart, not in split screens.
- **Motion:** 6 / 10 — *Fluid,* restrained.

**Governance principle — "judge the idea, not the pairing."** A spark is offered *as an idea*, and the user
answers exactly one question: **is it good?** The UI never scores, ranks, or explains the *similarity* of two
source ideas — no distance or alignment readout, no "related ideas", nothing that reads as a recommendation
feed. Provenance (which ideas a spark came from) is recorded data; it appears once, muted, on **Idea
Detail** — never as the headline of the judgement.

---

## 2. Color Palette & Roles

Two families: **indigo structure** (surfaces, hairlines, atmosphere) and **brass accent** (the only pressable
colour). Indigo is never an accent; brass is never a surface.

| Token | Value | Role |
| :--- | :--- | :--- |
| **Canvas** | `#080A12` | App background. Never pure `#000000`. |
| **Card** | `#10131F` | Card and sheet fill. |
| **Raised** | `#1E2336` | Chips, badges, inner surfaces, segmented controls. |
| **Hairline** | `#2A3049` | 1px structural lines, card borders, separators. |
| **Ink** | `#EAEDF7` | Primary text. |
| **Muted** | `#A9B0C8` | Secondary text, body copy at rest. |
| **Dim** | `#7C87A3` | Section labels, metadata, timestamps. |
| **Faint** | `#5C6684` | Placeholders, disabled, the quietest mono meta. |
| **Primary — Aged Brass** | `#D69A4E` | **The single accent.** Primary action fill, active states, focus rings. Label on brass: `#0A0C15`. |
| **Brass Highlight** | `#F1CB8C` | Brass text on dark (ghost actions, active chip labels), star points. |
| **Brass Deep** | `#7E5218` | Brass shadow and pressed states. |
| **Indigo (structural)** | `#4A55A0` | Atmosphere, depth, and the astrolabe rings — backgrounds only, never a control, never text on a control. |
| **Outline** | `#39405E` | Outline-button and input borders. |
| **Nav** | `#0A0C15` | Bottom tab bar surface — one step lighter than canvas. |
| **Destructive** | `#E5484D` | Validation and delete only. Not decorative. |

**Geometry:** corners are **8px** on cards, buttons and inputs; chips are fully rounded. The Stitch asset is pinned at
`ROUND_EIGHT` — `ROUND_TWELVE` was tried twice and silently reverted server-side — so **8px is the system value
in both places**.

**Atmosphere:** a soft brass light pool behind the active surface, plus a cool indigo depth in the opposite
corner — two low-opacity radial washes. This is the one sanctioned gradient, and it is a *background*.

**Banned:** gradients on text; neon or outer glow; pure black `#000000`; any **second accent**; brass as a
large surface fill; indigo on a control.

---

## 3. Typography Rules

- **Display / Headings:** **Geist** — tight tracking, hierarchy by weight and size.
- **Body / UI:** **Geist** — comfortable leading, `#A9B0C8` at rest on dark.
- **Mono:** **JetBrains Mono** — domain tags, idea ids, counters, section labels, lineage metadata.
- **Banned:** `Inter`; all serifs; `Public Sans` (a Stitch substitution — reject on sight); emoji anywhere.

---

## 4. Component Stylings (shadcn, dark)

- **Button.** *default* — brass fill, `#0A0C15` label (the Stitch asset records this as `on-brass: #0B0B0C`; the two are visually
  identical near-blacks and either is acceptable); *outline* — 1px `#39405E` on transparent; *ghost* —
  brass-highlight text. **8px radius**, min height 44px, visible pressed state. No glow.
- **Card.** `#10131F` fill, 1px `#2A3049` border, 8px radius. Borders over shadows — the system ships no
  drop shadows.
- **Badge / chip.** Domain tags as rounded-full chips: `#1E2336` fill, `#2A3049` stroke, `#A9B0C8` mono
  label. Active chip: brass tint fill (brass at 14%), brass stroke at 50%, `#F1CB8C` label.
- **Input.** Label **above** (mono, `#7C87A3`), helper optional, error below in Destructive. `#0E111C` fill,
  `#2A3049` border, brass focus ring. No floating labels.
- **Navigation.** Bottom tab bar — Sparks / Vault / Add. Active tab = brass dot + brass label.
- **Loaders.** Skeletal shimmer at Card dimensions — **no circular spinners.**
- **Empty States.** Composed, prompting — never a bare *"No ideas yet."*

**Signature — the Spark Card.** The home component: one proposed spark, presented **as an idea**.

1. **The idea** — the headline (Geist, 21/600), up to three lines.
2. **The claim** — one or two lines on why it matters.
3. **First step** — the smallest next move.
4. **Domain tags** — mono chips.
5. **Actions** — **Good** (accept: it becomes an idea in the vault) and **Not for me**, plus a one-step
   **undo**. Both directions also work as swipe gestures (right = good, left = not for me); the explicit
   buttons stay, at 44px or more, for discoverability and accessibility.

**No origin line, no distance or alignment readout, no shared-mechanism panel on the card.** The sources are
recorded, not displayed.

---

## 5. Layout Principles (Mobile-First)

- **Single column**, 16px gutters, safe-area aware; 8px corners on cards, buttons and inputs.
- **The home is a deck.** It opens on **"Sparks"** — one proposed idea at a time — *not* on the user's notes.
  The **Vault** (all ideas) is reached via bottom nav.
- **Bottom navigation**; sticky action bars where a screen needs one (deck actions, Capture save, Fork create).
- **44px minimum tap targets**; **never** horizontal scroll — the Vault filter row is the one deliberate
  exception, clipping at the right edge to signal more filters.
- Cards over tables; **borders over shadows.**

---

## 6. Motion & Interaction

- Restrained spring physics; **animate `transform` and `opacity` only.**
- **Swipe to judge.** In the deck: right = good, left = not for me. The card leaves on a spring; a one-step
  **undo** is always available.
- **A "good" gets a beat.** The brass arc resolves before the card commits, so accepting an idea reads as a
  decision rather than a reflex.
- **Star-chart reveal** (onboarding): idea points appear as they are captured, and brass arcs draw between
  points that are far apart.
- Perpetual micro-loops **only** on the active card.

---

## 7. Anti-Patterns (Banned)

No emoji; no `Inter`; no `Public Sans`; no serif; no pure black; no neon or outer glow; no heavy drop shadows;
no gradient text; no 3-equal-column grids; no generic placeholder names; no fake round numbers; no AI copy
clichés ("Elevate", "Seamless", "Unleash", "Next-Gen").

**Astrolab-specific:** no distance, alignment, or similarity scores anywhere in the UI; no "You might also
like" / "Related ideas" surfaces; no tag clouds as navigation; never write *collision* — the engine's output
is a **spark**; no tiny tap targets.
