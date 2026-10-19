# 🧭 Astrolab

> **Spark. Pivot. Build.**
> *The living idea graph that pairs your own ideas into new directions.*

---

## 🔭 Overview

**Astrolab** is a single-user workspace for ideas. It turns static notes into structured
knowledge units that can be compared, connected, and recombined. Its distinctive act is the
**spark**: it pairs ideas that are *far apart in domain* yet *share a transferable
structure*, proposing a direction their author would not have reached alone.

The MVP covers one closed personal loop — **Capture → Spark → Fork → Capture**. A fork
launches an idea into a new domain, widening the vault, which is what makes the next spark
possible. Collaboration, matchmaking, and prioritization (the *Build* half of the slogan)
are deferred past v1.0 (`docs/PRD.md`, `docs/VISION.md`).

## Status

**The project is mid-rebuild.** The v1 server design (a host API service + worker process +
SQLite-on-host + an AWS deploy) has been **superseded** by a **local-only rebuild**: the
product becomes a store app, all data lives **on the device**, and the AI runs on the
**user's own API key** — with **no server tier at all**
(`docs/ARCHITECTURE.md` v2, `docs/adr/0006-local-only-expo-app.md`).

The rebuild lands in four lanes:

| Lane | Scope | State |
| :-- | :-- | :-- |
| **L1** (#164) | `core/` — the store, the vault, the domain, on a synchronous port; server packages retired | **merged** |
| **L2** (#165) | `app/` — Expo app shell + screens (S0–S6 deck, E0–E4) | open |
| **L3** (#166) | BYO-key provider client — the adapter in-app, the engine, the foreground run driver | open |
| **L4** (#167) | export / import — the transfer path + backup exclusion | open |

**What runs today:** `core/` is present and green — it typechecks, tests, and builds (the
commands below all run against it). **The app does not run yet**: `app/` lands with L2
(#165), so there is no app start command to document until then.

## At a glance

| Area | Decision |
| :-- | :-- |
| Client | **Expo (React Native)** — one TypeScript codebase → iOS + Android store builds, plus web via `react-native-web` (native-first; web is a constrained second target) |
| Core | `core/` — portable TypeScript: store · vault · domain · engine · provider |
| Store | **on-device SQLite**, opened through a `SqliteConnection` port — `expo-sqlite` on device, `node:sqlite` in tests/CI; one in-process writer |
| AI | **device → provider direct, on the user's own API key** (OpenRouter), read from the platform secure store at call time |
| Server tier | **none** — no API, no worker, no host |
| Node | **≥ 22.13** |
| Workspaces | npm workspaces: `app` · `core` |
| Tests | vitest |

## How to run

Requires **Node ≥ 22.13** and **npm**. These are the root scripts that exist today
(`package.json`):

```sh
npm ci              # install dependencies (workspaces: app, core)
npm run typecheck   # tsc over the root config + every workspace
npm run test        # vitest across the workspaces
npm run lint        # eslint .
npm run format      # prettier --check .
npm run build       # build every workspace that has a build script
```

`core` additionally exposes its own `build` · `typecheck` · `test` scripts; scope to it with
`npm run <script> -w @astrolab/core`.

> **`app/` is not runnable yet.** The Expo app shell lands with L2 (#165). No `npm run start` /
> `expo start` command exists in the repo, so none is documented here — this section stays
> honest until #165 merges.

## Repository structure

```text
AstroLab/
├── AGENTS.md            # Repo context and binding rules for AI coding agents (read this)
├── DESIGN.md            # Design system (Nightfall) — tokens bind, implementation does not
├── README.md            # This file
├── app/                 # Expo (React Native) app — lands with L2 (#165)
├── core/                # Portable TypeScript: store · vault · domain · engine · provider
│   ├── seed/            #   shipped domain taxonomy (data, not code)
│   ├── src/             #   store/ · vault/ · domain/ · engine/ · provider/ · export/
│   └── test/            #   vitest suites + the O1 taxonomy harness
├── docs/                # Specs (PRD · VISION · FLOW · SCHEMA · ARCHITECTURE), adr/, CI_GATE.md
├── scripts/             # Repo tooling (citation lint, CI ruleset, ZDR capture)
└── .agents/skills/      # Vendored skill sets required for agent work (superpowers · ponytail)
```

## Documentation index

| Doc | Purpose |
| :-- | :-- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | **The technical design the PRD defers to — v2, the local-only rebuild** (supersedes v1's server design) |
| [docs/PRD.md](docs/PRD.md) | Product requirements — MVP scope, the creative loop, non-functional requirements |
| [docs/VISION.md](docs/VISION.md) | Product vision, audience, and the strategic baseline |
| [docs/FLOW.md](docs/FLOW.md) | End-to-end user journey and application state machine for the MVP loop |
| [docs/SCHEMA.md](docs/SCHEMA.md) | The store schema of record (SQLite), in DDL form |
| [DESIGN.md](DESIGN.md) | Design system — Nightfall palette, type, geometry, motion, governance |
| [docs/adr/](docs/adr/) | Architecture decision records (0001–0006) — the load-bearing choices and their rationale |
| [docs/CI_GATE.md](docs/CI_GATE.md) | The `main-gate` ruleset: what CI blocks, and the one command that applies it |
| [AGENTS.md](AGENTS.md) | Repo context and the binding rules for agent work (skills, review, PR flow) |

<sub>[`docs/RUNBOOK.md`](docs/RUNBOOK.md) is retained as **retired history** — it documents host-operator
procedures for the v1 server tier the rebuild cancelled. The durability path is now
export/import from the device (ADR-0006). Similarly `docs/API.md`, `docs/DEPLOY.md` and
`docs/DEPLOY_SERVING.md` describe the retired server tier.</sub>

## Contributing & agent guidelines

**Read [`AGENTS.md`](AGENTS.md) before you start** — it is the repository's context and its
binding rules. The essentials:

- **Two required skill sets** live under `.agents/skills/` and are mandatory for any agent
  working here: **superpowers** (agentic dev methodology — entry point
  `.agents/skills/using-superpowers/SKILL.md`) and **ponytail** (smallest change that fully
  solves the task — entry point `.agents/skills/ponytail/SKILL.md`). Announce
  `Using <skill> to <purpose>` when you invoke one.
- **Branch and worktree, never `main`.** Work in a worktree on a branch; leave `main`
  untouched. Branch commits, pushes, dependency installs, and opening PRs need no approval.
- **The only gate is the merge, and the reviewer performs it.** Author ≠ reviewer — the
  assigned reviewer records the verdict as a PR comment (`Review: approve` + evidence,
  since the shared account blocks a formal GitHub self-approval) and then merges with
  `gh pr merge --merge`.
- **A PR closes its issue with a closing keyword** (`Closes #<n>`) **on the closing PR
  only** — a held-lane PR writes `Part of #<n>` and carries no closing keyword anywhere in
  its body or commits. Read `closingIssuesReferences` back after opening a PR.
- **Never sleep or poll.** End the turn and wait to be re-invoked; no bounded wait loops,
  however short.
- **`main` carries a repository ruleset** (`main-gate`); never edit it by hand. Any PR that
  touches `.github/` must show the three required jobs still report
  (`docs/CI_GATE.md`).

## Privacy boundary

User ideas are **not used to train models**, and **leave the device only on a user-requested
provider run**. With no server tier, this is structural rather than a promise: the only
egress is the payload of a run the user asked for, sent device → provider direct on the
**user's own API key** (held in the platform secure store, never in the vault, the export, or
a log). See `docs/ARCHITECTURE.md` v2 §5 and ADR-0006.

## Licence

**Undecided.** The repository carries no licence file, and none is asserted here — treat the
code as all-rights-reserved until a licence is chosen.