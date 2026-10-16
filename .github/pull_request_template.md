Closes #<n>

<!--
First line on purpose, and inert on purpose: an unreplaced `#<n>` closes
nothing. Replace `<n>` with the issue number **only** on the PR that completes
the issue — a held-lane PR, the one that deliberately must *not* close it yet,
leaves the placeholder untouched **and carries no other literal closing keyword**
(`Closes`/`Fixes`/`Resolves` + a `#<n>`-style reference) anywhere in its body;
write `Part of #<n>`. The same rule sits beside the merge rule in `AGENTS.md`.
-->

## Evidence

`git rev-parse HEAD` in the same shell as every run below. CI at the head is the
verdict.

| check                                     | result |
| :---------------------------------------- | :----- |
| `npm test --testTimeout=30000`            |        |
| `lint` · `format` · `typecheck` · `build` |        |
| `lint:citations`                          |        |

**Review:** author ≠ reviewer — **approve and merge**, with the verdict as a PR
comment (the shared account blocks a formal self-approval).
