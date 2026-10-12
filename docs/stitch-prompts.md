# Astrolab — Stitch Screen Prompts (Mobile)

Screen-generation prompts for **Google Stitch** (or the hand-built SVG pipeline). Source of truth:
`DESIGN.md` (Nightfall visual language) and `docs/PRD.md` (scope).

**Vocabulary:** the engine is **the Spark**; its outputs are **sparks**. Never write "collision."

**Direction:** **Nightfall** — dark canvas, brass accent, indigo structure. Locked 2026-10-12.

## How to use

1. Create / open a Stitch project named **Astrolab**.
2. Paste the **Global Style** (§0) as project context / design system.
3. Paste each **Screen Prompt** (§1–§7) one at a time.

> **Rendering note:** agent-side Stitch generation currently fails (calls time out and return copies of
> existing screens). The Nightfall screens were hand-built from these prompts — SVG → PNG at 2x — and the
> sources live with David in `OUTBOX/screens/nightfall/`. The prompts below are the spec.

---

## §0 — Global Style (project context)

> **Astrolab** — a thinking instrument for ideas. **Nightfall: dark, mobile-first, shadcn-based.** Single
> column, 16px gutters, safe-area aware. 8px corners on cards, buttons and inputs (chips are fully rounded).
>
> **Surfaces:** canvas `#080A12` · card `#10131F` · raised `#1E2336` · hairline `#2A3049` · outline `#39405E`.
> **Text:** ink `#EAEDF7` · muted `#A9B0C8` · dim `#7C87A3` · faint `#5C6684`.
> **Exactly one accent: aged brass `#D69A4E`** (label on brass `#0A0C15`) — primary actions, active states,
> focus rings; **brass highlight `#F1CB8C`** for brass text on dark; **brass deep `#7E5218`** for pressed
> states. **Indigo `#4A55A0` is structural only** — atmosphere, depth, and the astrolabe rings; never a
> control, never text on a control.
> **Atmosphere:** a soft brass light pool behind the active surface plus a cool indigo depth in the opposite
> corner — two low-opacity radial washes.
>
> **Type:** Geist (display + body); JetBrains Mono (domain tags, idea ids, counters, section labels).
>
> **Components:** shadcn — Buttons (default brass / outline / ghost), Card (`#10131F`, 1px `#2A3049`, 8px),
> Badge (rounded-full domain chips), Input (label above in mono, error below), bottom tab bar, sticky action
> bar, skeletal loaders (no spinners).
>
> **Layout:** single column; bottom navigation; 44px minimum tap targets; no horizontal scroll; cards over
> tables; borders over shadows.
>
> **Motion:** restrained springs; transform/opacity only; deck swipes; staggered star-chart reveals.
>
> **Banned:** emoji; Inter; Public Sans; serifs; pure black; neon/glow; heavy shadows; gradient text;
> 3-equal-column grids; placeholder names; AI copy clichés ("Elevate", "Seamless", "Unleash", "Next-Gen");
> "You might also like" / "Related ideas" surfaces; tag-cloud navigation; **any distance, alignment, or
> similarity readout**. Never write **collision** — the engine's output is a **spark**.

---

## §1 — Home: "Sparks" deck *(primary screen)*

The app opens **here**, not on the vault: a deck of proposed sparks, **one idea at a time**.

- **Header:** title "Sparks" (Geist) with an unreviewed count in mono (`3 / 12`), and one muted line:
  *"Swipe right if it's good, left if it isn't."*
- **The card** (the signature component), in this order:
  1. mono label **THE IDEA**, then the idea as the headline (Geist, 3 lines max);
  2. hairline, then mono label **THE CLAIM** and one or two lines of rationale;
  3. mono label **FIRST STEP** and the smallest next move;
  4. **domain tags** as mono chips.
- **Actions:** **Not for me** (outline) and **Good** (brass, the only filled brass on the screen), both
  44px+; a quiet mono **`↩ undo last`**; swipe hints `← not for me` / `good →`.
- **No origin line. No distance / alignment / similarity readout. No shared-mechanism panel.**
- **Bottom tab bar:** Sparks / Vault / Add (active tab in brass).
- Motion: the card leaves on a spring; a "good" gets a beat — the brass arc resolves before it commits.

## §2 — Idea expanded

One proposed spark, opened from the deck by tapping the card.

- Top: the **idea** as a large Geist headline; **domain tags** beneath.
- **THE CLAIM** (ink) — why it matters.
- **WHAT IT WOULD TAKE** (muted) — the honest cost.
- **FIRST STEP** (muted).
- One muted mono **provenance** line at rest: `SPARKED FROM  idea 02:31 + idea 09:14`. Recorded data —
  it is *not* a similarity score, and it never gets a headline.
- Sticky bottom, three paths: **Make it mine — capture it as your own** (ghost, brass text) · **Not for me**
  (outline) · **Good** (brass).
- No "related ideas", no numbers.

## §3 — Capture Idea

Structured capture of one idea.

- Mono labels **above** inputs, no floating labels. Fields: **Core Hypothesis** (live mono counter toward
  280), **Problem Solved**, **Monetization / Value Angle**, **Domain tag(s)** (mono pill input with removable
  tokens, plus a dashed **+ add domain** chip).
- Two entries: from **Make it mine**, the hypothesis is **prefilled** and a card with a brass edge reads mono
  **FROM A SPARK** / *"Seeded from a spark — make it yours."* From the **Add** tab, the same form opens blank.
- Inline validation below fields in `#DC2626`. One brass CTA **Save to vault**.

## §4 — The Vault

All of the user's ideas.

- Header "Vault" + muted idea count in mono.
- Search field (rounded, hairline, mono placeholder).
- Horizontally scrolling **domain** chip row (active chip in brass tint, row clipping at the right edge) and a
  **lineage** row: `root` / `iteration` / `fork`.
- Vertical list of idea **Cards**: Core Hypothesis as the title (Geist), domain tags as chips, and muted mono
  meta on the chip row — lineage + timestamp (`FORK · 04:12`).
- Bottom tab bar. **No sticky "Add idea"** — Add is the nav tab. No "related ideas."

## §5 — Idea Detail + Lineage

- Main: the idea's headline, domain chips, **THE CLAIM**, **WHAT IT WOULD TAKE**.
- Actions: **Iterate** (outline) and **Fork** (brass).
- Below: **LIVING LINEAGE** as a vertical measured chain — what it forked/iterated from above, what derived
  from it below — hairlines with brass node markers, mono labels, and a **filled brass node on *this* idea**.

## §6 — Fork

- The **parent idea** shown dimmed at top, labelled mono **PARENT**.
- A field for the **mutation delta** (helper text suggesting the phrasing *"Forking this … into …"*), with a
  mono line: *"Say what changes. The parent stays intact."*
- A **domain selector** — parent domain dimmed, an arrow, and a suggested **different** domain in brass tint,
  with the nudge: *"Pick a domain you haven't used — forks widen the vault, and a wider vault makes better
  sparks."*
- A quiet card stating what will be recorded: *"Fork of 01:07 · domain #health-data"* (single-parent lineage).
- One brass CTA **Create fork**.

## §7 — Onboarding / Bootstrap

The empty vault *is* the onboarding.

- Mono wordmark **ASTROLAB**; headline **"Your star chart"**; muted line *"Every idea is a point. Sparks draw
  the lines."*
- The **star chart**: faint astrolabe rings (hairlines) with idea points as stars — brass for captured ideas,
  pale ink for the rest — and thin **brass arcs** drawn between points that are far apart. It visibly widens
  as domains are covered.
- **Progress is domains, not steps:** mono `DOMAINS COVERED` + `2 / 3` and a three-segment bar (no numbered
  steps).
- One cross-domain prompt at a time — *"An idea from your work", "A frustration nobody has fixed", "An idea
  from a domain you've never touched"* — inside a card labelled mono **CROSS-DOMAIN PROMPT**, with a single
  minimal field (*"One sentence is enough"*).
- One brass CTA **Add idea**; a quiet mono **skip for now**. No AI-generated suggested ideas.
