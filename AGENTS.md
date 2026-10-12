# AGENTS.md — AstroLab

Repository context: **docs-only** at this stage. Product and design intent live
in `docs/PRD.md`, `docs/VISION.md`, and `DESIGN.md`. Do not contradict those
without flagging it.

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
