#!/usr/bin/env bash
# AstroLab container entrypoint — the seam between "what the container runs" and "which secrets it
# runs with".
#
# `docker-compose.yml` sets the command per service (`node api/dist/index.js`, …); this wraps it so
# every container resolves the app's secrets the same way. `DOPPLER_TOKEN` is the only secret the host
# holds, and it comes from SSM Parameter Store at deploy time (`docs/DEPLOY.md`, "secrets").
#
# Shortcut: when `DOPPLER_TOKEN` is unset the command runs with the container's own environment. That
# is the local `docker run` path, not the deployed one — on the host the token is always set, so a
# missing token there is a broken deploy rather than a silent fallback.
set -euo pipefail

if [ -n "${DOPPLER_TOKEN:-}" ]; then
  exec doppler run \
    --project "${DOPPLER_PROJECT:-astrolab}" \
    --config "${DOPPLER_CONFIG:-prd}" \
    -- "$@"
fi

echo "[entrypoint] DOPPLER_TOKEN unset — running '$*' with the container environment" >&2
exec "$@"
