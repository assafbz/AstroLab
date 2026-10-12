# Flow Spec: Astrolab (MVP v1.0)

> **Status:** Draft for review — not yet merged.
> **Scope:** End-to-end user journey + application state machine for the MVP creative loop.
> **Vocabulary:** the engine is **the Spark**; its outputs are **sparks**. *(Never "collision.")*
> **Source of truth for scope:** `docs/PRD.md`, `docs/VISION.md`. Visual language: `DESIGN.md`.
> **Decision provenance:** the 2026-10-12 pivot in the product thread (judge the *idea*, not the pairing; swipe → **good** / ← **not for me**; a "good" spark becomes a **new root idea** with its two sources kept as **provenance**, not lineage).

---

## 0. How to read this document

This spec defines **what moves the user**, not how it is rendered. Every transition below is a row in §4 with a **named trigger**, a **destination**, and an **empty / error state**. Screen-level layout and motion belong to `DESIGN.md`.

**Known doc dependency (blocking for merge).** This spec is written against the 2026-10-12 pivot. Two upstream documents still contradict it and are owed a rewrite in a parallel PR; two more are named for completeness:

- **`PRD.md` §3.3.2 / §3.3.5** still define the **two-axis model** (domain distance + structural alignment) and *"Keep as is … recorded as a fork of the source pair."* The flow below drops the axes and makes acceptance produce a **root** idea. *(Owed.)*
- **`DESIGN.md` §1 / §4 / §5 / §7** still describe a **light** vertical *feed* and a two-source origin line with a distance readout. The flow below assumes the **Nightfall** dark-canvas deck. *(Owed.)*
- **`VISION.md`** — **named, not owed.** Its §3 / §4 Pillar 2 / §8.4 govern the engine's *selection* (which pairs to surface), not a UI readout, so they do **not** contradict the pivot. The one bullet that did — §4 Pillar 2, *"explains the shared mechanism"* — was already rewritten in PR #3. Keep it in that revised form if VISION is touched again.
- **`PRD.md` §5 (NSM) / NFR-Q1** — **already reconciled upstream:** PR #3 restated the NSM as *"sparks **accepted** per active user per month,"* and NFR-Q1's *spark→fork* proxy was reworded at `6665504`. Consistent with this flow; no action here.

**Until the owed rewrites land, this file describes the intended product, not the current docs.** Reviewer: treat any divergence there as the upstream rewrite being owed, not a defect here.

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
| **S6** | Iterate | — *(no DESIGN.md § — visual spec owed; flag to design owner)* | In-place refinement of an idea; prior version retained as history. |

### 2.2 The three user actions on a spark

| Action | Gesture | Button | Core semantics |
| :----- | :------ | :----- | :------------- |
| **ACCEPT** ("Good") | swipe **right** | brass, 44px | *This idea is good.* Creates a **new root idea**; records its two sources as **provenance**. |
| **DISMISS** ("Not for me") | swipe **left** | quiet, 44px | *Not for me.* Retained as **negative signal**; the pairing is not re-offered unchanged. |
| **INSPIRE** ("Use as inspiration") | — *(no swipe axis)* | outline, 44px | Opens **S2 (seeded)**. The spark stays **OFFERED** while capture is open; a committed **seeded save** resolves it (**RESOLVED-INSPIRED**) — see §4.3. |

**Swipe/button parity (req: §5.5).** The gesture is a **shortcut for the button, never a separate path**. Both dispatch the identical command with an identical payload; the resulting state is byte-for-byte the same. Buttons are the primary, always-visible affordance and the only accessible path — the deck is fully operable without a gesture. This must hold for ACCEPT, DISMISS, and the undo affordance.

**Decision identity (idempotency).** Every deck decision carries a client-generated **`decision_id`**, unique per user decision. ACCEPT and DISMISS are keyed by `(spark_id, decision_id)` and are **idempotent** on that key: a swipe and a button tap that both fire before the card leaves resolve to **one** decision, and a retry after an interrupted commit creates nothing extra. **The client persists the `decision_id` and reuses the same one on retry — it must not regenerate it**, or the retry becomes a second decision. This is what makes "byte-for-byte the same" (§5.5) and "commits exactly once" (§4.3) true rather than aspirational (N4).

### 2.3 Two relations — **lineage** vs **provenance** (they are not the same thing)

The pivot retires the pair-fork (decision **D1**). Lineage stays **single-parent**; the two sources of a spark attach by a *different* relation.

| Relation | Cardinality | Direction | Created by | Surfaced |
| :------- | :---------- | :-------- | :--------- | :------- |
| **Lineage** | exactly 0 or 1 **parent** | idea → parent | **Fork** — a new node that points at one parent | "Living Lineage" chain on **S4** |
| *(version history)* | N versions of one node | — | **Iteration** — the same node, a new version (no parent edge) | version history on **S4** |
| **Provenance** | 0..N sources | spark-derived idea → its source ideas | **ACCEPT**, and committed **INSPIRE** saves | muted line on **S4** (not the lineage chain) |

- A **fork** widens the vault into a new domain (`VISION.md` §4 Pillar 3). Its parent is one idea.
- An **iteration** does not create a lineage edge — it is a new version under the same node (`PRD.md` §3.2.1).
- An **accepted spark** is a **root** idea (no lineage parent). Its two sources are **provenance** — informational, not ancestry. This is why D1 closes: nothing requires a two-parent node.

---

## 3. Spark lifecycle

A spark instance moves through a small state machine of its own:

```
        ┌──────────┐   engine run    ┌──────────┐  shown in deck  ┌──────────┐
 none → │ PROPOSED │ ──────────────► │ OFFERED  │ ──────────────► │ REVIEWED │
        └──────────┘                 └────┬─────┘                 └────┬─────┘
                                         ▲   undo (≤ 1 step)          │
                                         └───────────────────────────┘
   terminal outcomes (the card leaves the deck):
     ACCEPT                → RESOLVED-ACCEPTED   (new root idea + provenance)
     DISMISS               → RESOLVED-DISMISSED  (negative signal; pairing suppressed)
     committed seeded save → RESOLVED-INSPIRED   (new root idea + provenance)
```

- **PROPOSED → OFFERED:** engine (NFR-P1, asynchronous) produces a candidate offering; it enters the deck.
- **OFFERED → REVIEWED:** the user ACCEPTs or DISMISSes. The card leaves the deck.
- **`INSPIRE`** keeps the spark **OFFERED** only while the seeded Capture is open. A **committed** seeded save resolves it (`RESOLVED-INSPIRED`) — the same terminal class as ACCEPT (new idea + provenance), so the same spark cannot later be ACCEPTed into a **second** root idea (H5). Abandoning Capture returns it to the deck, still OFFERED.
- **Undo** reverts any of the three resolutions `→ OFFERED` and rolls back that decision's side effects (§5.4).

---

## 4. Application state machine

### 4.1 Engine states (spark availability) — drive what S1 shows

| Ref | State | Condition | S1 shows |
| :-- | :---- | :-------- | :------- |
| **E0** | **Cold** | vault **below the spark floor: fewer than 2 distinct domains** (or < 2 ideas). Every possible pair is same-domain → cliché → suppressed (`PRD.md` §3.3.3), so **no spark is possible**. *(2 distinct domains already makes a spark possible; **≥ 3** is the product target, handled by the nudge below, not by E0.)* | Composed empty state, **not** an error: *"Sparks need breadth."* Progress `domains covered x/3` (mono) + **Add idea** CTA. |
| **E1** | **Computing** | engine run in flight | Skeletal shimmer **cards** matching deck dimensions; staggered reveal. **No circular spinner** (DESIGN.md §4). Deck remains usable for already-offered sparks. |
| **E2** | **Ready(n)** | n ≥ 1 unreviewed sparks | Deck: top card. List toggle if n > 1. |
| **E3** | **Exhausted** | vault **at/above the floor** (≥ 2 domains), 0 unreviewed, none computing | Composed empty state: *"No sparks left — for now."* CTAs: **Add idea** (S2), **Fork an idea into a new domain** (encourages the flywheel). A **Recompute** affordance. When the vault holds exactly 2 domains, E3 adds a widening nudge toward the `x/3` target (`PRD.md` §5). |
| **E4** | **Unavailable** | AI down (NFR-A1) | Quiet, non-blocking state: *"Sparks are paused. Your vault is fully available."* + **Retry**. Already-offered sparks stay reviewable. |

> Axis thresholds are tuning parameters (`PRD.md` §3.3.3), not fixed requirements. **The floor for *any* spark is 2 distinct domains** (`PRD.md` §3.3.3: only *same-domain* pairs are cliché-suppressed) — that is E0's trigger. The **3-domain** figure is the onboarding *target* (`PRD.md` §5): it drives the `x/3` progress readout and the widening nudge, **not** the Cold state.
>
> **State precedence: E4 > E3.** A vault that is both Exhausted and Unavailable shows **Unavailable** (the transient cause, with Retry) — never Exhausted (which implies "come back after adding ideas"). **E0 dominates all**: with no domain spread there is no spark to compute, review, or await, so E0 shows regardless of AI state. E1 (Computing) may coexist with E2 — shimmer for in-flight work sits alongside any already-offered cards.

### 4.2 Transition table

Every transition: **ID · From → To · trigger · guard · side effects · empty/error state.**

#### Onboarding (S0)

| ID | From → To | Trigger | Guard | Side effects | Empty / error state |
| :-- | :-------- | :------ | :---- | :----------- | :------------------ |
| **T01** | launch → **S0** | first run | vault is **empty** | none | — |
| **T02** | S0 → S0 | **Add idea** (one prompt at a time) | **Hypothesis, Problem, Monetization, and Domain all non-empty** (`PRD.md` §2/§3.1 — *"an idea without a domain cannot take part in a spark"*) | node created; star-chart widens; `domains covered` updates | inline error below each empty field (Destructive) |
| **T03** | S0 → **S1** | **Skip** | — | — | if vault in **E0** → S1 shows **E0 Cold**; else → **E1 Computing**. *(Deviation: `PRD.md` §3.4.2 / NFR-U1 require onboarding to leave the user spanning multiple domains. Skip is allowed, but it is recorded as a deviation — S1 then shows E0 with the widening CTA.)* |
| **T04** | S0 → **S1** | **See your sparks** CTA appears | vault **≥ 2 distinct domains** — the `PRD.md` §3.4.2 / NFR-U1 spread requirement (2 domains is the spark floor). `≥ 3` is the `PRD.md` §5 *target*, shown as `x/3` progress, **not** a gate (N1) | kick engine run | — |
| **T05** | launch → **S1** | return launch | vault was **not** empty | evaluate engine state | E0/E1/E2/E3/E4 per §4.1 |

#### Sparks deck (S1) and Spark Detail (S1b)

| ID | From → To | Trigger | Guard | Side effects | Empty / error state |
| :-- | :-------- | :------ | :---- | :----------- | :------------------ |
| **T06** | S1 → S1 | open deck | vault eligible, no run in flight | render top offered spark | E0/E3/E4 states per §4.1 |
| **T07** | **E1 → E2** | engine results arrive *(async, NFR-P1)* | ≥ 1 candidate passes the surface rule | cards enter deck; staggered reveal | 0 pass → **E3 Exhausted** |
| **T08** | S1 → **S1b** | tap card | — | expand the spark | — |
| **T09** | S1 → **S2 (seeded)** | **INSPIRE** button | — | Capture prefilled with the proposed direction; banner *"Seeded from a spark — make it yours."* Spark stays **OFFERED** until a committed save (T16) or an ABANDON. | abandoning Capture → spark returns to deck, still OFFERED |
| **T10** | S1 → S1 | **ACCEPT** *(swipe right / brass button)* | — | see §4.3 | — |
| **T11** | S1 → S1 | **DISMISS** *(swipe left / quiet button)* | — | see §4.3 | — |
| **T12** | S1 → S1 | **Undo** within window | last **resolving** action reversible — ACCEPT, DISMISS, or a committed seeded save (§5.4) | roll back last decision **and its side effects** (retract derived idea + provenance; re-`OFFERED`); restore card | outside window / after derived-idea edit: undo affordance disappears and a brief **"Undo unavailable"** notice is shown — never silent (L2) |
| **T13** | S1 → **S1 (list)** | **View all** toggle | ≥ 1 unreviewed | switch deck ↔ list | n = 0 → E3 |
| **T14** | S1 → **E1** | **Recompute** / vault changed | — | engine run | E4 if AI down |

#### Capture (S2)

| ID | From → To | Trigger | Guard | Side effects | Empty / error state |
| :-- | :-------- | :------ | :---- | :----------- | :------------------ |
| **T15** | any → **S2** | **Add** tab, or INSPIRE | — | open blank / seeded capture | — |
| **T16** | S2 → origin | **Save to vault** | all mandatory fields valid (`PRD.md` §2; §3.1) | idea created. If **seeded**: root idea + **provenance** = the spark's two sources, **and the source spark is marked `RESOLVED-INSPIRED` (leaves the deck)** so it cannot later be ACCEPTed into a duplicate. Else: plain root idea. | — |
| **T17** | S2 → S2 | **Save** with invalid/empty mandatory field | — | — | inline errors below fields; CTA blocked; counter toward 280 (`PRD.md` §2) |
| **T18** | S2 → **E1** | save succeeds | vault crossed the eligibility threshold | invalidate + recompute sparks | — |

#### Vault (S3), Idea Detail (S4), Fork (S5), Iterate (S6)

| ID | From → To | Trigger | Guard | Side effects | Empty / error state |
| :-- | :-------- | :------ | :---- | :----------- | :------------------ |
| **T19** | S1 → **S3** | **Vault** tab | — | list ideas | vault empty → composed empty state with **Add idea** CTA |
| **T20** | S3 → S3 | filter by domain / lineage | — | list narrows | no match → filtered-empty: *"No ideas in ⟨domain⟩."* |
| **T21** | S3 → **S4** | tap idea card | — | open detail; render fields, lineage chain, provenance if any | — |
| **T22** | S4 → **S6** | **Iterate** | — | open in-place editor | — |
| **T23** | S6 → **S4** | **Save iteration** | all mandatory fields valid (`PRD.md` §2) | same node, new version; prior version retained as history (`PRD.md` §3.2.1); **no lineage edge** | inline error below any empty mandatory field |
| **T24** | S4 → **S5** | **Fork** | — | open Fork, seeded with parent | — |
| **T25** | S5 → **S4** | **Create fork** | mutation delta non-empty **and domain ≠ parent's** (`PRD.md` §1.2 — a fork widens the vault into a new domain; the flywheel depends on it) | **new** node; lineage parent = source; domain defaults **different** | inline error if delta empty; if the chosen domain **equals** the parent's → offer **Iterate** instead (a same-domain branch is a refinement, not a fork) |
| **T26** | S4 → **S3** | **Delete idea** | confirmed | node removed/archived; fork children keep their parent reference | if the idea is a fork **parent** → confirm names the affected forks; if it is a **provenance source** of a spark-derived idea → confirm names those derived ideas (their provenance keeps a dangling ref) — neither is deleted |
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

**INSPIRE** (`Use as inspiration` button only):
1. Open **S2 (seeded)**. The spark stays **OFFERED**.
2. If the seeded save is **committed** (T16), the spark is marked `RESOLVED-INSPIRED`, leaves the deck, and **cannot** then be ACCEPTed — closing the duplicate-idea path (H5).
3. If Capture is abandoned, the spark returns to the deck, still OFFERED.

ACCEPT and DISMISS are **vault operations** and must succeed with AI down (NFR-A1). Both are **idempotent** on the client-generated **`decision_id`** (§2.2): a swipe and a button tap that both fire before the card leaves resolve to **one** decision, and a retry after an interrupted commit creates nothing extra — exactly once, not twice (H4).

---

## 5. Edge cases (required set)

### 5.1 Empty vault
- **First launch, vault empty → S0.** The empty vault *is* the onboarding (`DESIGN.md` §7). Never show a bare *"No ideas yet."*
- **Returning user, empty (all deleted) → S1 shows E0 Cold**, with an onboarding exit back to S0.

### 5.2 Vault below the spark floor (no sparks possible) — **E0 Cold**
- The **floor is 2 distinct domains** (`PRD.md` §3.3.3). Below it, every possible pair is *same-domain* → cliché → suppressed, so **no spark is possible** — that is the only condition that puts S1 in E0. `≥ 3` domains is the *target* (`PRD.md` §5), not the floor (H1).
- S1 renders a **composed** empty state, framed as progress not failure: `domains covered x/3` (mono) + **Add idea** CTA + a one-line reason (*"Sparks pair distant domains — add ideas from another field."*).
- **2 domains is not E0** — a 2-domain vault is eligible and shows sparks if any pair aligns; if none do, that is **E3** (§5.3), with the `x/3` widening nudge. The engine must **not** present a spinner or an error here.

### 5.3 No sparks left — **E3 Exhausted**
- Vault **at/above the floor (≥ 2 domains)**, every candidate already reviewed (accepted/dismissed) or suppressed, none computing.
- Composed empty state: *"No sparks left — for now."* + **Add idea** + **Fork into a new domain** (the flywheel: a fork widens the vault, which makes the *next* spark possible) + **Recompute**.
- `Recompute` re-runs the engine (→ E1). Never re-offer a dismissed pairing *unchanged*; a changed vault may re-surface a *different* pairing.

### 5.4 Undo after a deck decision — **one step**
- **Window:** an undo affordance appears after every **resolving** action — ACCEPT, DISMISS, **or a committed seeded INSPIRE save** (T16) — for a short time-boxed window (and no longer than until the next decision or leaving the deck).
- **ACCEPT undo:** retract the derived idea **only if it is still unedited**, clear the acceptance and its provenance, restore the card.
- **INSPIRE-save undo** (same class as ACCEPT): retract the seeded idea **only if it is still unedited**, clear its provenance, and **return the spark to `OFFERED`** (un-resolve) — closing the vault-mutating path the H5 fix introduced (N3).
- **DISMISS undo:** clear the negative signal, restore the card.
- **Permanence:** once the window closes, or the derived idea has been opened/edited, the resolution is final. In particular, **deleting a derived idea later (T26) does not un-resolve its spark** — it stays `RESOLVED-*`, is not re-offered, and its provenance ref simply dangles (M3). The derived idea can still be deleted from the Vault the normal way (T26).
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
3. ~~Cold threshold value.~~ **Resolved by this spec (H1):** E0 triggers at **< 2 distinct domains** (no spark possible); `3 domains` is the target that drives the `x/3` readout and the widening nudge, not E0. Owner may still soften the 3-domain nudge's emphasis.
4. **Delete semantics.** Whether deleting an idea with forks **blocks**, **orphans**, or **cascades** is a persistence decision (T26); this spec assumes **orphan-with-warning**, and that a deleted **provenance source** leaves a dangling (tolerated) ref on the derived idea.
5. ~~Seed metric.~~ **Resolved upstream (H6):** PR #3 restated `PRD.md` §5 (NSM) as *"sparks accepted per active user per month"* and NFR-Q1's proxy was reworded at `6665504` — now consistent with this flow's ACCEPT→root event.

---

## 7. Verification checklist (for the reviewer)

- [ ] Every transition in §4 has a **named trigger** and a **destination**, and an **empty/error state wherever the transition can land on one** (some rows are legitimately "—").
- [ ] The six required edge cases are covered: empty vault (§5.1) · below-floor / no sparks possible (§5.2) · no sparks left (§5.3) · undo (§5.4) · swipe/button parity (§5.5) · AI-unavailable (§5.6).
- [ ] Vault operations never depend on the Spark (NFR-A1, §5.6).
- [ ] Acceptance produces a **root** idea with **provenance**, and lineage stays **single-parent** (§2.3) — closes D1.
- [ ] Swipe and button paths converge on one command, keyed by a **`decision_id`** so a raced swipe+tap commits **once** (§2.2, §4.3).
- [ ] A committed **INSPIRE** save resolves its spark (`RESOLVED-INSPIRED`) and blocks a duplicate ACCEPT (§4.3).
- [ ] **Undo** covers all three resolving paths (ACCEPT / DISMISS / committed seeded save), and resolution is **permanent** once the window closes — deleting a derived idea does not un-resolve its spark (§5.4).
- [ ] The onboarding exit gates on **≥ 2 domains** (the NFR-U1 requirement); `≥ 3` shows as `x/3` progress, not a gate (T04).
- [ ] Onboarding capture requires **Domain** and the `See your sparks` CTA gates on **≥ 3 domains** (T02/T04).
- [ ] No `collision`; no "related ideas"; no circular spinners; no bare empty states.

---

## 8. Revision history

- **2026-10-12 — r1.** Initial draft.
- **2026-10-12 — r2 (this revision).** Adversarial review by Max (PR #2) + David's routing corrections. Disposition: **all findings accepted and fixed** — H1 (E0 floor is 2 domains, not 3), H2 (S0 domain guard + spread gate), H4 (`decision_id` idempotency), H5 (INSPIRE-save resolves the spark), M1 (E4 > E3 precedence), M2 (fork must widen the domain), M3 (provenance-source delete), M4 (Skip deviation stated), M5 (checklist wording), L1 (iteration is a version, not a lineage edge), L2 (undo-unavailable notice). **H3:** `VISION.md` named in the dependency note but **not owed a rewrite** (its §3/§4/§8.4 govern selection, not a readout; the one contradicting bullet was already rewritten in PR #3). **H6:** reconciled upstream (PR #3 + `6665504`). **L3** (S6 visual spec) routed to the design owner. Open Q3 and Q5 resolved.

- **2026-10-12 — r3 (this revision).** Max's re-review of r2: all 11 findings confirmed closed; 3 residuals + 1 nitpick folded in — **N1** (onboarding exit gates on ≥ 2 domains, `x/3` is progress not a gate — T04), **N2** (lifecycle diagram redrawn with the three terminal states incl. `RESOLVED-INSPIRED`), **N3** (§5.4 undo now covers the committed seeded save; resolution permanence and delete-does-not-un-resolve defined; T12 broadened), **N4** (`decision_id` must be persisted and reused on retry, never regenerated).

*Draft — Ari (AstroLab agent), 2026-10-12. Review: two adversarial passes by Max; spec aligns to the Nightfall lane and the 2026-10-12 pivot.*
