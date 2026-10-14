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
`ARCHITECTURE.md` §12 item 2 (closing it), and a **regression fixture** of the expected pairs captured.

`min_domain_distance` is **not** tuned here: it is spec-pinned at `1` (`store/src/config.ts`), and
raising it is an edit to the spec, not a calibration value.

## 2. The acceptance bar — what counts as a "good spark"

A **surfaceable** spark is the model's confirmed output for a gated pair (§3.3 step 3). It is scored
against the bar **after** it surfaces, blind to which pairing produced it:

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

## 3. Run-level pass conditions

The run **passes** iff all of:

| # | Condition | Threshold |
| :-- | :-- | :-- |
| **C1** | **Coverage** — the vault spans the shipped taxonomy | one idea in **each of the 28 clusters** (28 ideas), so every hop class (`1` near · `2` linked · `3` far) is exercised |
| **C2** | **Cliché suppression** — no same-cluster pair surfaces | **0** surfaced sparks with `domain_distance = 0` |
| **C3** | **Precision** — most surfaced sparks are good | **≥ 80%** of surfaced sparks pass the §2 bar at the chosen `min_alignment` |
| **C4** | **Yield** — the deck is not empty | **≥ 5** good sparks surface across the vault at the chosen `min_alignment` |
| **C5** | **Fixture** — the result is reproducible | **≥ 5** expected pairs (ids + `alignment` + confirmed/suppressed) captured as a regression fixture |

C3 protects against an **over-low** floor (noise surfaces); C4 against an **over-high** one (nothing
surfaces — indistinguishable from "no aligned pairs exist", the silent failure §3.4 names).

## 4. The calibration protocol

The representative vault is **28 ideas, one per cluster**, each tagged with its cluster key (a shipped
tag, so every tag **resolves** — `ARCHITECTURE.md` §3.2). One idea per cluster is the **smallest** vault
that covers the taxonomy, and it makes the label set exact: every pair is cross-cluster, so the run
exercises the near/linked/far classes a real vault would.

1. **Extract** — one call per idea; descriptors cached in `idea_mechanism` (§3.3 step 1). `28` calls.
2. **Gate (AI-free, local)** — compute `domain_distance` from `domain_cluster.adjacency` and
   `alignment` from `descriptorSimilarity` (§3.3 step 2). No provider call.
3. **Sweep** `τ ∈ {0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65}`. Adjudicate the **union once** — every
   pair with `alignment ≥ 0.35` — so a pair above the lowest τ is paid for exactly once (§3.1:
   `O(N + gated)`).
4. **Score** every τ against §3: surfaced set = adjudicator-confirmed pairs with `alignment ≥ τ`; judge
   each against the bar (§2). Pick **τ\*** = the **lowest** τ with precision ≥ 80% **and** yield ≥ 5.
5. **Confirm** the descriptor field set (§12 item 2): whether the four extractable fields
   (`verb`, `object_class`, `constraint`, `transferable_structure`) suffice to separate good from
   not-good — recorded as *confirmed* or *revised*, with the evidence.
6. **Record** — τ\* and the field-set verdict into `ARCHITECTURE.md` §12 item 2; the τ\* fixtures (C5)
   as a test fixture; the seed `min_alignment` set to τ\*.

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

## 6. Record

The relay thread (issue #34's canonical thread) is the artifact of record for the run; this document is
the bar it is scored against. Results land in `ARCHITECTURE.md` §12 item 2 and the fixture; the bar
itself changes only on the owner's word.
