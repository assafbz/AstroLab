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
   **The gate is opened by a resolvable mention, and answered in one of two
   states.** A PR counts as *ready for review* only once its author has named the
   assigned reviewer with an **explicit identity** (`--mention` / npub). A
   paraphrase `@Name` is presentation, not a wake: on 2026-10-16 #139 sat green
   from 11:11Z to 16:35Z with its ready report carrying only prose `@Name`, and
   moved 11m28s after a mention-carrying directive at 16:24Z — the reviewer had
   not been reached, so that is not reviewer latency. The reviewer answers that
   mention in one of two states — **taking it** (with when) or **parked** (with
   why); a silent hold is the failure mode, and when the reviewer is woken and
   cannot act, that one sentence *is* the deliverable. **Detection threshold:
   >2h** with no answer on the reviewer's mention → the author re-tags — the same
   shape as the >3h fallback for routed owner calls, so the team carries one
   convention rather than two. The threshold detects, it never licenses: the
   reviewer still performs the merge.
3. **A PR closes its issue with a closing keyword, on the closing PR only.** GitHub
   links an issue when the PR body contains a closing keyword followed by an issue
   reference — `#<n>`, `owner/repo#<n>`, or a full issue URL — **anywhere** in the body:
   prose, quotes and parentheses all fire; **code spans and fenced code blocks do not**
   (measured 2026-10-17 on throwaway PR #175 — one form per line, a distinct
   already-closed issue each; reading `closingIssuesReferences` back gave
   `[94,129,141,151]` for the prose, parenthesised and block-quoted forms and nothing for
   the backticked and fenced ones). Position is irrelevant — mid-sentence and own line
   both fire — and **negation is not read**: `this does **not** close #42` fires.
   **Incident-verified** is the `Closes #<n>` form (`[169]` pre-merge on #170, `[171]` on
   #172, `[]` on #173 with no keyword written). The #42 close of 2026-10-16 is
   **re-attributed**: #138's body held *two* matches, and the one that fired was the plain
   prose `deliberately does **not** close #42`; the backticked `Closes #42` beside it was
   inert. That is the shape to watch — a sentence *denying* the close still performs it.
   **Read `closingIssuesReferences` back after opening a PR** — it is what caught this. It
   reads the **body**, not the commits: all **three** of #175's commits were read back —
   one carries a plain-prose keyword + reference, the same shape that fires in a body, and
   the field did not return it (`n=1`, unmerged, so it separates nothing about post-merge
   behaviour; what it does establish is that the read-back **does not clear the commit
   vector**). The other keyword-bearing commit is **not** a second firing shape: its
   subject separates the keyword from its reference with a paren, and that split measures
   **inert** (PR #179, control and test in one body — adjacent fired, paren-split did not;
   body arm E1's parens *wrap* the pair, they do not split it). And read history as history:
   these fields are **current state**. `gh issue view 42 --json closedAt` returns
   `16:35:39Z`, the *last* close, which reads as *"5.5 h after #138 merged, so #138 did
   not do it"*; the record is the `closed → reopened` pair — closed `11:04:45Z`, reopened
   by hand `11:05:20Z`, closed `16:35:39Z` by #139. **Documented, not tested here** is the
   full keyword set GitHub recognises, case-insensitive: `close`/`closes`/`closed`,
   `fix`/`fixes`/`fixed`, `resolve`/`resolves`/`resolved`. A **held-lane** PR — the one that
   deliberately must *not* close its issue yet — therefore leaves the placeholder untouched
   **and carries no literal closing-keyword + reference anywhere in its body or in its
   commit messages** (write `Part of #<n>` throughout). Commits count because the parser
   reads them **where they land on the default branch**, and a lane's do at merge: a keyword
   parked in a commit message executes precisely the close the body was written to avoid,
   and the read-back above cannot see it (*documented, not measured here* — #175 carried
   them and, unmerged, closed nothing). An unreplaced `#<n>` closes nothing, but that is
   **necessary, not sufficient**: any other literal closing keyword in the body still
   fires. Only the **closing** PR writes `Closes #<n>`, with `<n>` replaced by its own issue
   number. A missing keyword has left a finished lane's issue OPEN twice (#94 / PR #96, #37
   / PR #128).

4. **`main` carries a repository ruleset, and the committed definition is the source of truth.**
   The `main-gate` ruleset (`bypass_actors: []` — no actor, the owner included, can bypass it) is
   defined in `.github/rulesets/main-gate.json` and applied with
   `scripts/apply-ci-gate-ruleset.sh`; never edit the live rule in settings by hand, and never
   require a check the workflow does not publish. **Any PR that touches `.github/` must show the
   three required jobs still report on that PR** — a renamed, no-op'd or `paths:`-filtered required
   job is a permanent freeze, not a weaker gate (`docs/CI_GATE.md`).

## Guard discipline — what counts as evidence

A structural claim a test asserts — an import boundary, a single call site, a deterministic
order — counts only once the guard has been seen **failing in the state it forbids**: plant
the violation, watch the suite fail, restore. The guard carries its own **non-vacuity**
assertion too, so it cannot quietly scan nothing, miss the files it exists for, or guard the
wrong package — and a structural claim asserted only in prose (a PR body, a JSDoc line) is not
a check at all.

**A matcher is only as wide as the spellings it normalises.** Where a guard's anchor is *text* — a
declaration, a specifier, a call site — one planted form proves nothing about the others: run the
mutation across the **spelling space** of the thing matched (a rename · a local alias · a qualified
`import("…").X` · an identifier the pattern does not actually bound), keep a **near-miss control**
that must stay green, so the guard cannot buy its reds by over-matching, and pin whatever the matcher
still cannot reach as a **case that asserts the count is 0** rather than as prose.

The failure is one level in from instance 3 below — that one is a matcher blind to an import
**form**, this is a matcher blind to an annotation's **spelling**. **#171** (2026-10-17): the EV6
call-site anchor `\b<receiver>\s*:\s*<InterfaceName>\b` bit for `ex: MechanismExtractor` and let six
spellings of the same declaration through — a qualified import · a local alias · a renamed import · a
rename-then-alias chain · the interface module's own aggregate alias · a `$`-named receiver (whose
`\b` never holds, so that spelling matched nothing at all). Fixed in **#172**; its near-miss control
is the engine's own `Adjudicator`-typed stage, which shares the method name and stays uncounted.

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
