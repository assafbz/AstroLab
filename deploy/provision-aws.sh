#!/usr/bin/env bash
#
# Provision the AWS side of AstroLab's deploy path: the registry, the identity CI deploys with, and
# the two SSM parameters the host reads. Idempotent — it creates what is missing and leaves what is
# there, so re-running it is a no-op.
#
# The definition lives here, in the same spirit as `scripts/apply-ci-gate-ruleset.sh`: the deploy path
# is server-side configuration, so it is reviewable and diffable rather than clicked together in a
# console. What it deliberately does NOT create is the host and its network — that is the owner's call
# on where AstroLab runs (`docs/DEPLOY.md`, "what is not here yet").
#
#   deploy/provision-aws.sh --instance i-0123456789abcdef0
#   deploy/provision-aws.sh --dry-run --instance i-…      print the calls; change nothing
#   deploy/provision-aws.sh --self-check                  offline: the payloads it would send
#
# Requires: aws (an admin principal), jq.
set -euo pipefail

region="${AWS_REGION:-us-east-1}"
gh_repo="assafbz/AstroLab"
ecr_name="astrolab"
role_name="github-actions-astrolab-deployer"
instance=""
dry_run=0
self_check=0

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --region) region="$2"; shift 2 ;;
    --repo) gh_repo="$2"; shift 2 ;;
    --instance) instance="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --self-check) self_check=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

command -v jq >/dev/null || die "jq is required"
command -v aws >/dev/null || die "aws is required"

# ---------------------------------------------------------------- payloads

# The role CI assumes, scoped to this repository only: a bare `repo:assafbz/*` would let any other
# repo in the account take the deploy role.
trust_policy() {
  local oidc="$1"
  jq -n --arg oidc "$oidc" --arg repo "$gh_repo" '{
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Federated: $oidc },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        StringLike: { "token.actions.githubusercontent.com:sub": ("repo:" + $repo + ":*") }
      }
    }]
  }'
}

# What CI may do: push to this one registry, and drive the deploy on this one instance. Notably not
# `ssm:GetParameter` — reading secrets is the host role's job, not the deployer's.
deploy_policy() {
  jq -n --arg region "$region" --arg acct "$account" --arg inst "$instance" \
    --arg ecr "arn:aws:ecr:$region:$account:repository/$ecr_name" '{
    Version: "2012-10-17",
    Statement: [
      { Sid: "ECRAuthToken", Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: "*" },
      { Sid: "ECRPush", Effect: "Allow", Action: [
          "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage"
        ], Resource: $ecr },
      { Sid: "SSMDeploy", Effect: "Allow", Action: ["ssm:SendCommand"], Resource: [
          ("arn:aws:ec2:" + $region + ":" + $acct + ":instance/" + $inst),
          ("arn:aws:ssm:" + $region + ":*:document/AWS-RunShellScript")
        ] },
      { Sid: "SSMDeployStatus", Effect: "Allow", Action: ["ssm:GetCommandInvocation"], Resource: "*" }
    ]
  }'
}

run() {
  if [ "$dry_run" = 1 ]; then
    echo "  would: aws $*" >&2
    return 0
  fi
  aws "$@"
}

# ---------------------------------------------------------------- self-check (offline)

if [ "$self_check" = 1 ]; then
  account=000000000000
  instance=i-00000000000000000
  oidc_arn=arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com
  ok=1
  pass() { echo "✓ $1"; }
  fail() {
    echo "✗ $1" >&2
    ok=0
  }

  trust=$(trust_policy "$oidc_arn")
  sub=$(jq -r '.Statement[0].Condition.StringLike["token.actions.githubusercontent.com:sub"]' <<<"$trust")
  [ "$sub" = "repo:$gh_repo:*" ] && pass "trust is scoped to $gh_repo" || fail "trust is not scoped to the repository: $sub"
  jq -e '.Statement[0].Condition.StringLike["token.actions.githubusercontent.com:sub"] | test("^repo:[^/]+/[^:]+:[^/]")' <<<"$trust" >/dev/null &&
    pass "trust wildcard covers only the ref, not the owner" || fail "trust lets the wildcard cross the owner boundary"

  pol=$(deploy_policy)
  for action in ecr:GetAuthorizationToken ecr:PutImage ssm:SendCommand ssm:GetCommandInvocation; do
    jq -e --arg a "$action" '[.. | strings] | index($a) != null' <<<"$pol" >/dev/null ||
      fail "deploy policy is missing $action"
  done
  pass "deploy policy carries the four actions the path needs"
  jq -e '[.. | strings] | index("ssm:GetParameter") == null' <<<"$pol" >/dev/null &&
    pass "deploy policy grants no parameter read — the host role owns that, not CI" ||
    fail "deploy policy should not read parameters (the host role does)"

  echo "$([ "$ok" = 1 ] && echo 'self-check: all cases pass' || echo 'self-check: FAILED')"
  exit $((1 - ok))
fi

# ---------------------------------------------------------------- provision

[ -n "$instance" ] || die "--instance is required (the SSM target; see docs/DEPLOY.md)"
account=$(aws sts get-caller-identity --query Account --output text)
echo "region=$region account=$account repo=$gh_repo instance=$instance dry_run=$dry_run" >&2

# 1. Registry. Tagged by commit sha; keep the last five, scan on push.
if aws ecr describe-repositories --region "$region" --repository-names "$ecr_name" >/dev/null 2>&1; then
  echo "ECR $ecr_name exists" >&2
else
  run ecr create-repository --region "$region" --repository-name "$ecr_name" \
    --image-scanning-configuration scanOnPush=true --output json >/dev/null
fi
run ecr put-lifecycle-policy --region "$region" --repository-name "$ecr_name" \
  --lifecycle-policy-text '{"rules":[{"rulePriority":1,"description":"Keep the last 5 images","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":5},"action":{"type":"expire"}}]}' \
  --output json >/dev/null

# 2. The OIDC provider is per-account and the estate already has one for GitHub. Reuse it — a second
#    provider for the same URL is an error, not a second identity.
oidc_arn=$(aws iam list-open-id-connect-providers \
  --query "OpenIDConnectProviderList[?contains(Arn,'token.actions.githubusercontent.com')].Arn | [0]" \
  --output text)
[ -n "$oidc_arn" ] && [ "$oidc_arn" != "None" ] ||
  die "no GitHub OIDC provider in this account — create one for token.actions.githubusercontent.com first"
echo "OIDC provider $oidc_arn" >&2

# 3. The role CI assumes: create it, or re-point the trust if it drifted.
trust_json=$(trust_policy "$oidc_arn")
if aws iam get-role --role-name "$role_name" >/dev/null 2>&1; then
  echo "role $role_name exists — re-pointing its trust" >&2
  run iam update-assume-role-policy --role-name "$role_name" --policy-document "$trust_json"
else
  run iam create-role --role-name "$role_name" --description "AstroLab deploy (GitHub Actions OIDC)" \
    --assume-role-policy-document "$trust_json" --output json >/dev/null
fi
run iam put-role-policy --role-name "$role_name" --policy-name astrolab-deploy \
  --policy-document "$(deploy_policy)"

# 4. The two parameters the host reads. Created empty; the values go in with `put-parameter
#    --overwrite` by hand, so re-running this can never blank a live token.
for param in /astrolab/DOPPLER_TOKEN /astrolab/TAILSCALE_AUTHKEY; do
  if aws ssm get-parameter --region "$region" --name "$param" >/dev/null 2>&1; then
    echo "parameter $param exists — left alone" >&2
  else
    run ssm put-parameter --region "$region" --name "$param" --type SecureString \
      --value placeholder_set_via_aws_console --description "AstroLab (docs/DEPLOY.md)" >/dev/null
  fi
done

if [ "$dry_run" = 1 ]; then
  echo "dry run — nothing changed" >&2
  exit 0
fi

cat <<EOF

Provisioned. Set these repository *variables* on $gh_repo
(Settings → Secrets and variables → Actions → Variables):
  AWS_REGION               $region
  AWS_ROLE_ARN             arn:aws:iam::$account:role/$role_name
  AWS_EC2_INSTANCE_ID      $instance
  ASTROLAB_DEPLOY_ENABLED  true          # the deploy workflow is inert until this is set

Then fill the two parameters (never committed, never printed):
  aws ssm put-parameter --region $region --name /astrolab/DOPPLER_TOKEN --type SecureString --value 'dp.st.prd.…' --overwrite
  aws ssm put-parameter --region $region --name /astrolab/TAILSCALE_AUTHKEY --type SecureString --value 'tskey-auth-…' --overwrite
EOF
