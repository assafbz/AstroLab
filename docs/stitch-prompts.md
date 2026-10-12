# Astrolab — Stitch Screen Prompts (Mobile)

Feed this into **Google Stitch** to generate the mobile-first screens. Source of truth: `DESIGN.md` (shadcn/mobile visual language) and `docs/PRD.md` (scope).

**Vocabulary:** the engine is **the Spark**; its outputs are **sparks**. Never write "collision."

## How to use

1. Create a Stitch project named **Astrolab**.
2. Paste the **Global Style** (§0) as project context / design system.
3. Paste each **Screen Prompt** (§1–§7) one at a time.

---

## §0 — Global Style (project context)

> **Astrolab** — a thinking instrument for ideas. **Light-mode shadcn/ui, mobile-first.** Single column, 16px gutters, safe-area aware.
>
> **Color:** white background; foreground `#09090B`; muted surface `#F4F4F5`; muted text `#71717A`; border `#E4E4E7`. **Exactly one accent: aged brass `#D69A4E`** — primary buttons, active states, focus rings, and the brass connector joining two ideas in a spark. Destructive `#DC2626` for validation only.
>
> **Type:** Geist (display + body); JetBrains Mono (domain tags, idea ids, counts).
>
> **Components:** shadcn — Buttons (default/secondary/outline/ghost), Card (white, 1px border, 8px radius, `shadow-sm`), Badge (rounded-full domain tags), Input (label above, error below), bottom tab bar, sticky action bar, skeletal loaders (no spinners).
>
> **Layout:** single column; bottom navigation; 44px minimum tap targets; no horizontal scroll; cards over tables; borders over heavy shadows.
>
> **Motion:** restrained springs; staggered list reveals; transform/opacity only.
>
> **Banned:** emojis; Inter; serifs; pure black; neon/glow; heavy shadows; gradient text; 3-equal-column grids; placeholder names; AI copy clichés ("Elevate", "Seamless", "Unleash", "Next-Gen"); "You might also like" / "Related ideas" surfaces; tag-cloud navigation. Never write **collision** — the engine's output is a **spark**.

---

## §1 — Home: "Sparks" review queue *(primary screen)*

The app opens **here**, not on the vault. A review queue of proposed sparks.

- **Header:** title "Sparks" (Geist) with a small count of unreviewed suggestions in mono, plus one muted line: *"Directions pairing your own ideas — keep one, or let it spark your own."*
- **Feed:** vertical list of **Spark Cards** (white, 1px zinc-200 border, 8px radius, `shadow-sm`). Each card:
  - the **proposed direction** as the headline;
  - an **origin line** — the two source ideas as small muted labels joined by a short **brass connector**, with the **shared mechanism** on one muted line;
  - actions: **Keep as is** (brass) and **Use as inspiration** (ghost), plus a quiet dismiss.
- **Bottom tab bar:** Sparks / Vault / Add (active tab in brass).
- No "related ideas." No emoji/neon/gradients. 44px targets, no horizontal scroll.

## §2 — Spark Detail

One proposed spark, expanded.

- Top: the **proposed direction** (large Geist headline) and the shared mechanism.
- Middle: the **two source idea Cards** separated by negative space, joined by the **brass connector** — the spark's origin made explicit. Small mono readout of *domain distance* and *structural alignment* (measured data, not gauges).
- Bottom (sticky): **Keep as is** (brass) and **Use as inspiration** (outline).
- No "related ideas."

## §3 — Capture Idea

Structured capture of one idea.

- Left-aligned labels **above** inputs, no floating labels. Fields: **Core Hypothesis** (with a live mono character counter toward 280), **Problem Solved**, **Monetization / Value Angle**, **Domain tag(s)** (mono pill input with removable tokens).
- When opened from "Use as inspiration," the hypothesis is **prefilled** with the spark and a muted banner reads *"Seeded from a spark — make it yours."*
- Inline validation below fields in `#DC2626`. One brass CTA **Save to vault**.

## §4 — The Vault

All of the user's ideas.

- Header "Vault" + muted idea count in mono.
- Horizontally scrollable filter row: domain tags as rounded-full Badges (one active in brass tint) + lineage filter (Root / Iteration / Fork).
- Vertical list of idea **Cards**: Core Hypothesis as the title, domain tags as Badges, a lineage chip, muted mono metadata (timestamp, idea id).
- Bottom tab bar. No "related ideas."

## §5 — Idea Detail + Lineage

- Main: the idea's fields, domain tags as Badges.
- Below: **Living Lineage** as a vertical measured chain — what it forked/iterated from above, what derived from it below — hairlines with small brass node markers, mono labels.
- Actions: **Iterate** (ghost) and **Fork** (brass).

## §6 — Fork

- The **parent idea** shown dimmed at top.
- A field for the **mutation delta** (helper text suggesting phrasing like *"Forking this … into …"*).
- A **domain selector** defaulting to a **different** domain than the parent, with a soft nudge toward a new domain.
- One brass CTA **Create fork**.

## §7 — Onboarding / Bootstrap

The empty vault *is* the onboarding.

- One cross-domain prompt at a time — *"An idea from your work", "A frustration nobody has fixed", "A domain you have never touched"* — with a single minimal field.
- A growing **star-chart map** of ideas captured so far, visibly widening as domains are covered. Progress shown as **domains covered** (mono), not numbered steps.
- One brass CTA **Add idea**; quiet skip link. No AI-generated suggested ideas.
