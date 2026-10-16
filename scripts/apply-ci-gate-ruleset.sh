#!/usr/bin/env bash
#
# Apply the `main-gate` repository ruleset to `main` — the server-side gate.
#
# Source of truth: .github/rulesets/main-gate.json. The gate is server-side configuration, so the
# definition lives in the repo and this one command pushes it. Changing the gate means changing that
# file and re-running this — reviewable and diffable — not clicking through settings by hand.
#
# Applying it is the deliberate act: with `bypass_actors: []`, nobody — the owner, or the shared
# admin token that opens every PR — can push to `main` or merge a red PR, and the only way around it
# is editing or deleting the ruleset. This script creates the gate it is not itself subject to; that
# ordering is expected. A key the API does not accept is rejected (HTTP 422), so a wrong field name
# fails loud rather than quietly weakening the rule.
#
#   scripts/apply-ci-gate-ruleset.sh              apply — create, or update by name (idempotent)
#   scripts/apply-ci-gate-ruleset.sh --dry-run    print the payload + the current live state; mutate nothing
#   scripts/apply-ci-gate-ruleset.sh --self-check offline: the spec's shape, and its required contexts
#                                                 byte-match the workflow's job names (the freeze trap)
#
# Requires: gh (admin on the repo), jq. `REPO=owner/name` overrides the remote-derived repo.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
spec="$root/.github/rulesets/main-gate.json"
workflow="$root/.github/workflows/ci.yml"

die() { echo "error: $*" >&2; exit 1; }

[ -f "$spec" ] || die "no spec at $spec"
command -v jq >/dev/null || die "jq is required"
jq -e . "$spec" >/dev/null || die "$spec is not valid JSON"
name=$(jq -r .name "$spec")

# Offline. The one thing this lane can get silently wrong is a required context that never reports:
# a renamed job in `ci.yml` leaves the ruleset requiring a name nothing publishes, and every PR then
# sits `blocked` with no failing check to point at — a permanent freeze, not a weaker gate. Compare
# the spec against the workflow byte-for-byte, and assert the comparison is not vacuous.
self_check() {
  [ "$(jq '.bypass_actors | length' "$spec")" = 0 ] \
    || die "bypass_actors must be empty — any entry re-opens the gate for the admin token"
  [ "$(jq -r .enforcement "$spec")" = active ] || die "enforcement must be 'active'"
  [ "$(jq -r .target "$spec")" = branch ] || die "target must be 'branch'"
  [ "$(jq -r '.conditions.ref_name.include | join(",")' "$spec")" = refs/heads/main ] \
    || die "the gate must target refs/heads/main only"

  local types t
  types=$(jq -r '.rules[].type' "$spec")
  for t in required_status_checks pull_request non_fast_forward deletion; do
    grep -qxF "$t" <<<"$types" || die "missing rule: $t"
  done

  local req
  req=$(jq -r '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context' "$spec")
  [ "$(wc -l <<<"$req")" = 3 ] || die "expect 3 required checks, found $(wc -l <<<"$req")"
  [ "$(jq '[.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[]
             | select(.integration_id != 15368)] | length' "$spec")" = 0 ] \
    || die "every required check must pin integration_id 15368 (github-actions) — a bare name is satisfiable by any app"
  grep -q '^PRIV1 ' <<<"$req" \
    && die "PRIV1 (the live-provider job) must stay non-required — a third party cannot be allowed to block a merge"

  # two fields whose *inherited* value is a freeze rather than a weaker gate
  local pr
  pr=$(jq -c '.rules[] | select(.type=="pull_request") | .parameters' "$spec")
  jq -e '.required_approving_review_count == 0' <<<"$pr" >/dev/null \
    || die "required_approving_review_count must be 0 — every PR opens under one account, so any approval requirement freezes every merge"
  jq -e '.require_extra_approval_for_unattributed_changes == false' <<<"$pr" >/dev/null \
    || die "require_extra_approval_for_unattributed_changes must be explicit false — agent commits are unattributed, so the default true demands an approval that cannot exist"

  # a job's `name:` sits at 4-space indent (`jobs:` members are at 2, steps deeper)
  local jobs
  jobs=$(grep -E '^    name: ' "$workflow" | sed 's/^    name: //')
  [ "$(wc -l <<<"$jobs")" = 4 ] \
    || die "parsed $(wc -l <<<"$jobs") job names from $(basename "$workflow"), expected 4 — the parse is wrong, not the spec"

  local c
  while IFS= read -r c; do
    grep -qxF "$c" <<<"$jobs" \
      || die "required context is not published by any job in ci.yml: [$c]
       a renamed job is a permanent freeze — every PR blocked with no failing check to point at"
  done <<<"$req"

  echo "self-check OK — spec valid · bypass_actors empty · 3 required contexts byte-match ci.yml job names"
}

case "${1:-}" in
  --self-check) self_check; exit 0 ;;
  --dry-run | "") ;;
  *) die "usage: $(basename "$0") [--dry-run|--self-check]" ;;
esac

self_check
repo=${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}
existing=$(gh api "repos/$repo/rulesets" --jq ".[] | select(.name==\"$name\") | .id" 2>/dev/null || true)

if [ "${1:-}" = --dry-run ]; then
  echo "repo=$repo"
  echo "payload ($spec):"
  jq . "$spec"
  if [ -n "$existing" ]; then
    echo "live: ruleset '$name' exists (id=$existing) — applying would UPDATE it:"
    gh api "repos/$repo/rulesets/$existing" | jq '{id, name, enforcement, bypass_actors, rules: [.rules[].type]}'
  else
    echo "live: no ruleset named '$name' — applying would CREATE it (nothing is enforced today)"
  fi
  exit 0
fi

if [ -n "$existing" ]; then
  out=$(gh api -X PUT "repos/$repo/rulesets/$existing" --input "$spec")
else
  out=$(gh api -X POST "repos/$repo/rulesets" --input "$spec")
fi

# Read it back from the API: what landed, not what we sent.
echo "$out" | jq -r '"applied: id=\(.id)  name=\(.name)  enforcement=\(.enforcement)  bypass_actors=\(.bypass_actors | length)"'
echo "$out" | jq -r '.rules[] | select(.type=="required_status_checks") | .parameters
  | "  strict=\(.strict_required_status_checks_policy)\n  required:\n  " +
    ([.required_status_checks[] | "\(.context)  @\(.integration_id)"] | join("\n  "))'
