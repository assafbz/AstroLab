#!/usr/bin/env bash
# astrolab-bootstrap.sh — one-time host preparation. Runs ON the host, not from a workstation:
# as EC2 user-data, or pasted into `aws ssm start-session` (`docs/DEPLOY.md`, "the deploy path").
#
# It prepares the machine and stops there. It does not deploy: the first deploy is the CI workflow,
# which installs the stack, its systemd units and the backup timer from the image.
#
# Idempotent — safe to re-run.
#
# Assumes Amazon Linux 2023, the estate's AMI (`docs/DEPLOY.md`, "the host").
set -euo pipefail

REGION="${ASTROLAB_REGION:-us-east-1}"
TAILSCALE_PARAM="${ASTROLAB_TAILSCALE_PARAM:-/astrolab/TAILSCALE_AUTHKEY}"
TAILSCALE_NAME="${ASTROLAB_TAILSCALE_NAME:-astrolab}"

# 1. Docker (the stack), the AWS CLI (SSM + Parameter Store), sqlite (the backup timer's `.backup`).
command -v docker >/dev/null || dnf install -y docker
command -v sqlite3 >/dev/null || dnf install -y sqlite
command -v aws >/dev/null || dnf install -y awscli
systemctl enable --now docker

# 2. The deploy's bind mounts. Docker would create them root-owned and empty on first `up`; creating
#    them here makes a wrong path obvious instead of silent.
install -d -m 755 /opt/astrolab/data /opt/astrolab/backups

# 3. Tailscale. The instance's security group has no inbound rules at all, so this is the only way to
#    reach the app — and the only thing that terminates TLS for it (`docs/DEPLOY.md`, "access").
if ! command -v tailscale >/dev/null; then
  dnf config-manager --add-repo https://pkgs.tailscale.com/stable/amazon-linux/2023/tailscale.repo
  dnf install -y tailscale
fi
systemctl enable --now tailscaled
if ! tailscale status >/dev/null 2>&1; then
  authkey="$(aws ssm get-parameter --region "$REGION" --name "$TAILSCALE_PARAM" \
    --with-decryption --query Parameter.Value --output text 2>/dev/null || true)"
  if [ -z "$authkey" ] || [ "$authkey" = "placeholder_set_via_aws_console" ]; then
    echo "error: no Tailscale auth key at $TAILSCALE_PARAM (see docs/DEPLOY.md)" >&2
    exit 1
  fi
  tailscale up --authkey="$authkey" --hostname="$TAILSCALE_NAME"
fi

echo "bootstrap complete — host is ready for the deploy workflow (docs/DEPLOY.md)"
