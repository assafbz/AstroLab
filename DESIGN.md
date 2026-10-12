# Design System: Astrolab (Mobile)

> **shadcn-based, mobile-first. One accent: aged brass.**
>
> **Vocabulary:** the engine is **the Spark**; its outputs are **sparks**. *(Never "collision.")*

---

## 1. Visual Theme & Atmosphere

Clean, neutral, tactile. A **light-mode shadcn/ui** system: white surfaces, zinc neutrals, hairline borders, 8px radius, and understated shadows. The interface stays quiet and neutral except for a single warm accent — **aged brass** — reserved for primary actions and the connector that joins two ideas in a spark. The mood is a well-organized thinking tool.

- **Density:** 4 / 10 — *Daily App Balanced.*
- **Variance:** 5 / 10 — mobile is inherently single-column; asymmetry lives in the spark layout, not split screens.
- **Motion:** 6 / 10 — *Fluid,* restrained.

**Governance principle — "Astrolab shows distance, not likeness."** The product's value is pairing ideas that are *far apart but structurally aligned*. The UI must never resemble a recommendation feed of similar items.

---

## 2. Color Palette & Roles

shadcn light tokens, neutral family, one accent.

- **Background** (`#FFFFFF`) — Canvas and Card fill.
- **Foreground** (`#09090B`, zinc-950) — Primary text. Never pure `#000000`.
- **Muted Surface** (`#F4F4F5`, zinc-100) — Secondary fills, inactive chips, skeletons.
- **Muted Foreground** (`#71717A`, zinc-500) — Secondary text, metadata, timestamps.
- **Border** (`#E4E4E7`, zinc-200) — 1px structural lines, Card borders, separators.
- **Primary — Aged Brass** (`#D69A4E`) — **The single accent.** Primary buttons, active states, focus rings, and the brass connector in a Spark Card. Foreground `#09090B`.
- **Destructive** (`#DC2626`) — Validation and delete only. Not decorative.

**Banned:** purple, blue, neon hues; gradients on text; any second accent.

---

## 3. Typography Rules

- **Display / Headings:** **Geist** — tight tracking, hierarchy by weight and size.
- **Body / UI:** **Geist** — comfortable leading.
- **Mono:** **JetBrains Mono** — domain tags, idea ids, counts.
- **Banned:** `Inter`; all serifs; emoji anywhere.

---

## 4. Component Stylings (shadcn)

- **Button.** Variants: *default* (aged-brass fill, near-black label), *secondary* (zinc-100), *outline* (1px border), *ghost*. 8px radius, visible pressed state, **min height 44px** on mobile. No glow.
- **Card.** White fill, 1px zinc-200 border, 8px radius, `shadow-sm`.
- **Badge.** Domain tags as rounded-full badges (zinc-100 fill, zinc-700 text).
- **Input.** Label **above**, helper optional, error **below** in Destructive. Focus ring in brass. No floating labels.
- **Navigation.** Bottom tab bar (Sparks / Vault / Add); a sticky action bar where a screen needs one.
- **Loaders.** Skeletal shimmer matching Card dimensions — **no circular spinners.**
- **Empty States.** Composed, prompting — never a bare *"No ideas yet."*

**Signature — the Spark Card.** The primary component of the home screen. A single **proposed spark**:

1. **Proposed direction** — the spark itself, as the card's headline (Geist).
2. **Origin line** — the two source ideas shown as small muted labels, joined by a short **brass connector**, with the **shared mechanism** on one muted line beneath.
3. **Actions** — **Keep as is** (accept: the spark becomes an idea, recorded as a fork of the pair) and **Use as inspiration** (opens Capture, seeded with the spark). A quiet **dismiss** affordance.

Brass appears on the connector and the "Keep as is" button only — **one spark per card.**

---

## 5. Layout Principles (Mobile-First)

- **Single column**, 16px gutters, safe-area aware.
- **The home is a review queue.** It opens on **"Sparks"** — a feed of Spark Cards awaiting review — *not* on the user's notes. The **Vault** (all ideas) is reached via bottom nav.
- **Bottom navigation**; sticky action bars where needed.
- **44px minimum tap targets**; **never** horizontal scroll.
- Cards over tables; **borders over heavy shadows.**

---

## 6. Motion & Interaction

- Restrained spring physics; **staggered feed reveals** — never mount the list instantly.
- **Spark reveal:** the two source-idea labels converge and the **brass connector draws** between them as the proposed direction appears.
- Perpetual micro-loops **only** on the active card.
- Animate **`transform` and `opacity` only.**

---

## 7. Anti-Patterns (Banned)

No emoji; no `Inter`; no serif; no pure black; no neon/outer glow; no heavy drop shadows; no gradient text; no 3-equal-column grids; no generic placeholder names; no fake round numbers; no AI copy clichés ("Elevate", "Seamless", "Unleash", "Next-Gen").

**Astrolab-specific:** no "You might also like" / "Related ideas" surfaces; no tag clouds as navigation (likeness is the wrong axis); never write *collision* — the engine's output is a **spark**; no tiny tap targets; no horizontal scroll.
