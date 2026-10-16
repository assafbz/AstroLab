# CI gate probe A3 — expected: GREEN

Positive control for issue #151 state A3. This file carries no citation reference and no
code, so every job should pass; the PR must merge under the live gate. It is the
positive control for the `require_extra_approval_for_unattributed_changes` server default:
the commit is agent-authored (unattributed) and carries no approving review.

Closes nothing. Held for the #151 gate proof.
