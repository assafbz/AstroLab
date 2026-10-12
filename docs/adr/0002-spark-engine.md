# ADR-0002: Two-stage, ANN-free spark engine

- **Status:** Proposed (MVP)
- **Date:** 2026-10-12
- **Context:** `docs/ARCHITECTURE.md` §3
- **Deciders:** architecture (Ari) — review Max

## Context

The Spark pairs the user's *own* ideas when they are **far apart in domain** yet **structurally aligned**
(`VISION.md` §3; `PRD.md` §3.3). The two axes pull in opposite directions, so a single similarity metric
cannot rank both (`PRD.md` §3.3.6). Mechanism extraction is **AI-assisted**. Two hard constraints: compare
pairs **directly**, with **no vector DB / ANN index** at personal vault scale (`PRD.md` §3.3.7), and never
surface a similarity readout (`PRD.md` §3.3.4; `VISION.md` §8.4). AI is a metered, remote resource that can be
unavailable (NFR-A1/P1).

## Decision

Run the engine in **two stages** in the worker:

1. **Extract (AI, once per idea, cached)** — a normalised **mechanism descriptor** per idea
   (`idea_mechanism`).
2. **Gate (local, deterministic)** — compute **domain distance** from a small curated **domain-cluster
   taxonomy** (hops, no embeddings) and **structural alignment** as a deterministic comparison of the two
   descriptors. Keep pairs clearing both thresholds (`config`).
3. **Adjudicate (AI, once per gated pair)** — confirm the shared mechanism and produce the spark's
   direction/claim/first-step.

AI cost is therefore **O(N + gated)** calls, while the O(N²) comparison stays a cheap local filter.

## Consequences

- **Positive:** satisfies `PRD.md` §3.3.7 literally — direct comparison, no ANN, no vector store.
- **Positive:** AI spend is linear in vault size and in the number of gated candidates, not O(N²). A failure or
  timeout of any AI call degrades a single stage, not the vault (NFR-A1).
- **Positive:** the two axes stay **internal**; the UI receives only the spark's idea form (§3.3.4).
- **Negative / bounded:** the gate's deterministic alignment can miss pairs the model would have caught — a
  recall/precision tradeoff tuned via thresholds (`config`), exactly the "tuning parameter" the PRD allows
  (§3.3.3).
- **Compatibility:** thresholds live in `config`, so recalibration never touches schema or API.

## Alternatives considered

- **AI per pair (O(N²) calls).** Rejected: cost and latency scale quadratically; violates the spirit of
  NFR-P1 bounded delivery.
- **Embeddings + ANN.** Rejected: `PRD.md` §3.3.7 forbids ANN in the MVP; and a single embedding metric cannot
  express *far-and-aligned* (`PRD.md` §3.3.6).
- **Single combined score.** Rejected: collapses the two axes that the product's value depends on.
