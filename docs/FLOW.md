# Flow Spec: Astrolab (MVP v1.0)

> **Status:** Draft for review — not yet merged.
> **Scope:** End-to-end user journey + application state machine for the MVP creative loop.
> **Vocabulary:** the engine is **the Spark**; its outputs are **sparks**. *(Never "collision.")*
> **Source of truth for scope:** `docs/PRD.md`, `docs/VISION.md`. Visual language: `DESIGN.md`.
> **Decision provenance:** the 2026-10-12 pivot in the product thread (judge the *idea*, not the pairing; swipe → **good** / ← **not for me**; a "good" spark becomes a **new root idea** with its two sources kept as **provenance**, not lineage).

---

## 0. How to read this document

This spec defines **what moves the user**, not how it is rendered. Every transition below is a row in §4 with a **named trigger**, a **destination**, and an **empty / error state**. Screen-level layout and motion belong to `DESIGN.md`.

**Known doc dependency (blocking for merge).** This spec is written against the 2026-10-12 pivot. Two upstream documents still contradict it and are being rewritten in a parallel PR:

- **`PRD.md` §3.3.2 / §3.3.5** still define the **two-axis model** (domain distance + structural alignment) and *"Keep as is … recorded as a fork of the source pair."* The flow below drops the axes and makes acceptance produce a **root** idea.
- **`DESIGN.md` §1 / §4 / §5 / §7** still describe a **light** vertical *feed* and a two-source origin line with a distance readout. The flow below assumes the **Nightfall** dark-canvas deck.

**Until those land, this file describes the intended product, not the current docs.** Reviewer: treat any divergence there as the upstream rewrite being owed, not a defect here.

---

## 1. The journey in one line

**Onboarding → Sparks deck → judge → (Vault) → iterate / fork → Capture → back to the deck.**

A spark is a *proposed direction* derived from two of the user's own ideas. The user judges **the idea itself** — good, or not for me. A **good** spark becomes a new idea in the vault; a **not for me** spark is remembered as negative signal. A **fork** widens the vault into a new domain, which is what makes the next spark possible — the flywheel from `PRD.md` §1.2.

---

## 2. Actors, surfaces, and relations

### 2.1 Surfaces (routes)

| Ref | Surface | DESIGN.md § | Role |
| :-- | :------ | :---------- | :--- |
| **S0** | Onboarding / Bootstrap | §7 | Cross-domain elicitation. The *empty vault is the onboarding*. |
| **S1** | Sparks (home) | §1 | The review **queue**. Default = **deck** (one card at a time); **View all** toggle = list. |
| **S1b** | Spark Detail | §2 | One spark expanded. |
| **S2** | Capture | §3 | Structured capture of one idea. A **seeded** variant opens from a spark. |
| **S3** | Vault | §4 | All ideas; domain + lineage filters. |
| **S4** | Idea Detail | §5 | One idea; lineage chain; provenance when present. |
| **S5** | Fork | §6 | New node branching from a parent, with mutation delta + a different domain. |
| **S6** | Iterate | — | In-place refinement of an idea; prior version retained as history. |

### 2.2 The three user actions on a spark

| Action | Gesture | Button | Core semantics |
| :----- | :------ | :----- | :------------- |
| **ACCEPT** ("Good") | swipe **right** | brass, 44px | *This idea is good.* Creates a **new root idea**; records its two sources as **provenance**. |
| **DISMISS** ("Not for me") | swipe **left** | quiet, 44px | *Not for me.* Retained as **negative signal**; the pairing is not re-offered unchanged. |
| **INSPIRE** ("Use as inspiration") | — *(no swipe axis)* | outline, 44px | Opens **S2 (seeded)**. Does **not** resolve the spark. |

**Swipe/button parity (req: §5.5).** The gesture is a **shortcut for the button, never a separate path**. Both dispatch the identical command with an identical payload; the resulting state is byte-for-byte the same. Buttons are the primary, always-visible affordance and the only accessible path — the deck is fully operable without a gesture. This must hold for ACCEPT, DISMISS, and the undo affordance.

### 2.3 Two relations — **lineage** vs **provenance** (they are not the same thing)

The pivot retires the pair-fork (decision **D1**). Lineage stays **single-parent**; the two sources of a spark attach by a *different* relation.

| Relation | Cardinality | Direction | Created by | Surfaced |
| :------- | :---------- | :-------- | :--------- | :------- |
| **Lineage** | exactly 0 or 1 parent | idea → parent | **Fork** (new node) and **Iteration** (same node, new version) | "Living Lineage" chain on **S4** |
| **Provenance** | 0..N sources | spark-derived idea → its source ideas | **ACCEPT**, and **INSPIRE** saves | muted line on **S4** (not the lineage chain) |

- A **fork** widens the vault into a new domain (`VISION.md` §4 Pillar 3). Its parent is one idea.
- An **accepted spark** is a **root** idea (no lineage parent). Its two sources are **provenance** — informational, not ancestry. This is why D1 closes: nothing requires a two-parent node.

---

## 3. Spark lifecycle

A spark instance moves through a small state machine of its own:

```
          ┌───────────┐   engine run    ┌───────────┐  shown in deck  ┌───────────┐
   none → │  PROPOSED │ ──────────────► │  OFFERED  │ ──────────────► │  REVIEWED │
          └───────────┘                 └───────────┘                 └─────┬─────┘
                                                                           │
              ACCEPT → idea created + provenance recorded  ───────────────┘
              DISMISS → negative signal recorded (pairing suppressed)
```

- **PROPOSED → OFFERED:** engine (NFR-P1, asynchronous) produces a candidate offering; it enters the deck.
- **OFFERED → REVIEWED:** the user ACCEPTs or DISMISSes. The card leaves the deck.
- **`INSPIRE` does not transition the spark** — the user may open Capture, save, and still judge the card later.
- **Undo** reverts `REVIEWED → OFFERED` and rolls back that decision's side effects (§5.4).

---

## 4. Application state machine

### 4.1 Engine states (spark availability) — drive what S1 shows

| Ref | State | Condition | S1 shows |
| :-- | :---- | :-------- | :------- |
| **E0** | **Cold** | vault **under 3 distinct domains** (or < 2 ideas). Sparks need spread: below the floor a pairing either does not exist or lands in the cliché quadrant and is suppressed (`PRD.md` §3.3.3 / §3.4). **≥ 3 distinct domains** is the product target (`PRD.md` §5). | Composed empty state, **not** an error: *"Sparks need breadth."* Progress `domains covered x/3` (mono) + **Add idea** CTA. |
| **E1** | **Computing** | engine run in flight | Skeletal shimmer **cards** matching deck dimensions; staggered reveal. **No circular spinner** (DESIGN.md §4). Deck remains usable for already-offered sparks. |
| **E2** | **Ready(n)** | n ≥ 1 unreviewed sparks | Deck: top card. List toggle if n > 1. |
| **E3** | **Exhausted** | vault eligible, 0 unreviewed, none computing | Composed empty state: *"No sparks left — for now."* CTAs: **Add idea** (S2), **Fork an idea into a new domain** (encourages the flywheel). A **Recompute** affordance. |
| **E4** | **Unavailable** | AI down (NFR-A1) | Quiet, non-blocking state: *"Sparks are paused. Your vault is fully available."* + **Retry**. Already-offered sparks stay reviewable. |

> Axis thresholds are tuning parameters (`PRD.md` §3.3.3), not fixed requirements. The **3-domain** figure is the onboarding activation target (`PRD.md` §5), used here as the Cold→Ready product target; the floor for *any* spark is the 2-domain cliché suppression (`PRD.md` §3.3.3).

### 4.2 Transition table

Every transition: **ID · From → To · trigger · guard · side effects · empty/error state.**

#### Onboarding (S0)

| ID | From → To | Trigger | Guard | Side effects | Empty / error state |
| :-- | :-------- | :------ | :---- | :----------- | :------------------ |
| **T01** | launch → **S0** | first run | vault is **empty** | none | — |
| **T02** | S0 → S0 | **Add idea** (one prompt at a time) | Hypothesis non-empty | node created; star-chart widens; `domains covered` updates | inline error below field (Destructive) if empty |
| **T03** | S0 → **S1** | **Skip** | — | — | if vault in **E0** → S1 shows **E0 Cold**; else → **E1 Computing** |
| **T04** | S0 → **S1** | **See your sparks** CTA appears | vault ≥ 3 distinct domains | kick engine run | — |
| **T05** | launch → **S1** | return launch | vault was **not** empty | evaluate engine state | E0/E1/E2/E3/E4 per §4.1 |

#### Sparks deck (S1) and Spark Detail (S1b)

| ID | From → To | Trigger | Guard | Side effects | Empty / error state |
| :-- | :-------- | :------ | :---- | :----------- | :------------------ |
| **T06** | S1 → S1 | open deck | vault eligible, no run in flight | render top offered spark | E0/E3/E4 states per §4.1 |
| **T07** | **E1 → E2** | engine results arrive *(async, NFR-P1)* | ≥ 1 candidate passes the surface rule | cards enter deck; staggered reveal | 0 pass → **E3 Exhausted** |
| **T08** | S1 → **S1b** | tap card | — | expand the spark | — |
| **T09** | S1 → **S2 (seeded)** | **INSPIRE** button | — | Capture prefilled with the proposed direction; banner *"Seeded from a spark — make it yours."* | — |
| **T10** | S1 → S1 | **ACCEPT** *(swipe right / brass button)* | — | see §4.3 | — |
| **T11** | S1 → S1 | **DISMISS** *(swipe left / quiet button)* | — | see §4.3 | — |
| **T12** | S1 → S1 | **Undo** within window | last decision reversible (§5.4) | roll back last decision; restore card | undo unavailable (silent) outside window / after edit |
| **T13** | S1 → **S1 (list)** | **View all** toggle | ≥ 1 unreviewed | switch deck ↔ list | n = 0 → E3 |
| **T14** | S1 → **E1** | **Recompute** / vault changed | — | engine run | E4 if AI down |

#### Capture (S2)

| ID | From → To | Trigger | Guard | Side effects | Empty / error state |
| :-- | :-------- | :------ | :---- | :----------- | :------------------ |
| **T15** | any → **S2** | **Add** tab, or INSPIRE | — | open blank / seeded capture | — |
| **T16** | S2 → origin | **Save to vault** | all mandatory fields valid (`PRD.md` §2; §3.1) | idea created. If **seeded**: root idea + **provenance** = the spark's two sources. Else: plain root idea. | — |
| **T17** | S2 → S2 | **Save** with invalid/empty mandatory field | — | — | inline errors below fields; CTA blocked; counter toward 280 (`PRD.md` §2) |
| **T18** | S2 → **E1** | save succeeds | vault crossed the eligibility threshold | invalidate + recompute sparks | — |

#### Vault (S3), Idea Detail (S4), Fork (S5), Iterate (S6)

| ID | From → To | Trigger | Guard | Side effects | Empty / error state |
| :-- | :-------- | :------ | :---- | :----------- | :------------------ |
| **T19** | S1 → **S3** | **Vault** tab | — | list ideas | vault empty → composed empty state with **Add idea** CTA |
| **T20** | S3 → S3 | filter by domain / lineage | — | list narrows | no match → filtered-empty: *"No ideas in ⟨domain⟩."* |
| **T21** | S3 → **S4** | tap idea card | — | open detail; render fields, lineage chain, provenance if any | — |
| **T22** | S4 → **S6** | **Iterate** | — | open in-place editor | — |
| **T23** | S6 → **S4** | **Save iteration** | Hypothesis non-empty | same node, new version; prior version retained as history (`PRD.md` §3.2.1) | inline error if empty |
| **T24** | S4 → **S5** | **Fork** | — | open Fork, seeded with parent | — |
| **T25** | S5 → **S4** | **Create fork** | mutation delta non-empty | **new** node; lineage parent = source; domain defaults **different** (nudge) | inline error if delta empty |
| **T26** | S4 → **S3** | **Delete idea** | confirmed | node removed/archived; fork children keep their parent reference | if children exist → confirm names the affected forks |
| **T27** | S4 → S4 | complete a **needs-completion** spark-derived idea | — | fill missing mandatory fields; becomes fully valid | marked *"Needs completion"* until then (see §6 Open Q1) |

#### Global / cross-cutting

| ID | From → To | Trigger | Guard | Side effects | Empty / error state |
| :-- | :-------- | :------ | :---- | :----------- | :------------------ |
| **T28** | any → same | AI becomes unavailable | — | **vault ops unaffected** (capture, read, iterate, fork, browse, delete) | S1 → **E4 Unavailable**; never a blocking modal (NFR-A1) |
| **T29** | any → same | network / persistence error | — | — | non-destructive error surface with **Retry**; no committed idea is lost (NFR-D1) |

### 4.3 Resolution semantics (T10 / T11 exactly)

**ACCEPT** (`swipe right` / **Good**):
1. Create a **new root idea** (no lineage parent) from the spark's proposed direction.
2. Record its two source ideas as **provenance** (muted on S4; *not* in the lineage chain).
3. Mark the spark **accepted**; remove the card; reveal the next.
4. The derived idea is subject to mandatory-field validation (`PRD.md` §2). Where the spark supplies the fields, prefill them; where it cannot, the idea enters **needs-completion** (§6 Open Q1).

**DISMISS** (`swipe left` / **Not for me**):
1. Mark the spark **dismissed**; retain it as **negative signal** so the pairing is not re-offered unchanged (`PRD.md` §3.3.5).
2. Remove the card; reveal the next. No vault node is created.

Both are **vault operations** and must succeed with AI down (NFR-A1). Both are **idempotent**: if the resolve animation is interrupted, the decision still commits exactly once.

---

## 5. Edge cases (required set)

### 5.1 Empty vault
- **First launch, vault empty → S0.** The empty vault *is* the onboarding (`DESIGN.md` §7). Never show a bare *"No ideas yet."*
- **Returning user, empty (all deleted) → S1 shows E0 Cold**, with an onboarding exit back to S0.

### 5.2 Vault under 3 domains (no sparks possible) — **E0 Cold**
- Two ideas in the *same* domain land in the cliché quadrant and are **suppressed** (`PRD.md` §3.3.3). Below the eligibility floor there is nothing to surface.
- S1 renders a **composed** empty state, framed as progress not failure: `domains covered 1/3` (mono) + **Add idea** CTA + a one-line reason (*"Sparks pair distant domains — add ideas from another field."*).
- This is the same surface as E3 but with a *distinct* message and the domain-progress readout. The engine must **not** present a spinner or an error here.

### 5.3 No sparks left — **E3 Exhausted**
- Vault eligible, every candidate already reviewed (accepted/dismissed) or suppressed, none computing.
- Composed empty state: *"No sparks left — for now."* + **Add idea** + **Fork into a new domain** (the flywheel: a fork widens the vault, which makes the *next* spark possible) + **Recompute**.
- `Recompute` re-runs the engine (→ E1). Never re-offer a dismissed pairing *unchanged*; a changed vault may re-surface a *different* pairing.

### 5.4 Undo after a swipe — **one step**
- **Window:** an undo affordance appears after every ACCEPT/DISMISS, for a short time-boxed window (and no longer than until the next decision or leaving the deck).
- **ACCEPT undo:** retract the derived idea **only if it is still unedited**, clear the acceptance and its provenance, restore the card. If the user has opened/edited the derived idea, undo is unavailable — the idea can still be deleted normally from the Vault (T26).
- **DISMISS undo:** clear the negative signal, restore the card.
- **One step only:** undo reverts the *last* decision; it does not chain.
- Undo applies equally to the button and the gesture (parity, §2.2).

### 5.5 Swipe / button parity
- Gesture and button dispatch the same command and payload; resulting state is identical (§2.2).
- The deck is **fully operable without gestures** (accessibility + discoverability: 44px buttons always visible).
- *"Use as inspiration"* has **no swipe axis** — it is button-only, by design.

### 5.6 AI-unavailable degradation — **NFR-A1**
- **Never degrade the vault.** Capture, browse, open, iterate, fork, and delete all work with the Spark unavailable.
- Only spark **generation** pauses. S1 → **E4**: a quiet, non-blocking state with **Retry**; *not* a modal, *not* an error banner over the app.
- **Already-offered sparks remain reviewable** (already computed) — ACCEPT/DISMISS keep working, because they are vault writes (NFR-P1: spark results never block vault operations).

---

## 6. Open questions (owner / design calls, not for me to settle)

1. **Mandatory fields vs one-tap ACCEPT.** `PRD.md` §2/§3.1 make Hypothesis, Problem, Monetization, and Domain **mandatory**. A one-tap "good" cannot always supply all four. Proposed resolution in §4.3 step 4: prefill what the spark has; mark the rest **needs-completion** with a prompt (T27). Alternative: ACCEPT opens seeded Capture instead of creating immediately — but that breaks the swipe-to-keep gesture. **Needs owner sign-off.**
2. **Deck vs feed.** This spec assumes the **deck is the default** with **View all** as the escape hatch (David's recommendation; Assaf has not ruled). If Assaf rules for the vertical feed, only §4.1/§4.2 rendering changes — the state machine is unchanged.
3. **Cold threshold value.** The `3 domains` figure is the activation *target* (`PRD.md` §5); the hard eligibility floor is `2 domains`. Confirm whether E0 triggers at < 2 (no sparks possible) or < 3 (target-led, softer).
4. **Delete semantics.** Whether deleting an idea with forks **blocks**, **orphans**, or **cascades** is a persistence decision (T26); this spec assumes **orphan-with-warning**.

---

## 7. Verification checklist (for the reviewer)

- [ ] Every transition in §4 has a **named trigger**, a **destination**, and an **empty/error state**.
- [ ] The six required edge cases are covered: empty vault (§5.1) · under-3-domains (§5.2) · no sparks left (§5.3) · undo (§5.4) · swipe/button parity (§5.5) · AI-unavailable (§5.6).
- [ ] Vault operations never depend on the Spark (NFR-A1, §5.6).
- [ ] Acceptance produces a **root** idea with **provenance**, and lineage stays **single-parent** (§2.3) — closes D1.
- [ ] Swipe and button paths converge on one command (§2.2, §5.5).
- [ ] No `collision`; no "related ideas"; no circular spinners; no bare empty states.

---

*Draft — Ari (AstroLab agent), 2026-10-12. Review: adversarial pass by Max; spec aligns to the Nightfall lane and the 2026-10-12 pivot.*
