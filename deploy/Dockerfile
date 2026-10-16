# syntax=docker/dockerfile:1
# ==============================================================================
# AstroLab — one image, three roles (api · worker · web-init).
#
# The app is one host with three units (`docs/ARCHITECTURE.md` §1): the API and the worker are two
# processes of one codebase that open one SQLite file, and the client is a static bundle served on
# the same origin as `/v1`. This image builds all of them; `docker-compose.yml` decides which
# process each container runs.
# ==============================================================================

# ------------------------------------------------------------------------------
# deps — the runtime dependency tree only (workspaces linked, dev deps omitted)
# ------------------------------------------------------------------------------
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY worker/package.json worker/
COPY store/package.json store/
COPY client/package.json client/
RUN npm ci --omit=dev

# ------------------------------------------------------------------------------
# build — full toolchain; compiles every workspace (store → api/worker, client → static)
# ------------------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY worker/package.json worker/
COPY store/package.json store/
COPY client/package.json client/
RUN npm ci
COPY . .
# Vite inlines `VITE_API_TOKEN` into the bundle at build time (`client/src/api/client.ts`). Build with
# a sentinel so no secret is baked into the image or the registry; the `web-init` service substitutes
# the real bearer from Doppler at container start (`deploy/web-init.mjs`). The build is
# environment-independent — one image serves any config (`docs/DEPLOY.md`, "the client bearer").
ARG VITE_API_TOKEN=__ASTROLAB_API_TOKEN__
ENV VITE_API_TOKEN=$VITE_API_TOKEN
RUN npm run build

# ------------------------------------------------------------------------------
# runtime — the deploy unit: the built workspaces, the runtime tree, and the deploy bundle
# ------------------------------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Doppler CLI. The entrypoint injects the app's secrets into the process at start, so the only
# secret the host ever holds is the SSM-held service token (`docs/DEPLOY.md`, "secrets").
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && curl -sLf --retry 3 https://packages.doppler.com/public/cli/gpg.key \
      | gpg --dearmor -o /usr/share/keyrings/doppler.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/doppler.gpg] https://packages.doppler.com/public/cli/deb/debian any-version main" \
      > /etc/apt/sources.list.d/doppler.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends doppler \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/api/dist ./api/dist
COPY --from=build /app/api/package.json ./api/package.json
COPY --from=build /app/worker/dist ./worker/dist
COPY --from=build /app/worker/package.json ./worker/package.json
COPY --from=build /app/store/dist ./store/dist
COPY --from=build /app/store/package.json ./store/package.json
# `TAXONOMY_PATH` resolves to `store/seed/domain-taxonomy.yaml` from `store/dist` — the seed ships
# beside the build, which is exactly what the `ci.yml` check proves (`the built store still resolves
# its seed file`).
COPY --from=build /app/store/seed ./store/seed
COPY --from=build /app/client/dist ./client/dist

# The deploy bundle travels with the image so the host needs no repository access of its own:
# `deploy/deploy.sh` extracts it to /opt/astrolab on every deploy (`docs/DEPLOY.md`).
COPY deploy/docker-compose.yml deploy/Caddyfile deploy/entrypoint.sh deploy/web-init.mjs \
     deploy/deploy.sh deploy/backup.sh deploy/systemd ./deploy/
RUN chmod +x ./deploy/*.sh \
 && mkdir -p /data

ENTRYPOINT ["/app/deploy/entrypoint.sh"]
