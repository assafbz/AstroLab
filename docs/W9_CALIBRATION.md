# W9 calibration — the acceptance bar, the protocol, and the spend rule

**Scope:** `ARCHITECTURE.md` §3.3 (the two axes and the surface rule) and §3.4 (the thresholds); the
mechanism-descriptor field set is `ARCHITECTURE.md` §12 item 2 — this document is what closes it. Work
item: issue **#34** (W9 · Threshold calibration + mechanism-descriptor field set).

**Authority.** The owner (Assaf) approved the calibration on 2026-10-14 (*"go"*), delegating the
acceptance bar to David and keeping a **veto**. Max **verifies the run independently** — he reads the
recorded artifacts, not the report. The owner's word is the only thing that changes this document.

## 1. What W9 must produce

Per issue #34: the engine ships **calibrated** — `min_alignment` chosen from a *documented* run over a
representative vault, the descriptor field set **confirmed**, the results written into
`ARCHITECTURE.md` (§3.4 for the threshold, §12 item 2 for the field set), and a **regression fixture** of
the expected pairs captured.

`min_domain_distance` is **not** tuned here: it is spec-pinned at `1` (`store/src/config.ts`), and
raising it is an edit to the spec, not a calibration value.

## 2. The acceptance bar — what counts as a "good spark"

A **surfaceable** spark is the model's confirmed output for a gated pair (§3.3 step 3). It is scored
against the bar **after** it surfaces, **blind** — and "blind" is precise: the reviewer sees the spark
**and both of its sources** (G4 requires reading both), never the `alignment` value or the τ it cleared.

| # | Condition | Test |
| :-- | :-- | :-- |
| **G1** | **Far** | the two source ideas sit in **different clusters** (`domain_distance ≥ 1`); a same-cluster (cliché) pair never surfaces — it is suppressed by the gate, not judged here |
| **G2** | **Coherent** | the adjudicator **confirmed** a real shared mechanism; a spark the model refused is noise, never a surface |
| **G3** | **Complete** | all five surfaced fields — `direction`, `claim`, `what_it_takes`, `first_step`, `mechanism` — are present and non-empty (§3.3 step 3, `PRD.md` §3.3 item 4) |
| **G4** | **Grounded** | the spark is traceable to **both** sources, and its `mechanism` is a *transferable structure the two share* — not a restatement of one idea |
| **G5** | **Actionable** | the `first_step` is a concrete next move, not a restatement of the `claim` |

A spark passes iff **all five** hold. The reviewer records a binary **good / not-good** per surfaced
spark, with the failing condition named (G1–G5) when not-good. The user's own judgement — *good / not
for me*, never a similarity readout (`PRD.md` §3.3 item 4) — is the north star; the table is the
**runnable proxy** for it, so the run is decidable without a live user.

**On the 28-cluster fixture, G1–G3 cannot be the failing condition — read the run as a two-condition
bar.** The reviewer's blind binary turns on **G4/G5**, because the other three are enforced upstream:

- **G1 (far)** holds by construction — the fixture is one idea per cluster (§4, C1) and
  `min_domain_distance = 1` drops every distance-0 pair at the gate (`worker/src/engine/gate.ts`,
  `passesDistance`).
- **G2 (coherent)** holds by definition — §4's surfaced set *is* the adjudicator-confirmed pairs.
- **G3 (complete)** holds upstream — `parseAdjudication` (`worker/src/provider/schema.ts`) returns a
  draft only when all five fields are non-empty; a partial reply is an invalid-output **failed call**,
  never a spark.

The five rows stay the bar's *definition* — G3's guarantee is the parser's arm existing, and a real
vault's distance axis is not fixture-bound — but three of the five are not what the reviewer decides
here, and the report must say which two they are.

### G4 and G5 operationalized — the decisive tests (owner-ruled **(B)**, 2026-10-15)

Added under the owner's ruling of 2026-10-15 (*a+b*, issue #34's thread) — §6's rule that the bar
changes **only on the owner's word** is satisfied by that ruling.

The 2026-10-14 run scored the **same 21 stored sparks** twice and got two answers: a neutral read
**20/21 good → τ\* = 0.02**, a strict read **11/21 good → no τ\***. τ\* was therefore being set by how
strictly G4/G5 were read, not by the data. The repair is not a stricter or looser mood — it is to say
what the two conditions **decide**, so two reviewers reading the same spark land on the same binary.
Everything below is answerable from the spark and its two sources alone.

**G4 (grounded)** fails unless **all three** hold.

| test | question | fails when |
| :-- | :-- | :-- |
| **G4.1 — both-source grounding** | is the stated `mechanism` present in **both** sources? | it is recoverable from one source only — that is groundedness in one, not in two |
| **G4.2 — transfer residue** *(the discriminator)* | does the `mechanism` introduce **a term or relation neither source states** — an abstraction over the two, not a paraphrase of one? | the mechanism sentence can be replaced by source A's (or source B's) own hypothesis sentence with **no loss of meaning**; then the "shared structure" is the sources' own words, and the spark restates an idea instead of transferring one |
| **G4.3 — one structure, not a disjunction** | is it **one** structure that both sources realize? | it is true of both only by splitting — *"…for A, **or** …for B"* — two different claims joined, each true of one source |

**G5 (actionable)** fails unless **both** hold.

| test | question | fails when |
| :-- | :-- | :-- |
| **G5.1 — a concrete move** | does `first_step` name a **constructible** next move — an artifact, an instrument, a decision, with its object? | it names a disposition rather than a move (*realize / align / explore / consider / invest in*) or carries no object |
| **G5.2 — not the claim** | is it distinct from `claim`? | it is `claim` in the imperative — the same proposition, restated as a task |

**Worked examples — constructed for the bar, deliberately *not* drawn from the measured vault.** They
pin the boundary without labelling any scored spark; the replay scores the stored artifact against the
tests, never against these sentences.

| # | spark (abridged) | verdict | why |
| :-- | :-- | :-- | :-- |
| **W1** | sources: *a resort discounts unsold lift capacity after 18:00* · *a bakery discounts unsold bread an hour before close*. `mechanism`: "Sell unsold perishable inventory at a discount before it expires." | **G4 FAIL** | **G4.2** — the sentence *is* either source's own sentence; *unsold · perishable · discount · before expiry* are all already in both. No residue. |
| **W2** | same pair. `mechanism`: "**Horizon-indexed salvage pricing** — a capacity unit's price decays monotonically toward its marginal cost as its expiry horizon shortens, so the tail clears without discounting the whole book." | **G4 PASS** | **G4.2** — *monotone decay against a horizon* and *the tail only* are stated by neither source, and both sources are instances of it. **G4.3** — one structure. |
| **W3** | sources: *a warehouse scans barcodes to record stock moves* · *a clinic scans wristbands to record patient moves*. `mechanism`: "Both use automated identification to capture events." | **G4 FAIL** | **G4.2** — an abstraction that adds no relation; satisfied by either source alone. **G4.3** — "both … to …" is the disjunction in disguise. |
| **W4** | sources: *a lone astronomer annotates images* · *a list moderator tags posts*. `first_step`: "Realize the value of consistent annotation." | **G5 FAIL** | **G5.1** (a disposition, no object) **and** **G5.2** (the `claim` in the imperative). |

**A second binary the judge returns — *mechanism-identical source pairs*.** C1 pins **cluster**-uniqueness
and says nothing about mechanism-uniqueness, so a C1-compliant vault can contain pairs that are the same
mechanism in two domains — and those are exactly where G4.2 bites hardest. Each judged spark therefore
also carries the easier binary *"are these two source ideas the same mechanism in two domains?"* (G4.2's
residue test, applied source against source). The count is reported with the curve: it explains a
divergent read instead of hiding inside it, and it is the vault-side input to **#106** (the metric-side
half of the same ceiling).

**The judge protocol — k ≥ 3, majority, disagreement recorded.** A single reviewer's strictness is the
thing being removed, so the read is taken from **≥ 3 independent judges** (independent contexts; each
sees the spark and both sources and **never** the `alignment` value or the τ it cleared — §2's blind
rule, unchanged). Per spark each judge returns **good / not-good** plus the failing condition. The
**recorded verdict is the majority**. The report carries the **per-spark disagreement count** and the
**agreement rate** as the read's stability, and a spark with **no majority** (an even split) is recorded
**unresolved** and excluded from C3/C4 with its count stated — never silently rounded.

## 3. Run-level pass conditions

The run **passes** iff all of:

| # | Condition | Threshold |
| :-- | :-- | :-- |
| **C1** | **Coverage** — the vault spans the shipped taxonomy | one idea in **each of the 28 clusters** (28 ideas), so every hop class the taxonomy has is exercised — **`1` near · `2` linked · `null` far (unlisted)** |
| **C2** | **Cliché suppression** — no same-cluster pair surfaces | **0** surfaced sparks with `domain_distance = 0` |
| **C3** | **Precision** — most surfaced sparks are good | **≥ 80%** of surfaced sparks pass the §2 bar at the chosen `min_alignment` |
| **C4** | **Yield** — the deck is not empty | **≥ 5** good sparks surface across the vault at the chosen `min_alignment` |
| **C5** | **Fixture** — the deterministic half is asserted, the provider half is a snapshot | **≥ 5** expected pairs: `{pair_key, domain_distance, alignment, gated?}` asserted; `confirmed`/`suppressed` recorded as a **snapshot**, labelled as one |

C3 protects against an **over-low** floor (noise surfaces); C4 against an **over-high** one (nothing
surfaces — indistinguishable from "no aligned pairs exist", the silent failure §3.4 names).

**Three readings that keep the conditions honest:**

- **There is no hop value `3`.** `domain_cluster.adjacency` stores `hops_1`/`hops_2` only, so the axis
  yields `0 | 1 | 2 | null`; an unlisted pair is `null` (*"no path among the shipped hops"*), which the
  gate reads as **farthest**, never coerced to `0`. Shipped: 28 clusters → 378 pairs = **37 at hop 1 ·
  16 at hop 2 · 325 unlisted**. "Far" in this document always means `null`.
- **80% is a fixture floor, not a precision estimate.** At the C4 floor the surfaced set is ~5–6 items,
  so **one flipped judgement moves 83% ↔ 67%** (pass ↔ fail). The report therefore carries the
  precision/yield **curve per τ** (§4 step 5), and names it when τ\* clears by a single judgement.
- **C5's two halves are not the same claim.** `pair_key` / `domain_distance` / `alignment` are
  deterministic (a local gate over cached descriptors, `key`-sorted); `confirmed`/`suppressed` is a
  **provider outcome** and is not byte-reproducible (`worker/src/engine/adjudicate.ts`, D2 — no
  adjudication cache). A fixture asserting the second half would flake on any model or prompt change.

## 4. The calibration protocol

The representative vault is **28 ideas, one per cluster**, each tagged with its cluster key (a shipped
tag, so every tag **resolves** — `ARCHITECTURE.md` §3.2). One idea per cluster is the **smallest** vault
that covers the taxonomy, and it makes the label set exact: every pair is cross-cluster, so the run
exercises the {1, 2, `null`} classes a real vault would.

**Two shipped paths this fixture deliberately does not exercise**, named so the field-set verdict is not
read as covering them: **multi-tag distance** (each idea carries one tag, so `domain.ts` reading #1 —
min hops *over tag sets* — runs only in the degenerate one-tag case) and **tag normalisation** (0 calls
by design: every tag is a shipped cluster key).

1. **Extract** — one call per idea; descriptors cached in `idea_mechanism` (§3.3 step 1). `28` calls.
2. **Gate (AI-free, local)** — compute `domain_distance` from `domain_cluster.adjacency` and `alignment`
   from `descriptorSimilarity` (§3.3 step 2). No provider call.
3. **Sweep and adjudicate the union once** — τ ∈ {0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65}, and every
   pair with `alignment ≥ 0.35` adjudicated in **one** pass, so a pair above the lowest τ is paid for
   exactly once (§3.1: `O(N + gated)`). The surfaced set **at τ** = adjudicator-confirmed pairs with
   `alignment ≥ τ`.
4. **Confirm the field set first** (§12 item 2) — **before any τ\* is fixed**, because a *revised*
   descriptor changes `descriptorSimilarity` and voids every alignment behind it. **The test this step
   names:** *does `alignment` separate the adjudicator's confirmed set from its rejected set?* — measured
   on the P2 outcomes (no extra calls), reported as the two distributions and their overlap, and recorded
   as *confirmed* or *revised* with that evidence. A **revised** verdict records **no τ\*** — a
   re-extraction sweep (a new posting: `28 + M'`) is required first. (Ceiling stated so it is not
   over-read: the field set can at best be checked against confirmed/rejected; the good/not-good split
   inside the surfaced set still bottoms out in G4/G5.)
5. **Score and choose τ\*** — score every τ against §3 and report the **precision/yield curve per τ**.
   Pick **τ\*** = the **lowest** τ with precision ≥ 80% **and** yield ≥ 5 (the read comes from §2's judge protocol — k ≥ 3, majority, disagreement recorded): the owner-approved shape, which
   maximises yield (what the deck is for). A change to the selection rule is an **owner call** — this
   curve is the evidence that would justify one.
6. **Terminal branch — if no τ *in the swept range* {0.35…0.65} clears both conditions, that range
   FAILS: nothing moves inside the swept range.** The FAIL is scoped to the swept range — the free action
   **(1)** runs **before** the run is declared failed, and it can still set **τ\*** (and step 7 seed it).
   Named next actions, in order:
   1. **Re-score upward at no cost — this fires first, inside the swept FAIL.** The pairs at τ > 0.65 are
      already inside the adjudicated union, so extending the sweep **upward** spends **0** additional
      calls. If a τ there clears both conditions, **τ\* is that value and the run passes**, recorded with
      the caveat that τ\* sits above the swept range.
   2. **If precision still fails at every τ**, the finding is the descriptor's discriminating power:
      step 4's verdict becomes *revised* and the re-extraction of step 4 is the next phase.
   3. **If yield stays < 5 across τ**, the vault is the suspect — a non-representative 28-idea
      single-tag vault is a real possibility — and the repair is a new posted vault, not a wider sweep.
   4. **Extending below 0.35 is a NEW posted phase** (`28 + M_wide` calls), never a silent widening: the
      spend rule binds the failure path exactly as it binds the pass path.
   5. Only when (1) has failed and (2)/(3) are the open finding is the run **recorded as a failed
      calibration** — the terminal state, where **`min_alignment` stays at its provisional default** and
      the failure is recorded in issue #34's thread.
7. **Record** — τ\* goes into `ARCHITECTURE.md` **§3.4** (Thresholds — the threshold's home; §12 item 2
   is the descriptor question), the **field-set verdict** into `ARCHITECTURE.md` **§12 item 2**;
   `min_alignment` is seeded to τ\*; the C5 fixture lands as a test fixture; the run's actuals (calls,
   cost, curve) land in issue #34's thread.

## 5. The spend rule (owner-approved)

Every call to the provider is **counted and posted before the phase that spends it fires** — the run
never fires "to find out". Two phases, each posted and ratified first:

| Phase | Calls | Posted before it fires |
| :-- | :-- | :-- |
| **P1 extraction** | `28` (one per idea; cached) | the 28 idea texts + tags, the count `28`, and the cost — the pinned model's published per-token price × the measured prompt size |
| **P2 adjudication** | `M = \|{pairs: alignment ≥ 0.35}\|` — **deterministic** from the cached descriptors, so known before P2 | the count `M` and its cost; the phase runs under a **hard cap of `M`** |

**Tag normalisation = 0 calls**: every vault tag is a shipped cluster key, so none is unmapped. Total
model calls = `28 + M`. A phase that would exceed its posted count **stops** and reports, rather than
spending past the cap. David ratifies each posting before the phase fires; the actuals are reported
after.

**The union is deliberately the most expensive run.** `M` is a **superset** of the gated set at τ\*:
**P2 alone** is `|union@0.35|` calls, and the **run total** is `28 + |union@0.35|` — against a shipped
setting whose P2 adjudicates the smaller gated set at τ\*. Only two movements are free of new calls —
the §4 step 6 re-score **upward** at τ > 0.65, and any re-scoring inside the union; everything below
0.35 is a new posting.

## 6. Record

The relay thread (issue #34's canonical thread) is the artifact of record for the run; this document is
the bar it is scored against. Results land in `ARCHITECTURE.md` §3.4 (τ\*) and §12 item 2 (the field-set
verdict), the C5 fixture lands as a test; the bar itself changes only on the owner's word.
