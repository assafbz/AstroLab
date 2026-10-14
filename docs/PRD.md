# Product Requirements Document (PRD): Astrolab

> **Document Version:** 2.0.0  
> **Target Release:** MVP (v1.0)  
> **Status:** MVP scope approved — design baseline  
> **Product Slogan:** *Spark. Pivot. Build.*  
> **MVP Focus:** *Spark + Pivot* — the personal creative loop. *Build* is deferred.

---

## 1. Product Overview & Strategic Goals

### 1.1 Objective & Value Proposition

**Astrolab** is a **single-user** workspace that turns a person's scattered ideas into a live, structured vault — and then actively pairs those ideas into **sparks** — new directions they would not have reached alone.

The MVP's differentiator is **the Spark**: it pairs the user's *own* ideas when they are **far apart in domain but share a transferable structure**, producing sparks that are non-obvious yet coherent.

The MVP deliberately covers only the **creative loop**. Prioritization and execution — *Build* — are out of scope for v1.0 (Sec. 6).

### 1.2 MVP Scope

The MVP is one closed personal loop:

**Capture → Spark → Fork → Capture**

*A fork launches an idea into a new domain, widening the vault and improving later sparks — a flywheel, provided forks create genuine domain spread rather than near-variants.*

**In scope:**

- Single-user structured idea vault.
- Personal lineage: iterations (refine in place) and forks (branch into a new direction).
- **Internal sparks** — pairing the user's own ideas into new directions.
- Guided onboarding that bootstraps domain diversity.

**Out of scope (deferred — see Sec. 6):** multi-user and sharing scopes, blind matchmaking, enterprise/multi-tenancy, end-to-end encryption for sharing, prioritization (*Build* / ICE / RICE / 2×2), cryptographic provenance, note import, and AI-generated seed ideas.

### 1.3 Target Personas

| Persona | Role / Context | Core Pain Point | Astrolab Solution | MVP? |
| :--- | :--- | :--- | :--- | :--- |
| **The Solopreneur / Polymath** | Solo software builder, creator, or domain specialist. | Ideas sit isolated in private notes; lacks sparring partners across fields. | Structured vault + internal **Spark** that surfaces non-obvious cross-domain sparks. | **Yes** |
| **The Frontline Employee** | Support agent, QA engineer, or operations specialist in an enterprise. | Ideas die in team silos; no voice in top-down innovation programs. | Company-wide open visibility and permissionless forking. | Future |
| **The Enterprise Innovation Lead / VP** | Product Leader or Head of People/Operations. | Suggestion boxes become ghost towns; no objective framework to allocate budget. | Standardized idea anatomy and cross-departmental sparks. | Future |

The MVP serves exactly one persona, by design: the solo creator.

---

## 2. The Idea Anatomy (Data Model)

Every idea is a structured knowledge unit, not arbitrary rich text.

- **Core Hypothesis (Mandatory):** A single-sentence encapsulation of the idea (max 280 characters).
- **Problem Solved (Mandatory):** The specific friction, pain point, or operational bottleneck addressed.
- **Monetization / Value Angle (Mandatory):** How value is captured — revenue model, unit economics, or cost savings.
- **Domain Tag(s) (Mandatory):** One or more cross-disciplinary tags (e.g., `#fintech`, `#audio-dsp`, `#logistics`, `#developer-tooling`). Domain is the axis along which the distance between ideas is measured; **an idea without a domain cannot take part in a spark.**
- **Lineage:** `Root` or `Fork of ⟨Y⟩` — strictly single-parent. A **fork** is the only lineage edge; an **iteration** refines the *same* node in place (a version, not a lineage kind — Sec. 3.2 item 1).
- **Provenance (optional):** `Sparked from ⟨A⟩ + ⟨B⟩` — the ideas a spark was generated from. Recorded as muted metadata, **not** part of Lineage: accepting a spark creates a **new root idea** (Sec. 3.3 item 5).
- **Visibility Scope:** `PRIVATE` only in the MVP. Sharing scopes (Circle / Company / Public) are deferred.

Every field above is part of the machine-readable "anatomy" that makes ideas comparable to one another.

---

## 3. Core Functional Requirements

### 3.1 Module 1 — The Idea Vault (Spark)

1. **Structured Capture:** Quick capture with mandatory-field validation (Hypothesis, Problem, Monetization, Domain) to prevent low-effort, unvalidated entries.
2. **Personal Vault:** All ideas belong to a single user. No cross-user access, invitations, or sharing in the MVP.
3. **Browse & Retrieve:** The user can view all ideas, filter by domain tag, and open any idea's detail view.

### 3.2 Module 2 — The Lineage Engine (Iteration vs. Fork)

1. **Iteration:** The user refines an existing idea in place. Prior versions are retained as history under the same node.
2. **Fork:** The user creates a **new** node that points at its parent and records an explicit mutation delta (e.g., *"Forking this B2B CRM concept into a healthcare compliance scheduler"*). The fork starts life as its own idea, with the parent recorded as provenance.
3. **Provenance:** Parent/child relationships are recorded structurally. The system can always answer both "what did this derive from?" and "what derived from this?"

> Note: lineage is a parent/child relationship. The MVP does not require graph traversal, vector indices, or any specific storage structure; those are design decisions, not requirements.

### 3.3 Module 3 — The Spark — *the differentiator*

The Spark surfaces non-obvious, coherent sparks from the user's **own** vault.

1. **Scope — internal only.** The engine operates over the user's own idea nodes. No external users, no public graph, no cross-user matching in the MVP.

2. **Candidate selection — two internal axes.** Each candidate pair is scored on two axes:

   | Axis | Meaning | Desired |
   | :--- | :--- | :--- |
   | **Domain distance** | How unrelated the two ideas' domains are. | **High** — surprise. |
   | **Structural alignment** | Whether they share a transferable *mechanism* (relational structure), independent of domain. | **High** — combinability. |

   These axes are **selection internals**: tuning parameters for finding non-obvious candidates. They are never surfaced as UI readouts (Sec. 3.3 item 4).

3. **Surface rule.** A pair is surfaced **only** when both axes are high (far apart **and** structurally aligned). The engine must actively suppress:

   | Suppressed | Description |
   | :--- | :--- |
   | **Cliché / near-duplicate** | High alignment, low distance — the obvious, already-known analogy. |
   | **Noise** | High distance, low alignment — a meaningless pairing with no basis to combine. |

   *Axis thresholds are calibrated empirically; they are tuning parameters, not fixed requirements.*

4. **Presentation — a spark is shown as an *idea*, and judged on its own merits.** A surfaced spark is presented as a proposed idea:

   - the **idea** — the headline;
   - **the claim** — one or two lines on why it matters;
   - **what it would take** — on the expanded view;
   - **first step** — the smallest next move;
   - **domain tags**.

   The shared mechanism is **not** displayed as a separate readout, and no similarity, distance, or alignment number appears anywhere in the UI. The user's only judgement is **good / not for me**: the pairing's similarity is not the question. Which ideas the spark came from stays recorded as *provenance* (Sec. 2).

   *Rationale:* the product's value is a direction the author would not have reached alone. Once that direction exists, it stands or falls as an idea. Explaining *why two ideas are alike* invites reading the spark as a recommendation feed of similar items — which Sec. 7 of this document and `DESIGN.md` Sec. 7 forbid.

5. **Interaction — a deck, judged by swipe or button.** Proposed sparks are surfaced as a **deck on the home screen**, one at a time:

   - **Good** (swipe right) — the spark is accepted and becomes a **new root idea** in the vault; its two sources are recorded as provenance metadata, **not** lineage.
   - **Not for me** (swipe left) — dismissed. Dismissals are retained as negative signal so the same pairing is not re-surfaced unchanged.
   - **Make it mine** — opens **Capture**, seeded from the spark.
   - Explicit buttons accompany both gestures, and every judgement is followed by a **one-step undo**.

6. **Mechanism (design note).** The two axes pull in opposite directions, so a single similarity metric cannot rank both: one measure that finds *near* ideas cannot find the *far* ones the product wants. Mechanism extraction (identifying each idea's transferable structure) is AI-assisted. Concrete model/algorithm choices belong in the architecture doc and ADRs, not here.

7. **Scale.** At personal vault sizes the engine compares pairs directly. The MVP does **not** require a vector database, approximate-nearest-neighbour index, or million-node scaling.

8. **Quality bar.** Surfaced sparks must be **non-obvious AND coherent**. Quality is tracked via a proxy metric (see Sec. 5).

### 3.4 Module 4 — Bootstrap (Guided Elicitation)

Internal sparks produce nothing until the vault holds ideas *across enough domains*. Two ideas in the same domain land in the cliché quadrant and are suppressed. The MVP therefore **actively bootstraps diversity**:

1. **Cross-domain onboarding.** Onboarding walks the user through a small set of deliberately cross-domain prompts (e.g., "an idea from your work", "a frustration nobody has fixed", "a domain you have never worked in") to capture the user's **own** ideas.
2. **Guaranteed spread.** Onboarding must leave the user with ideas spanning multiple distinct domains, so sparks can deliver value on first use.
3. **No synthetic seeds.** The MVP does **not** generate ideas on the user's behalf and does **not** import existing notes; both are deferred (Sec. 6).

---

## 4. Non-Functional Requirements

These state verifiable properties of the system. They deliberately name **no** technologies, algorithms, or products — those are captured in a separate security/architecture document and ADRs.

| ID | Category | Requirement | Verification |
| :--- | :--- | :--- | :--- |
| **NFR-A1** | Availability | The core vault (capture, read, iterate, fork) functions independently of the Spark. AI unavailability degrades only sparks, never the vault. | Fault-injection test. |
| **NFR-P1** | Performance | Spark results are produced asynchronously and never block vault operations; results are delivered within a bounded time at expected personal vault sizes. | Timed test with AI delay/failure injected. |
| **NFR-D1** | Durability & Portability | No committed idea is lost, and the user can export the full vault in an open, portable format. | Backup/restore and export test. |
| **NFR-PRIV1** | Privacy | User ideas are not used to train models and are not shared with or transmitted to any third party beyond what a user-requested operation strictly requires. | Data-flow and vendor-contract audit. |
| **NFR-Q1** | Quality | Spark quality is a first-class, instrumented product metric, tracked via the spark-acceptance proxy (Sec. 5) — accepted sparks, and how many landed in a new domain. | Instrumentation + reporting. |
| **NFR-U1** | Usability | A new user completes onboarding with a vault spanning multiple distinct domains, sufficient for sparks to operate. | Onboarding completion test. |

Removed from earlier drafts (and re-homed as design decisions, not requirements): specific ciphers and key-derivation functions, database row-level security, ANN/vector search, cryptographic timestamp protocols, and enterprise uptime SLAs. None are MVP requirements.

---

## 5. Success Metrics & KPIs

- **North Star Metric (NSM):** **Sparks accepted per active user per month** — the count of non-obvious sparks that became ideas in the vault (Sec. 3.3 item 5, *Good*), especially ideas landing in a *new* domain.
- **Vault Diversity:** Distinct domains represented per user (spark quality depends on breadth, not volume).
- **Onboarding Activation:** Percentage of new users whose vault, on completing onboarding, clears the **gate** — **≥ 2 distinct *resolved* domains**, the spark floor below which no spark is possible (`FLOW.md` §5.2) — tracked against the **target** of **≥ 3 distinct domains** (proposed target: ≥ 60% reaching the target; to confirm). *Gate = 2 resolved domains; 3 is the target.*
- **Lineage Activity:** Forks and iterations generated per user (is the flywheel turning?).
- **Retention:** Weekly return rate of users whose vault has reached a spark-viable size.

---

## 6. Deferred / Future Scope

Recorded deliberately. None of this is in the MVP; each item is a candidate for a later release.

- **C — Generative Sparks:** AI proposes seed ideas in domains the user hasn't covered, to close residual domain gaps. Deferred (it produces ideas that are not the user's own, which weakens the personal premise).
- **A — Import & Expand:** Parse existing notes into structured idea nodes.
- **Multi-user & sharing scopes:** `CIRCLE`, `COMPANY_INTERNAL`, `PUBLIC`, and the public idea graph.
- **Blind Matchmaking Protocol:** Cross-user, double-opt-in sparks. Requires a multi-user corpus and solves a cold-start problem the MVP avoids entirely.
- **Enterprise:** Multi-tenancy, tenant isolation, row-level security, data residency.
- **Encryption for shared content:** End-to-end encryption where content leaves the user's workspace.
- **Horizon (*Build*):** ICE and RICE scoring, the interactive 2×2 Impact/Effort canvas, and one-click export to GitHub / Linear / Jira.
- **Cryptographic Provenance Ledger:** Prior-art timestamping and verifiable certificates.
- **Vector-search infrastructure:** Only needed once the corpus spans many users.

---

## 7. Strategic Non-Goals

To maintain focus and avoid scope creep, Astrolab will explicitly **not**:

1. **Act as a project-management tool:** Astrolab prioritizes *what* to build; execution tracking belongs in Jira, Linear, or GitHub Issues.
2. **Function as an unstructured social feed:** Astrolab requires structured data and validation signals to avoid becoming a repository of low-effort shower thoughts.
3. **Train models on private user data:** User ideas remain private and air-gapped from shared training corpora.
4. **Introduce network features in the MVP:** v1.0 is deliberately single-player. Collaboration, matchmaking, and public graphs are post-MVP.
5. **Ship prioritization/execution tooling in the MVP:** *Build* is deferred until there is a backlog worth prioritizing.
