# Deployment

One container image serves both runtime roles; `STUDIX_ROLE=app|worker`
selects which ([ADR-0009](decisions/0009-deployment-cloudflare-and-tose.md)).
The marketing site deploys separately to Cloudflare.

Executable owners (read these, not this page, for exact steps): the root
`Dockerfile`, `docker-compose.yml`, `.env.example`, `apps/marketing` Wrangler
config, `infra/` and the GitHub Actions workflows under `.github/workflows/`.

| Surface                  | Production (branch `main`)                             | Dev (branch `dev`)                                                                  |
| ------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Marketing                | Cloudflare Worker static assets, `studix.digitop.ai`   | (same)                                                                              |
| App (UI, `/api`, `/mcp`) | TOSE `studix-prod-app` (SGP1), `app.studix.digitop.ai` | TOSE `studix-app` behind Worker `studix-dev-app-proxy`, `dev-app.studix.digitop.ai` |
| Worker                   | TOSE `studix-prod-worker`, no public ingress           | TOSE `studix-worker`, no public ingress                                             |
| Database                 | TOSE managed PostgreSQL `studix-prod-pg`               | TOSE managed PostgreSQL `studix-staging-pg`                                         |
| Artifacts                | Cloudflare R2 bucket `studix-production`               | Cloudflare R2 bucket `studix-staging`                                               |

Marketing runs on the Digitop Cloudflare account (`digitop.vn@gmail.com`).

## The image

Root `Dockerfile`, one image for both roles. It contains Node, Chromium, FFmpeg
and HyperFrames because the worker renders. The app role does not invoke them;
shipping one image keeps build, pinning and rollback to a single artifact.

## Configuration

All configuration is environment-only, parsed by `loadConfig()` in
`packages/shared`; `.env.example` is the annotated list. Never put values in
docs or commit real env files.

Names decided by contract:

| Name                   | Purpose                       |
| ---------------------- | ----------------------------- |
| `STUDIX_ROLE`          | `app` or `worker`             |
| `STUDIX_PUBLIC_URL`    | Public base URL used in links |
| `STUDIX_APP_URL`       | App origin; `/mcp` lives here |
| `STUDIX_MARKETING_URL` | Marketing origin              |

Other required groups (exact names owned by `loadConfig()` and `.env.example`):
PostgreSQL connection URL; S3 endpoint, region, bucket, access key id and
secret; artifact signing / presign lifetime; credential encryption key for
`secretRef`; dashboard auth secret; decision provider credentials and model
ids (OpenRouter, TypeSafeAI; live use opt-in); log level.

Secrets are injected by the platform's secret store (TOSE project secrets,
Cloudflare secrets, local `.env`), never baked into the image.

## Local

```bash
cp .env.example .env          # fill local values
docker compose up -d          # postgres + minio (+ app/worker if defined in compose)
pnpm install --frozen-lockfile
```

Run the app and worker against the compose services with the package scripts in
the root `package.json`. CI uses the same Postgres + MinIO pair with fake
providers, so no AI cost is incurred.

## Self-host

Run the same image twice (once per role) against your own PostgreSQL 16 and any
S3-compatible storage. Set the `STUDIX_*_URL` values to your hostnames. Apply
migrations before starting the new app version (see `packages/database`).
Helm/K8s manifests, when present, live under `infra/`.

## Cloudflare marketing

- Source: `apps/marketing`; static assets served by a Worker.
- Deploy with Wrangler from CI or locally, authenticated to the Digitop
  Cloudflare account through a scoped API token held in CI secrets.
- Custom domain `studix.digitop.ai` is attached to the Worker in Cloudflare.
- Check: `curl -sI https://studix.digitop.ai` returns `200`.

## TOSE environments

Workspace `wearetopgroup`. It hosts other production projects: touch only
resources prefixed `studix-`.

| Environment | Branch | TOSE server       | Projects                                | `STUDIX_TRUST_PROXY`            |
| ----------- | ------ | ----------------- | --------------------------------------- | ------------------------------- |
| production  | `main` | SGP1 (Production) | `studix-prod-app`, `studix-prod-worker` | `1` (TOSE ingress, DNS-only)    |
| dev         | `dev`  | Development       | `studix-app`, `studix-worker`           | `2` (Cloudflare + TOSE ingress) |
- Each project is built by TOSE from the root `Dockerfile` (linux/amd64) of its
  environment's branch. Auto-deploy is **off**: CI decides when to build (below).
  The worker has no public ingress; its `/healthz` listens on
  `WORKER_HEALTH_PORT` (8081) inside the pod.
- Each environment has its own TOSE managed PostgreSQL (`tose db list`), given
  to both projects as `DATABASE_URL` (internal URL). The app applies migrations
  on start (`STUDIX_MIGRATE_ON_START=true` on the app only).
- Each environment has its own R2 bucket, S3 API with path-style addressing.
- Secrets: set per project with `tose env push <file> --project <name>` from a
  file outside the repo (mode 600, deleted afterwards). App and worker of one
  environment share `BETTER_AUTH_SECRET`; environments never share it. Names
  are listed in `.env.example`; the per-environment ones are `STUDIX_ROLE`,
  `STUDIX_APP_URL` / `STUDIX_PUBLIC_URL` (the environment's hostname),
  `STUDIX_ALLOWED_HOSTS` (the project's TOSE default host),
  `STUDIX_API_KEY_ENV` (`live` in production, `staging` in dev) and
  `STUDIX_TRUST_PROXY`.

### CI deploy

`.github/workflows/deploy.yml`: a push to `dev` deploys dev, a push to `main`
deploys production. It runs `ci.yml` first and deploys only if it passes, then
`deploy/tose/deploy.ts` triggers a TOSE build of the app project, waits until it
is live (the app migrates on start), does the same for the worker, and checks
`/healthz` and `/readyz` on the public hostname.

TOSE builds the branch tip, not a chosen commit. Before each build the script
checks that the tip is still the commit CI tested; if a newer push landed, it
stops and leaves the deploy to that push's run (the app may then be one commit
ahead of the worker until it finishes). If TOSE still built another commit (a
push in the seconds between check and build), the job fails so someone looks.
A started rollout is never cancelled; a newer push queues behind it.

The GitHub environments `dev` and `production` hold what the job needs, and
each accepts deployments only from its own branch:

| Kind     | Name                                      | Value                            |
| -------- | ----------------------------------------- | -------------------------------- |
| Secret   | `TOSE_API_KEY`                            | TOSE API key for `wearetopgroup` |
| Variable | `TOSE_WORKSPACE`                          | `wearetopgroup`                  |
| Variable | `TOSE_APP_PROJECT`, `TOSE_WORKER_PROJECT` | the environment's projects       |
| Variable | `STUDIX_APP_URL`                          | the environment's public origin  |

To redeploy without a push, run the workflow manually (**Run workflow** on the
branch). Env-only changes need no build: `tose redeploy <project> -y`.

### Production hostname

`studix-prod-app` carries `app.studix.digitop.ai` as a TOSE custom domain
(TOSE issues the certificate once DNS points at it). Cloudflare DNS has an A
record to the SGP1 ingress, the address the project's default domain
(`wearetopgroup-studix-prod-app.tose.sh`) resolves to, **DNS-only** (not
proxied), which is why production trusts one proxy hop. The `target_ip` the
TOSE domains API reports was not reachable on 2026-10-27; trust the default
domain's address instead.

### Dev hostname through a Cloudflare Worker

TOSE's Development server only accepts custom domains one label below its dev
base domain (`*.local.diginext.site`), so `dev-app.studix.digitop.ai` cannot be
attached to the project directly. The Worker in `deploy/cloudflare-app-proxy`
owns that hostname as a Cloudflare custom domain and forwards every request
(UI, `/api`, `/mcp` streaming) to `STUDIX_UPSTREAM_ORIGIN`, the project's TOSE
default domain, setting `x-forwarded-host` and `x-forwarded-proto`.

```bash
cd deploy/cloudflare-app-proxy
npx wrangler@4 deploy        # needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment
```

### Worker shutdown

On SIGTERM the worker stops claiming, lets the running attempt finish within
the grace period, then aborts and releases the lease so another pod reclaims
the job. An attempt that fails while the pool is draining (for example because
Puppeteer closes Chrome on SIGTERM) is released, not failed
(`packages/workflow/src/worker-pool.ts`, `job-executor.ts`). Verified on
dev: `tose restart studix-worker` during a render left the job
`succeeded` at attempt 1.

## Smoke test

The deploy workflow checks `/healthz` and `/readyz`. The full smoke test calls a
real model, so run it by hand against dev after a meaningful change, and against
production when a release needs it:

```bash
APP=https://dev-app.studix.digitop.ai   # production: https://app.studix.digitop.ai
curl -sf $APP/healthz && curl -sf $APP/readyz
STUDIX_SMOKE_URL=$APP pnpm --filter @studix/mcp-server smoke
curl -sI https://studix.digitop.ai
```

`pnpm smoke` signs up a throwaway user, creates an `stx_` key, lists the
MCP tools, calls `studix_create_video` with the Vietnamese demo prompt, polls
`studix_get_job`, downloads the MP4 and reads the same project and job through
the dashboard API. It prints ids, timings and sizes, never the key. To check a
restart, run it and `tose restart studix-worker -y` once the job's render stage
is running; the job must still end `succeeded`.

## Rollback

- App and worker: push a revert to the environment's branch (CI deploys it), or,
  faster, roll back in the TOSE dashboard: each project's **Deployments** tab,
  previous successful deployment (API: `POST /projects/<name>/deployments/<id>/rollback`).
  Roll both projects back to the same commit, app first.
- Migrations are forward-only. Write them expand-then-contract so the previous
  image still runs against the new schema; that is what makes a code rollback
  safe without a database restore.
- Proxy Worker and marketing: `npx wrangler@4 rollback` in the Worker's
  directory, or pick the previous version in the Cloudflare dashboard.
- Configuration: `tose env push` the previous file, then `tose redeploy <project> -y`
  (redeploys without rebuilding).

## Runbook

```bash
export TOSE_WORKSPACE=wearetopgroup
# production projects: studix-prod-app, studix-prod-worker
tose status studix-app --json          # pods and health
tose logs studix-worker                # live or build logs; runtime history is in the dashboard
tose restart studix-worker -y          # restart pods, no rebuild
tose redeploy studix-app -y            # redeploy current config
tose db list --json                    # database id, then: tose db info <id> --json
```

| Symptom                     | Check                                                 | Action                                               |
| --------------------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| `/readyz` failing           | Database URL, managed Postgres status, R2 credentials | Fix secret or dependency; pods recover on next probe |
| Dev hostname 5xx, TOSE fine | Proxy Worker logs (Cloudflare observability)          | Check `STUDIX_UPSTREAM_ORIGIN`; roll the Worker back |
| Deploy job fails            | Workflow log names the deployment and its status      | TOSE dashboard build log; fix, push again            |
| `/mcp` rejects the host     | `STUDIX_ALLOWED_HOSTS`, `STUDIX_APP_URL`              | Include the TOSE default host; redeploy              |
| Jobs stay queued            | `studix-worker` running? recent worker logs           | Restart worker; leases expire and jobs are reclaimed |
| Jobs fail at render         | Worker logs for Chromium/FFmpeg errors, memory limits | Raise worker resources or reduce concurrency         |
| Preview URL 403             | URL expired or signing config changed                 | Call `studix_get_job` again for a fresh URL          |
| `/mcp` 401 for everyone     | Auth secret or key table migration                    | Check deploy diff; roll back if needed               |
| Bad deploy                  | TOSE deployment history                               | Roll back both projects (above)                      |
| Suspected key leak          | Dashboard API keys                                    | Revoke the key; issue a new one                      |

Trace ids from MCP errors map to the dashboard trace view.

## Domain cutover to studix.io

Hostnames are configuration, so the cutover changes no business code:

1. Attach `studix.io` (marketing Worker) and `app.studix.io` (TOSE custom
   domain on `studix-prod-app`) alongside the old names.
2. Update `STUDIX_PUBLIC_URL`, `STUDIX_APP_URL`, `STUDIX_MARKETING_URL`; the host
   allow-list, CORS, links and (later) OAuth redirect URIs derive from them.
3. Redeploy, run the smoke test against the new hostnames.
4. Keep the old hostnames redirecting until clients have moved their MCP URL.
