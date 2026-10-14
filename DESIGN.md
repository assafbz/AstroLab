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

---

## 9. Screen Composition — S1 (Sparks): the engine states E0–E4

**S1 is the home and the review queue** (`FLOW.md` §2.1) — the deck, one proposed spark at a time, with
**View all** (list) as the escape hatch and **Recompute** as the manual re-run. The engine's availability of
sparks is a five-state machine — **E0 Cold · E1 Computing · E2 Ready(n) · E3 Exhausted · E4 Unavailable**
(`FLOW.md` §4.1) — and *which* state S1 shows is a property of the **vault and the engine**, not a client
choice: the client renders whatever the evaluation returns. This section draws each state, so the deck is
never a bare spinner, a bare empty box, or a blocking error.

**Frame.** Single column, 16px gutters, safe-area aware (§5). The header keeps §1's shape — the title
**Sparks** in Geist, the unreviewed count in JetBrains Mono (`3 / 12`), one muted line beneath it. The
**bottom tab bar** (Sparks / Vault / Add) never moves. Every state below composes into the **same band** the
card occupies — between header and nav — so the frame stays constant and the state changes only its
contents. **No state is a modal, and no state covers the chrome.**

**The card is the unit of E2.** The signature **Spark Card** (§4) is what the deck shows one at a time, with
**Good** / **Not for me** and a one-step **undo**; both directions also work as swipes (§6). Its shape —
THE IDEA · THE CLAIM · FIRST STEP · domain chips — and its ban on any origin/similarity line are unchanged
here.

**The five states.** Each is *composed* (§4, Empty States) — a screen that keeps working, never a bare
"No ideas yet."

| Ref | State | S1 draws |
| :-- | :---- | :------- |
| **E0** | **Cold** — vault below the spark floor (**< 2 distinct *resolved* domains**) | The composition is **progress, not failure**: a centred star-chart mark with the mono readout **`domains covered x / 3`**, the one-line reason *"Sparks pair distant domains — add ideas from another field."*, and a single brass **Add idea** CTA (→ S2). **Not an error and not a global empty state** — E0 is a *breadth* state. *(A returning user whose vault was emptied lands on the same screen, plus the onboarding exit back to S0.)* |
| **E1** | **Computing** — a run is in flight | **Skeletal shimmer cards at Card dimensions** (§4, Loaders), revealed **staggered** at deck position — **never a circular spinner**. The deck stays **usable for already-offered sparks**: where E2 has cards, they remain on top, and the shimmer sits with in-flight work rather than replacing live content. |
| **E2** | **Ready(n)** — n ≥ 1 unreviewed sparks | The deck: the top card (§4). The **View all** toggle appears only when **n > 1**; the header's mono count reflects n. |
| **E3** | **Exhausted** — vault **at/above the floor**, 0 unreviewed, none computing | A composed empty state: the headline *"No sparks left — for now."*, then three CTAs — **Add idea** (S2), **Fork an idea into a new domain** (S5), and a quiet mono **Recompute** (→ E1). **At exactly 2 distinct *resolved* domains** the screen adds the **widening nudge** toward the `x / 3` target — the mono readout `domains covered 2 / 3` with the line *"One more field widens what can spark."* — shown **only** at 2: a 3+ domain vault that is exhausted gets no width nudge, because its remaining levers are Fork and Recompute. |
| **E4** | **Unavailable** — AI down (NFR-A1) | A **quiet, non-blocking** state — **not** a modal, **not** an error banner over the app: *"Sparks are paused. Your vault is fully available."* plus a single **Retry** (→ E1). **Already-offered sparks stay reviewable** — the deck's Good / Not for me keep working, because they are vault writes (NFR-A1). |

**Precedence (from §4.1).** **E0 dominates all** — with no domain spread there is no spark to compute,
review, or await, so E0 shows regardless of AI state. **E4 > E3** — a vault that is both exhausted and
unavailable shows **Unavailable** (the transient cause, with Retry), never Exhausted. **E1 may coexist with
E2** — shimmer for in-flight work sits alongside any already-offered cards; E1 is never a full-screen
takeover.

**The `x / 3` readout.** It is **progress toward the onboarding target**, never a gate: the spark floor is
**2 resolved domains** (E0's trigger) and 3 is the product target (`PRD.md` §5). The readout therefore
appears in **E0** (as the empty state's spine) and in **E3-at-2** (as the widening nudge) — and nowhere as a
blocker.

**Motion.** Restrained springs, `transform` and `opacity` only (§6). E1's shimmer is the one **perpetual
micro-loop**, and only on the active card position (§6). E1 → E2 is the staggered reveal (§6, the
star-chart family). Nothing flips, and nothing loops past the in-flight state.

**Anti-patterns, S1-specific.** **No circular spinner** (§4, Loaders; §7). No bare *"No ideas yet."* No bare
error box. No blocking modal for E4 (NFR-A1). No progress readout that reads as a gate or a score. No origin
line, no distance / alignment / similarity readout, no "related ideas" (§1 governance rule). E0 and E3 are
**states of the deck**, not navigations away from it. Everything else in §7 stands.
