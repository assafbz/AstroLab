# Vendored agent skills

Third-party skill sets vendored into this repo under `.agents/skills/` so that
agents working here read and apply them. Both sources are **MIT licensed**
(permissive) — licence texts are carried alongside at
`.agents/skills/licenses/`.

Repo `AGENTS.md` names these as **required** and points here.

---

## 1. superpowers

- **Source:** https://github.com/obra/superpowers
- **Pinned commit:** `bb92a77741419a4ab5f06e711a283343f1ada0c3` (2026-10-09)
- **Licence:** MIT © 2025 Jesse Vincent — see `licenses/superpowers.MIT`
- **Included:** all 15 skills from the upstream `skills/` directory
  (`brainstorming`, `diagnosing-superpowers`, `dispatching-parallel-agents`,
  `executing-plans`, `finishing-a-development-branch`, `receiving-code-review`,
  `requesting-code-review`, `subagent-driven-development`, `systematic-debugging`,
  `test-driven-development`, `using-git-worktrees`, `using-superpowers`,
  `verification-before-completion`, `writing-plans`, `writing-skills`).
- **Omitted (skills subset):** the upstream `hooks/` (session-start bootstrap),
  root `scripts/` (installer), `tests/`, `docs/`, `RELEASE-NOTES.md`, the
  per-harness plugin manifests (`.claude-plugin/`, `.codex-plugin/`,
  `.cursor-plugin/`, …), and the upstream `AGENTS.md` (contributor rules for the
  superpowers repo itself, not relevant here).

  Rationale: this repo is still **docs-only** and the harness in use has no
  superpowers session-start hook, so the plugin/hook bootstrap would not execute
  anyway. The skill content — which is the part that shapes agent behaviour — is
  vendored in full. Note upstream's own caution: skills copied onto disk without
  the session-start bootstrap are not auto-invoked by that framework; here the
  invocation mechanism is the **Required skills** section in `AGENTS.md`.

## 2. ponytail

- **Source:** https://github.com/DietrichGebert/ponytail
- **Pinned commit:** `9b58c1ffb790c075ca32e70a89cf1d80588f4abf` (2026-10-10)
- **Licence:** MIT © 2026 DietrichGebert — see `licenses/ponytail.MIT`
- **Included:** all 6 skills from the upstream `skills/` directory
  (`ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`,
  `ponytail-gain`, `ponytail-help`).
- **Omitted:** the upstream `hooks/` (lifecycle hooks that require a Claude
  Code / Codex / Cursor plugin host and `node`), `commands/`, root `scripts/`,
  `tests/`, `i18n/`, `benchmarks/`, plugin manifests, and `skills/plugin.json`
  (plugin packaging).

---

## Updating a vendored skill

Re-vendor from the pinned commit and update the SHA above:

```bash
git clone https://github.com/obra/superpowers /tmp/superpowers
git -C /tmp/superpowers checkout <new-sha>
rsync -a --exclude '.git' /tmp/superpowers/skills/ .agents/skills/
```

Then update the pinned SHA and date in this file.
