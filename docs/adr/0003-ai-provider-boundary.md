# ADR-0003: One AI-provider interface, swappable adapter

- **Status:** Proposed (MVP)
- **Date:** 2026-10-12 · **Updated:** 2026-10-13 (provider pinned: OpenRouter + `deepseek/deepseek-v4-flash`; PRIV1 = ZDR routing control, provider-attested)
- **Updated:** 2026-10-14 (third operation — tag normalisation — added; §5 now names three)
- **Context:** `docs/ARCHITECTURE.md` §5
- **Deciders:** architecture (Ari) — review Max

## Context

Mechanism extraction and adjudication are AI-assisted (`PRD.md` §3.3 item 6, §3.3 item 7). The PRD deliberately names
**no** provider (`PRD.md` §4). Privacy is a requirement: ideas are **not** used to train models and are **not**
transmitted to any third party beyond what a user-requested operation strictly requires (NFR-PRIV1). The
provider may be unavailable; that must degrade only sparks, never the vault (NFR-A1).

## Decision

Depend on **one interface**, not a vendor:

```
interface MechanismExtractor { extract(idea): MechanismDescriptor }
interface SparkAdjudicator   { adjudicate(ideaA, ideaB, mechanisms): SparkDraft | null }
```

A single **adapter** implements both against a **hosted, frontier-class chat model**, selected by env
(`AI_PROVIDER`, `AI_MODEL`). All calls use **structured output** validated against a schema before storage.

Provider **OpenRouter** (`AI_PROVIDER=openrouter`), initial model **`deepseek/deepseek-v4-flash`**
(env-overridable). Calls pin `provider: { zdr: true }` to restrict routing to Zero-Data-Retention endpoints;
the model is hosted by third-party providers (no first-party DeepSeek endpoint), so retention depends on the
**routed endpoint**, not on DeepSeek's terms. Zero retention is a **routing control verified at
implementation**, not a vendor guarantee (§5).

## Consequences

- **Positive:** switching or pinning a model is a config change, not a rewrite — no vendor lock in the code or
  in the data (descriptors are stored, not model-specific vectors).
- **Positive:** NFR-PRIV1 is boundary-scoped — only the operation's payload is sent; there is one call site per
  operation to audit, and no background or periodic upload.
- **Controlled (NFR-PRIV1):** every call pins `provider: { zdr: true }`, limiting routing to
  Zero-Data-Retention endpoints ("are also unable to train on your data"). This is a **routing control verified
  at implementation**, not a vendor guarantee — OpenRouter's per-endpoint ZDR classification is
  **provider-attested, not independently audited**; request **metadata** (not content) is always stored; and
  OpenRouter transiently sees the prompt (`ARCHITECTURE.md` §5, §11).
- **Negative / bounded:** a hosted provider means idea text leaves the host for a run; this is the minimum the
  operation requires, and a **local model** is available as a drop-in adapter later (§12 item 1) if privacy
  must be stronger.
- **Failure:** any provider error/timeout is a failed call (§4); the vault is untouched (NFR-A1).

## Alternatives considered

- **Vendor SDK called directly from engine code.** Rejected: couples storage and privacy to a vendor.
- **Local-only model in MVP.** Not rejected on merit — deferred for operational simplicity; the interface makes
  it a later swap. Recorded as an open question.
- **No schema validation on output.** Rejected: a malformed response could write corrupt descriptors.
