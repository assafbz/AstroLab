# ADR-0005: React/TypeScript mobile-first PWA client

- **Status:** Proposed (MVP)
- **Date:** 2026-10-12
- **Context:** `docs/ARCHITECTURE.md` §9
- **Deciders:** architecture (Ari) — review Max

## Context

`DESIGN.md` specifies a **mobile-first, shadcn-based** system (Nightfall). The MVP must ship the deck (S1),
vault (S3), capture (S2), idea detail (S4), fork (S5) and onboarding (S0) with swipe **and** always-visible
44px buttons (`FLOW.md` §2.2, §5.5). It is a small product with no native-only capability required, and the
server will be TypeScript (§9).

## Decision

Build the client as a **React + TypeScript, Vite, mobile-first PWA**. Keep one language (TypeScript) across
client and server. Implement gestures as a **shortcut over the buttons** — every action is reachable by tap —
so parity (`FLOW.md` §5.5) and accessibility hold by construction.

## Consequences

- **Positive:** matches `DESIGN.md` (shadcn/ui is React); no app-store gate for MVP; a single language and
  toolchain across the stack.
- **Positive:** swipe/button parity is a first-class structural property (one action component, two triggers),
  not a bolt-on.
- **Negative / bounded:** no native device APIs — none are required by the MVP. If a future release needs
  native capability beyond the web, this is a client-layer swap that leaves the API contract (§6) unchanged.

## Alternatives considered

- **React Native / Expo.** Not rejected on merit; deferred. Chosen against for MVP because it adds a second
  toolchain and store-shipping overhead while shadcn (the design source) is web-native.
- **Native per-platform.** Rejected: unnecessary scope for a single-user MVP.
