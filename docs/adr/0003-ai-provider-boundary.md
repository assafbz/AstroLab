# ADR-0003: One AI-provider interface, swappable adapter

- **Status:** Proposed (MVP)
- **Date:** 2026-10-12 · **Updated:** 2026-10-13 (provider pinned: OpenRouter + `deepseek/deepseek-v4-flash`; PRIV1 vendor verification open)
- **Context:** `docs/ARCHITECTURE.md` §5
- **Deciders:** architecture (Ari) — review Max

## Context

Mechanism extraction and adjudication are AI-assisted (`PRD.md` §3.3.6, §3.3.7). The PRD deliberately names
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

**MVP provider (owner, 2026-10-13):** **OpenRouter**, initial model **`deepseek/deepseek-v4-flash`** —
env-overridable (`AI_PROVIDER` / `AI_MODEL`), so the model is a config value, not a lock.

The provider is **required** to be used under **zero-retention / no-training** terms. Because OpenRouter
routes to an upstream provider, this has to be enforced **on the request** (`data_collection: deny` + provider
routing), **not assumed** — so the **vendor-terms verification is open** (NFR-PRIV1; `ARCHITECTURE.md` §5,
§12.1). This ADR records the **requirement**; it does **not** yet claim the route satisfies it.

## Consequences

- **Positive:** switching or pinning a model is a config change, not a rewrite — no vendor lock in the code or
  in the data (descriptors are stored, not model-specific vectors).
- **Positive:** NFR-PRIV1 is boundary-scoped — only the operation's payload is sent; there is one call site per
  operation to audit, and no background or periodic upload.
- **Open (NFR-PRIV1):** the zero-retention / no-training term on the **OpenRouter → DeepSeek** route is asserted
  in adapter configuration and is **under vendor-terms verification** (`ARCHITECTURE.md` §5, §12.1). Until that
  closes, PRIV1 is a **requirement**, not a verified property — the doc states it accordingly.
- **Negative / bounded:** a hosted provider means idea text leaves the host for a run; this is the minimum the
  operation requires, and a **local model** is available as a drop-in adapter later (§12.1) if privacy
  must be stronger.
- **Failure:** any provider error/timeout is a failed call (§4); the vault is untouched (NFR-A1).

## Alternatives considered

- **Vendor SDK called directly from engine code.** Rejected: couples storage and privacy to a vendor.
- **Local-only model in MVP.** Not rejected on merit — deferred for operational simplicity; the interface makes
  it a later swap. Recorded as an open question.
- **No schema validation on output.** Rejected: a malformed response could write corrupt descriptors.
