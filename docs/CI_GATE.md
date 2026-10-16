# CI GATE — enforcing `main`

What CI *checks* and what CI *blocks* are two different things. Until the `main-gate` ruleset is
applied, `main` is unprotected: a red `citations` or `o1-taxonomy` job does not stop a merge, and a
direct push to `main` is allowed — the "required" gate is honour-system. This document is the
definition of the gate, the one command that applies it, and the duties the gate cannot enforce on
its own.

**Status (2026-10-16).** Not live yet — measured, `gh api repos/assafbz/AstroLab/rulesets` → `[]`
and `branches/main/protection` → 404. Only once this is applied does a direct push to `main` get
refused and a red required check block a merge. The live apply waits on the owner call —
`bypass_actors: []` changes how the owner lands work — and the proof (A1–A5, §5) runs against the
live gate.

## 1 · The object

- **Definition (source of truth):** `.github/rulesets/main-gate.json` — one reviewable, diffable
  JSON object. The gate is server-side configuration; this file is what the server is meant to hold.
- **Apply:** `scripts/apply-ci-gate-ruleset.sh` — creates the ruleset, or updates it by name
  (idempotent). `--dry-run` prints the payload and the current live state and mutates nothing;
  `--self-check` is offline (§4).
- **Revoke / change:** edit the JSON and re-run the script. There is **no override** — with
  `bypass_actors: []`, undoing the gate means editing or deleting the ruleset, a deliberate and
  audible act rather than a per-merge bypass.
- A key the API does not accept is rejected (HTTP 422). A wrong field name fails **loud**, not by
  silently weakening the rule.
- Applying the ruleset cannot itself go through the gate it creates — that ordering is expected.

## 2 · What is required — 3 of the 4 jobs

GitHub requires checks per **job**, not per step, and `build` is one job. A failing step reddens its
job, so requiring `build` enforces all six of its sub-checks; splitting it would buy parallelism only
and would change the context strings.

| job (`name:` = the context string) | required | why |
| :-- | :-- | :-- |
| `lint · format · typecheck · test · build` | **yes** | the core — lint, format, typecheck, 4 workspace suites, build, and the built-store seed check a unit suite cannot see |
| `citation ref-lint — §X.Y item N form` | **yes** | deterministic, no `npm ci`; the docs *are* the spec |
| `o1-taxonomy — canonical harness on the shipped seed file` | **yes** | a product invariant, carrying its own negative (`--strict` must fail) |
| `PRIV1 — capture + audit OpenRouter's ZDR endpoint list (non-required)` | **no** | makes a live provider call — a third party must not be able to block a merge |

**A required context is matched byte-for-byte.** `·` is U+00B7, `—` U+2014, `§` U+00A7 — not
period/hyphen/`S`. A required context that never reports is not a weaker gate: every PR sits
`blocked` with no failing check to point at, a **permanent freeze**. The three strings in the JSON
were lifted from the check-runs API, never retyped, and `--self-check` keeps them honest (§4).

## 3 · The fields that carry the gate

| field | value | what it does |
| :-- | :-- | :-- |
| `bypass_actors` | `[]` | **the gate.** Any entry — the `Repository admin` role included — re-opens it, because that role is the shared token every PR is pushed with |
| `integration_id` | `15368` | pins the publisher to `github-actions`; a bare name could be satisfied by any app |
| `strict_required_status_checks_policy` | `true` | the PR's base must be current — a green run from a stale base cannot merge into a moved `main` |
| `require_extra_approval_for_unattributed_changes` | `false` | **load-bearing, not hygiene.** Every agent commit is authored by an unattributed `.local` identity, so every agent PR carries unattributed changes by construction; the server default `true` would demand an approval that cannot exist (one shared GitHub account, no second approver) — a permanent freeze |
| `required_approving_review_count` | `0` | reviews can never be *required* — every PR opens under one account, so a required approval would freeze every merge. Agent review stays a duty (see `AGENTS.md`), not a rule |
| `allowed_merge_methods` | `["merge"]` | states what the repo already does instead of inheriting a server default: 30/30 recent merged PRs (`#112`–`#149`) are 2-parent merge commits, zero squash tips. Without the pin the default also allows `squash`/`rebase` on `main` |

**Refused: `required_linear_history`.** It forbids merge commits, and the repo merges with `--merge`
— a gate that breaks the team's merge convention is not this lane. The `allowed_merge_methods` pin
and this refusal are the two halves of one position: merge commits stay, and they are the only
merge method that lands on `main`.

## 4 · What the gate cannot see

- **Its own definition.** The required jobs live in `.github/workflows/ci.yml`, which a PR can edit:
  a renamed, no-op'd or conditionally **skipped** required job can still read green. Requiring a
  check is not the same as the check still meaning what it meant.
- **Its own disarming.** The admin token can edit or delete the ruleset; nothing today asserts the
  live rule equals the committed one (drift check — follow-up).
- **Semantics.** No approval is required, so green means "the machine checks passed", nothing more.
- **`main` after the merge.** The `push: [main]` run *reports* a red `main`; `strict` is the only
  prevention that exists.

**Two duties that compensate — both on humans:**

1. **Any PR touching `.github/` must show the three required jobs still report on that PR.** A
   rename or a `paths:` filter is a permanent freeze in waiting. Run `scripts/apply-ci-gate-ruleset.sh
   --self-check` — it compares the spec's contexts against the workflow's job names byte-for-byte,
   and is non-vacuous (it asserts it parsed 4 job names).
2. **Do not require `PRIV1`.** Its red can have an external cause (provider downtime); the design
   keeps it non-required for exactly that reason, and `--self-check` fails if it is ever required.

## 5 · Proof of bite

Enforcement is server-side, so it cannot be a unit test: the proof is that the server **refuses the
state it must forbid**, run under the same admin token that opens every PR. Reviewed and merged by
the review seat, not the author.

| # | state reproduced | expected |
| :-- | :-- | :-- |
| A1 | a red required check on a PR; `gh pr merge --merge` **and** `gh pr merge --admin` | both refused |
| A2 | `git push origin HEAD:main`, and a force variant | refused |
| A3 | an all-green, agent-authored, approval-free PR (**the positive control** — confirms the gate is not a freeze) | merges |
| A4 | a required context that does not run | PR sits `blocked` — no silent pass on a skip |
| A5 | a PR behind `main` (`strict`) | blocked until updated |

## 6 · Follow-ups (recorded, not built here)

- **Drift check** — a scheduled job diffing the live ruleset against the committed JSON, failing
  closed.
- **Wire `--self-check` into CI** — one step in the existing `build` job (a step, so the required
  context string is unchanged) would catch a spec ↔ workflow disagreement on the PR that causes it,
  rather than at the next hand-run. A workflow edit, so not in this lane.
- **Split the ZDR self-check** — the offline self-check is deterministic and could be required; the
  live call cannot. They are bundled in `PRIV1` today; splitting is a workflow edit, out of this lane.
- **No client/E2E gate** — a check must exist before it can be required; no browser harness exists.
- **No security scanning** — separate item.

Read the full blind-spot and gap tables on the CI-gate lane's issue.
