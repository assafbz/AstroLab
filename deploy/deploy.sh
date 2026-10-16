#!/usr/bin/env bash
# astrolab-deploy.sh — the host side of the deploy path (`docs/DEPLOY.md`, "the deploy path").
#
# Two callers, one code path:
#   * CI → SSM RunCommand passes the new image ref: refresh the bundle and the image, then come up.
#   * systemd runs it with no argument at boot: bring up whatever image is already recorded.
#
# The image is the artifact of record: it carries this script, the compose file, the Caddyfile and the
# systemd units, so nothing here is fetched from the repository and the host needs no repo credentials.
set -euo pipefail

ROOT=/opt/astrolab
REGION="${ASTROLAB_REGION:-us-east-1}"
DOPPLER_PARAM="${ASTROLAB_DOPPLER_PARAM:-/astrolab/DOPPLER_TOKEN}"
DOPPLER_PROJECT="${DOPPLER_PROJECT:-astrolab}"
DOPPLER_CONFIG="${DOPPLER_CONFIG:-prd}"
COMPOSE=(docker compose -f "$ROOT/docker-compose.yml")

IMAGE="${1:-}"

# Both bind mounts must exist before the first `up` — Docker would otherwise create them root-owned
# and empty, which is fine for data but hides a wrong path.
install -d -m 755 "$ROOT/data" "$ROOT/backups"

if [ -n "$IMAGE" ]; then
  echo "[deploy] image $IMAGE"
  aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin "${IMAGE%%/*}" >/dev/null

  # The bundle is refreshed before the units are installed, so a change to the compose file, the
  # Caddyfile or a unit ships in the same artifact as the code it belongs to. (The first deploy has
  # no bundle here yet; the CI command extracts it before calling this script.)
  cid="$(docker create "$IMAGE")"
  trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
  docker cp "$cid:/app/deploy/." "$ROOT/"
  docker rm -f "$cid" >/dev/null
  trap - EXIT

  install -m 644 "$ROOT"/systemd/*.service "$ROOT"/systemd/*.timer /etc/systemd/system/
  systemctl daemon-reload
  # Installed but not enabled is a stack that does not come back after a reboot. `--now` on the timer
  # starts it; the service is enabled only, because this script is already bringing the stack up.
  systemctl enable astrolab.service
  systemctl enable --now astrolab-backup.timer
  # `ASTROLAB_IMAGE` is the one thing a deploy changes; it is not a secret, so it lives in a file.
  printf 'ASTROLAB_IMAGE=%s\n' "$IMAGE" >"$ROOT/image.env"
fi

# shellcheck disable=SC1091
. "$ROOT/image.env"
export ASTROLAB_IMAGE
export DOPPLER_PROJECT DOPPLER_CONFIG

# The only secret on the host, and only for as long as this process lives: the Doppler service token,
# read from SSM Parameter Store. Every app secret is resolved inside the container (`deploy/entrypoint.sh`).
DOPPLER_TOKEN="$(aws ssm get-parameter --region "$REGION" --name "$DOPPLER_PARAM" \
  --with-decryption --query Parameter.Value --output text)"
export DOPPLER_TOKEN

"${COMPOSE[@]}" up -d --remove-orphans

# A deploy that cannot serve is a failed deploy: prove the proxy reaches the API before reporting
# success (the SSM command's exit status is what CI reads). Bounded, because Caddy needs a moment.
for _ in $(seq 1 30); do
  if "${COMPOSE[@]}" exec -T web wget -q -O- http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
    echo "[deploy] serving: $(cat "$ROOT/image.env")"
    # Publish on the tailnet, not a public port. `serve` state lives in tailscaled, so this is
    # idempotent and self-heals after a host rebuild. HTTPS is Tailscale's certificate, which needs the
    # tailnet's HTTPS/MagicDNS setting on (`docs/DEPLOY.md`, "access").
    if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
      tailscale serve --bg --https=443 http://127.0.0.1:8080 >/dev/null 2>&1 ||
        tailscale serve --bg 8080 >/dev/null 2>&1 ||
        echo "[deploy] warning: 'tailscale serve' not applied — check the tailnet HTTPS setting" >&2
    fi
    docker image prune -a -f --filter "until=168h" >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 2
done
echo "[deploy] FAILED — the stack did not answer /healthz through the proxy" >&2
"${COMPOSE[@]}" ps >&2 || true
exit 1
