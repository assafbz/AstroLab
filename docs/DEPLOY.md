# DEPLOY — the host layer

How AstroLab runs outside a developer's machine: one host, the same three units the architecture names
(`docs/ARCHITECTURE.md` §1) — the API, the worker, and the SQLite file behind them — plus the static
client, served on the same origin as `/v1`.

This is the deployment path the estate already runs for Cortex (`assafbz/Cortex`, `docs/AWS_DEPLOYMENT.md`):
GitHub Actions builds an image, pushes it to ECR, and drives the host through SSM RunCommand. The host
opens **no inbound port**.

> **Status.** Artifacts on a branch, reviewed before anything is provisioned. No host, registry or
> parameter exists for AstroLab yet, and nothing in this document has been run against one. What *has*
> been verified is listed under "Evidence at this head".

## Where the pieces live

| File | What it is |
| :-- | :-- |
| `deploy/Dockerfile` | The image: builds all four workspaces, runs as the api/worker/web-init roles |
| `deploy/docker-compose.yml` | The host's unit set — `api`, `worker`, `web-init`, `web` |
| `deploy/Caddyfile` | The one origin: the client bundle and `/v1` on one host |
| `deploy/entrypoint.sh` | Resolves the app's secrets inside the container (`doppler run`) |
| `deploy/web-init.mjs` | Puts the built client in the webroot, substituting the real bearer |
| `deploy/deploy.sh` | The host side of the deploy path (SSM and systemd both call it) |
| `deploy/backup.sh` + `deploy/systemd/astrolab-backup.*` | The nightly backup timer |
| `deploy/systemd/astrolab.service` | Brings the stack back after a reboot |
| `deploy/provision-aws.sh` | Creates the registry, the CI role and the SSM parameters (owner-run) |
| `deploy/bootstrap-host.sh` | One-time host preparation (Docker, sqlite, Tailscale) |
| `.github/workflows/deploy.yml` | The deploy path |

## The deploy path

```
  git push main ──▶ GitHub Actions ──OIDC──▶ AWS STS
                        │  build deploy/Dockerfile
                        ├──────────────────▶ ECR  astrolab:<sha>
                        │
                        └── SSM RunCommand ─▶ host ── docker pull <sha>
                                                   │  extract /app/deploy → /opt/astrolab
                                                   │  systemctl daemon-reload
                                                   │  doppler run … docker compose up -d
                                                   └─ verify /healthz through the proxy
```

1. **Merge to `main`.** `ci.yml`'s three required checks gate the merge; `deploy.yml` runs after it.
2. **Build and push.** One image, tagged `astrolab:<commit-sha>`. The tag is the rollback unit.
3. **SSM RunCommand** drives the host: ECR login, `docker pull`, extract the deploy bundle that travels
   inside the image, then `bash /opt/astrolab/deploy.sh <image>`.
4. **The host comes up.** `deploy.sh` refreshes the bundle and the systemd units, reads the Doppler
   service token from SSM, brings the stack up, and **verifies `/healthz` through the proxy** — the
   SSM command's exit status is the deploy's verdict, so a deploy that cannot serve fails.

The workflow is **inert until provisioned**: it does nothing unless the `ASTROLAB_DEPLOY_ENABLED`
repository variable is `true`. Merging it before the owner provisions cannot redden `main`.

### Provisioning (owner-run, once)

```sh
deploy/provision-aws.sh --dry-run --instance i-…   # see exactly what it would create
deploy/provision-aws.sh --instance i-…
```

It creates the ECR repository, the `github-actions-astrolab-deployer` OIDC role scoped to this
repository, and `/astrolab/DOPPLER_TOKEN` + `/astrolab/TAILSCALE_AUTHKEY` as SecureString parameters
— then prints the four repository variables and the two `put-parameter` calls that carry the real
values. It is idempotent, and it never overwrites a parameter that exists, so re-running it cannot
blank a live token.

## The host

Amazon Linux 2023, one `t3.small`, the estate's instance shape. `deploy/bootstrap-host.sh` prepares it
— Docker, `sqlite3`, the AWS CLI, Tailscale — and stops there.

```
/opt/astrolab/
  docker-compose.yml  Caddyfile  deploy.sh  entrypoint.sh  web-init.mjs  backup.sh  systemd/
  image.env           # ASTROLAB_IMAGE=<the deployed tag> — not a secret
  data/astrolab.sqlite  data/astrolab.sqlite-wal  data/astrolab.sqlite-shm
  backups/astrolab-<utc-stamp>.sqlite
```

`data/` and `backups/` are host bind mounts. The database is one file, exactly as ADR-0001 describes
it, and both writers are containers on this one host — one filesystem, one file lock.

**One volume, one host, one filesystem** — `api` and `worker` mount the *same* `data/` bind mount, and
it must stay a local disk. WAL coordinates the two writers through the kernel's file lock, which a
network filesystem does not carry: NFS or EFS in that path would break the lock, not just slow it down.
`backups/` is on the same volume too (the one deliberate gap — see "what is not here yet").

## Secrets

**No secret is ever written to the host.** The only one the host touches is the Doppler service token,
read from SSM Parameter Store at deploy and boot time and held only in that process's environment:

| Where | What | Who reads it |
| :-- | :-- | :-- |
| SSM `/astrolab/DOPPLER_TOKEN` (SecureString) | Doppler service token, config `prd` | `deploy.sh`, per deploy and per boot |
| Doppler project `astrolab`, config `prd` | `API_TOKEN`, `OPENROUTER_API_KEY` | each container, via `doppler run` at start |
| SSM `/astrolab/TAILSCALE_AUTHKEY` (SecureString) | Tailscale auth key | `bootstrap-host.sh`, once |

`AI_PROVIDER` / `AI_MODEL` have compose defaults and can be set in Doppler instead. The app's own
secret names come from `.env.example` and do not change here.

CI holds **no** AWS key: it assumes `AWS_ROLE_ARN` over OIDC, and that role can push to this registry
and send SSM commands to this one instance — nothing else, and in particular it cannot read
parameters.

## The proxy is a pass-through

The API's auth gate classifies a request by its **own** normaliser — decode, then collapse repeated
slashes — and gates any path whose first segment begins `/v1` (`api/src/server.ts`, `looksLikeV1`).
The proxy must not re-decide that: it forwards the URI unchanged, with **no URI in the upstream and no
`rewrite`**, so the one normaliser stays the only place the namespace is decided. (The serving side of
this — what the client and the edge do with it — is `docs/DEPLOY_SERVING.md`; this is the host's half.)

That is a requirement with a failure state, so it is checked against a real Caddy and the real API
(direct-to-API status vs through-the-proxy status, `--path-as-is`, no token):

| request | API | proxy |
| :-- | :-- | :-- |
| `/v1/ideas` · `//v1/ideas` · `///v1/ideas` · `/v1//ideas` | `401` | `401` |
| `/v1%2Fideas` · `/%2Fv1/ideas` · `/%76%31/ideas` · `/v1/../v1/ideas` | `401` | `401` |
| `/v1` · `/v1;x` · `/v1x/ideas` · `/v1%25` | `401` | `401` |
| `/v1/sparks/events` · `//v1/sparks/events` | `401` | `401` |
| `/healthz` · `//healthz` | `200` | `200` |
| `/V1/ideas` · `/foo/ideas` · `/nope` (not the namespace, and no such file) | `404` | `404` |
| `/` · `/index.html` · `/assets/a.js` | `404` (not the API's job) | `200` — the client bundle |

The static side has **no SPA fallback**. The client routes on the fragment (`#/capture/…`,
`#/sparks/…` — `client/src/`), so no page lives at a path, and an unknown path is a real `404` rather
than a silent `200` index.html — which would otherwise hand back the bundled bearer for any typo'd URL.

The first draft of `deploy/Caddyfile` matched the namespace with `path /v1/*`, which is **not** the
API's test: it missed `/v1`, `/v1x/…` and `/v1;x`, so those bypassed the API entirely and were answered
by the static handler — a `200` HTML index, because that draft also still had a SPA fallback. The
shipped config matches `path_regexp ^/v1` (`path_regexp` sees the same decode-then-collapse path the
API does), and the `/v1`, `/v1x/…` and `/v1;x` rows above moved from `200` to `401`.

The event stream is checked the same way: `flush_interval -1` (no buffering), HTTP/1.1 to the
upstream, and no read timeout, so a quiet stream survives between heartbeats. Verified end to end:
the client receives `event: state` frames through the proxy, and Caddy logs the upstream request as
`proto HTTP/1.1`, `uri /v1/sparks/events`.

If an access gate is ever added at the edge, it sits on the **static paths only** — never on `/v1`
(which has its own gate, and whose `401` an edge must pass through) and never on `/healthz` (whose
whole purpose is to answer when the token is missing or wrong).

## Access

The instance's security group has **no inbound rules**. The stack publishes `127.0.0.1:8080` only, and
`deploy.sh` publishes that on the tailnet with `tailscale serve`:

```sh
aws ssm start-session --region us-east-1 --target <instance>   # a shell, no SSH key
```

```
https://astrolab.<tailnet>.ts.net/     # TLS is Tailscale's certificate; needs the tailnet's HTTPS/MagicDNS setting on
```

That makes tailnet membership the gate in front of the app, which matters because of the next section.
Set the hostname with `ASTROLAB_TAILSCALE_NAME` (default `astrolab`).

## The client bearer

The client reads its `/v1` bearer from `import.meta.env.VITE_API_TOKEN`, which **Vite inlines at build
time** (`client/src/api/client.ts`). Three ways to put it there; this deploy takes the third:

| | Where the token lives | Cost |
| :-- | :-- | :-- |
| Build-arg in CI | Baked into the image in ECR | A secret in the registry and in image history |
| Build on the host | Out of the registry | No single artifact; the image stops being the deploy unit |
| **Runtime substitution** (taken) | Only in the served bundle, per container start | One init step — `deploy/web-init.mjs` |

The image is built with the literal sentinel `__ASTROLAB_API_TOKEN__`; `web-init` copies the bundle to
a shared webroot and substitutes the real token, resolved by `doppler run`. It **fails closed** — an
empty token, or a build that kept no sentinel, is a red `web-init` and `web` never starts.

That is hygiene, not secrecy: whatever it does, the token reaches any browser that loads the app, so
it is not a boundary. **The boundary is the edge** — a tailnet-only host (above), or an identity-aware
gate in front of it. Which one, and whether the app is exposed further, is the exposure decision Eli's
lane and the owner carry; the open alternative is a runtime `/config.js` the client reads instead of
`import.meta.env`, which removes the build-time coupling but is a client change.

## Rollback

The image tag is the whole state. To go back:

```sh
bash /opt/astrolab/deploy.sh <ecr>/astrolab:<previous-sha>   # on the host, via SSM
```

Migrations are forward-only (`store/README.md`), so a rollback to an image **older** than the running
schema is refused rather than guessed at — the same rule the RUNBOOK states for a restored file. A
rollback that crosses a migration is a restore, not a redeploy.

## Backup and restore

The nightly timer and the deployed paths are in `docs/RUNBOOK.md` §1 and §2. In short:

```sh
systemctl list-timers astrolab-backup.timer     # when it next runs
journalctl -u astrolab-backup.service -n 20     # what the last one did
```

## What is not here yet

These are deliberate gaps, not oversights — they are the owner's calls:

- **The host itself.** `provision-aws.sh` stops at the registry and the identity. Whether AstroLab gets
  its own `t3.small` or shares one is the owner's call; the plan assumes its own, on the same shape as
  Cortex.
- **A custom domain.** No Route 53 zone and no ACM certificate exist in the account, so the tailnet name
  *is* the hostname today. A real domain is a separate, additive step.
- **An off-host backup.** The timer's copies are on the same volume — they survive a bad deploy or a
  dropped table, not the loss of the instance. An S3 sync is the obvious next step and needs a bucket
  decision.
- **Idle worker residency.** See the finding on the branch: the worker process does not stay resident
  when the queue is empty, which any long-lived deployment needs. The compose `worker` service assumes
  the one-line fix that ships with these artifacts.

## Evidence at this head

Run in a worktree at the branch head, on this box:

- `npm ci && npm run build` — all four workspaces build; the client bundle is `client/dist`.
- `node api/dist/index.js` boots; `/healthz` → **200** without a token, `/v1/…` → **401** without one,
  a real answer with `Authorization: Bearer`, and `/v1/sparks/events` streams SSE.
- `npm run lint · format · typecheck · test · lint:citations` — clean; 1 054 tests across the four
  workspaces (api 372 · worker 202 · client 338 · store 142).
- **The proxy, end to end**, against a real `caddy run` (v2.11.7) pointed at the real API: 24 request
  spellings, direct-to-API status vs through-the-proxy status, all matching for the API namespace
  (`401`/`200`/`404`) and the client bundle served for the static paths. `caddy validate` accepts the
  shipped `Caddyfile`.
- `VITE_API_TOKEN=__ASTROLAB_API_TOKEN__` puts exactly **one** sentinel in the built bundle;
  `node deploy/web-init.mjs` substitutes it, and `--self-check` passes (it caught a path bug in the
  first draft).
- `deploy/provision-aws.sh --self-check` passes; `--dry-run` against the live account is read-only and
  reuses the account's existing GitHub OIDC provider.
- `.backup` (the timer's method) produced a `PRAGMA integrity_check`-clean copy while a writer was
  running.
- The worker residency fix: the built worker **exited 0 in ~0 s** before it and is **still resident at
  10 s** after; the pinning test was seen failing with the change reverted (mutation check), then the
  file restored byte-identical.

**Not** verified, and it needs a host: the image build itself, `docker compose up`, the Tailscale
publish, and the SSM round trip. The `Dockerfile` and the compose file are static here — the first real
deploy is what proves them.
