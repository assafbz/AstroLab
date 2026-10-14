# AGENTS.md — AstroLab

Repository context: product and design intent live in `docs/PRD.md`, `docs/VISION.md`
and `DESIGN.md` — do not contradict those without flagging it. The repo is **no longer
docs-only**: the delivery spine (`api` · `worker` · `client` · `store/`, root tooling, CI) is on
`main` as of 2026-10-13; the product loop itself is still being built.

## Required skills

Two vendored skill sets live under `.agents/skills/` and are **required** for
any agent working in this repo. Read the relevant `SKILL.md` before you start,
and apply it. They are binding instructions, not suggestions. Announce
`Using <skill> to <purpose>` when you invoke one.

1. **superpowers** — agentic dev methodology (`obra/superpowers`, MIT).
   Entry point: `.agents/skills/using-superpowers/SKILL.md`.
   Most-used: `brainstorming` (before designing or building anything),
   `systematic-debugging` (before fixing a bug),
   `writing-plans`, `test-driven-development`,
   `verification-before-completion`.
2. **ponytail** — "lazy senior dev": the smallest change that fully solves the
   task, no unrequested abstraction or dependencies
   (`DietrichGebert/ponytail`, MIT).
   Entry point: `.agents/skills/ponytail/SKILL.md`.

Provenance, pinned commit SHAs, and what was intentionally left out:
`.agents/skills/VENDORED.md`.

## Harness overrides — these win where a skill conflicts

`.agents/skills/using-superpowers/SKILL.md` states that *"User instructions
(CLAUDE.md, AGENTS.md, GEMINI.md, etc, direct requests) take precedence over
skills."* Applied to this repo's harness, that means:

1. **Never sleep or poll.** End the turn and wait to be re-invoked; no bounded
   wait loops, however short.
2. **Only merges need a human — and the reviewer performs them.** Branch commits,
   pushes, dependency installs and opening PRs need **no** approval — work in a
   worktree on a branch and leave `main` untouched. **Merging is the one gate**, and
   since 2026-10-13 the assigned reviewer **approves and merges**: it is no longer a
   stop with the owner (that earlier owner-only rule is superseded). Author ≠ reviewer.
   Agent PRs are opened under one account, so GitHub refuses a formal self-approval —
   record the verdict as a PR comment: an explicit **Review: approve** plus the
   evidence. The `.gitignore` commit in `using-git-worktrees` and the install/build
   steps in `using-git-worktrees` / `ponytail-help` are therefore fine to run on a
   branch.


## Guard discipline — what counts as evidence

A structural claim a test asserts — an import boundary, a single call site, a deterministic
order — counts only once the guard has been seen **failing in the state it forbids**: plant
the violation, watch the suite fail, restore. The guard carries its own **non-vacuity**
assertion too, so it cannot quietly scan nothing, miss the files it exists for, or guard the
wrong package — and a structural claim asserted only in prose (a PR body, a JSDoc line) is not
a check at all.

Five instances in one day (2026-10-14, the W1/W2 lane). All five were found in review, not by
the check itself, except the third, which its own mutation check caught:

- `worker/src/queue.test.ts` — the `cutVault` ascending-id assertion: undiscriminating, because
  the planner's covering-index scan made `ORDER BY id` unobservable (carried to W5 #30).
- `store/test/vault-writes.test.ts` — the un-export check shipped as a **text grep**, blind to
  `export * from "./store.js"`; #76 replaced it with the property form.
- `worker/src/provider/boundary.test.ts` — the specifier extractor matched `from "…"` only, so
  a side-effect import had no `from` to match.
- the same file's walk — `api`/`store` only and `.ts` only: `client/` was unguarded, and a
  `.tsx` was invisible even inside a scanned package.
- "the adapter has no DB access" — asserted in prose, never checked: `import { openStore }`
  in `openrouter.ts` left typecheck clean and the worker suite 54/54 green.
