# CI gate probe A5 — expected: GREEN, then BEHIND

Reproduction artifact for issue #151 state A5. Opened green against the current `main`;
once another PR merges, `strict_required_status_checks_policy: true` must refuse to merge
it until the branch is updated.
