# Deployment

One container image serves both runtime roles; `STUDIX_ROLE=app|worker`
selects which ([ADR-0009](decisions/0009-deployment-cloudflare-and-tose.md)).
The marketing site deploys separately to Cloudflare.

Executable owners (read these, not this page, for exact steps): the root
`Dockerfile`, `docker-compose.yml`, `.env.example`, `apps/marketing` Wrangler
config, `infra/` and the GitHub Actions workflows under `.github/workflows/`.

| Surface                  | Where                                                            | Hostname                 |
| ------------------------ | ---------------------------------------------------------------- | ------------------------ |
| Marketing                | Cloudflare Worker static assets (account `digitop.vn@gmail.com`) | `studix.digitop.ai`      |
| App (UI, `/api`, `/mcp`) | TOSE project `studix-app`, fronted by Worker `studix-app-proxy`  | `app.studix.digitop.ai`  |
| Worker                   | TOSE project `studix-worker`                                     | none (no public ingress) |
| Database                 | TOSE managed PostgreSQL                                          | private                  |
| Artifacts                | Cloudflare R2 bucket `studix-staging`                            | presigned URLs only      |

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

## TOSE staging

Verified 2026-10-27 by deploying, running the smoke test and restarting the
worker mid-render (evidence in issue #1 and [METRICS.md](METRICS.md)).

- Workspace `wearetopgroup`, **Development** server. The workspace hosts other
  production projects: touch only resources prefixed `studix-`.
- Projects `studix-app` and `studix-worker`, both built by TOSE from the root
  `Dockerfile` (linux/amd64) and git-connected to the deployed branch; a push
  rebuilds and redeploys both. The worker has no public ingress; its
  `/healthz` listens on `WORKER_HEALTH_PORT` (8081) inside the pod.
- Database: TOSE managed PostgreSQL `studix-staging-pg` (`tose db list`). Both
  projects get its internal connection URL as `DATABASE_URL`. The app applies
  migrations on start (`STUDIX_MIGRATE_ON_START=true` on the app only).
- Storage: R2 bucket `studix-staging`, S3 API with path-style addressing.
- Secrets: set per project with `tose env push <file> --project <name>` from a
  file outside the repo (mode 600, deleted afterwards). Both projects share
  `BETTER_AUTH_SECRET`. Names are listed in `.env.example`; the staging-specific
  ones are `STUDIX_ROLE`, `STUDIX_ALLOWED_HOSTS` (the TOSE default host, so the
  proxy's upstream requests pass the host check) and `STUDIX_TRUST_PROXY=2`
  (Cloudflare plus TOSE ingress).

### Public hostname through a Cloudflare Worker

TOSE's Development server only accepts custom domains one label below its dev
base domain (`*.local.diginext.site`), so `app.studix.digitop.ai` cannot be
attached to the project directly. The Worker in `deploy/cloudflare-app-proxy`
owns that hostname as a Cloudflare custom domain and forwards every request
(UI, `/api`, `/mcp` streaming) to `STUDIX_UPSTREAM_ORIGIN`, the project's TOSE
default domain, setting `x-forwarded-host` and `x-forwarded-proto`.

```bash
cd deploy/cloudflare-app-proxy
npx wrangler@4 deploy        # needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment
```

Moving the project to a TOSE Production server would allow attaching the
domain directly and retiring the Worker; that needs its own database and
billing decision.

### Worker shutdown

On SIGTERM the worker stops claiming, lets the running attempt finish within
the grace period, then aborts and releases the lease so another pod reclaims
the job. An attempt that fails while the pool is draining (for example because
Puppeteer closes Chrome on SIGTERM) is released, not failed
(`packages/workflow/src/worker-pool.ts`, `job-executor.ts`). Verified on
staging: `tose restart studix-worker` during a render left the job
`succeeded` at attempt 1.

## Approvals migration

Migration `0002` adds a unique index on pending approvals. Roll it out with the old app instances stopped
or drained first: an old instance still inserts approvals without conflict handling and would hit a unique
violation on a duplicate request (or make the index build fail if it commits a duplicate mid-migration).

## Smoke test

Run after every deploy, against the public hostname:

```bash
curl -sf https://app.studix.digitop.ai/healthz && curl -sf https://app.studix.digitop.ai/readyz
STUDIX_SMOKE_URL=https://app.studix.digitop.ai pnpm --filter @studix/mcp-server smoke
curl -sI https://studix.digitop.ai
```

`pnpm smoke` signs up a throwaway user, creates a staging `stx_` key, lists the
MCP tools, calls `studix_create_video` with the Vietnamese demo prompt, polls
`studix_get_job`, downloads the MP4 and reads the same project and job through
the dashboard API. It prints ids, timings and sizes, never the key. To check a
restart, run it and `tose restart studix-worker -y` once the job's render stage
is running; the job must still end `succeeded`.

## Rollback

- App and worker: in the TOSE dashboard open each project's **Deployments**
  tab and redeploy the previous successful deployment, or push a revert to the
  deployed branch. Roll both projects back to the same commit.
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
tose status studix-app --json          # pods and health
tose logs studix-worker                # live or build logs; runtime history is in the dashboard
tose restart studix-worker -y          # restart pods, no rebuild
tose redeploy studix-app -y            # redeploy current config
tose db list --json                    # database id, then: tose db info <id> --json
```

| Symptom                 | Check                                                 | Action                                               |
| ----------------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| `/readyz` failing       | Database URL, managed Postgres status, R2 credentials | Fix secret or dependency; pods recover on next probe |
| Hostname 5xx, TOSE fine | Proxy Worker logs (Cloudflare observability)          | Check `STUDIX_UPSTREAM_ORIGIN`; roll the Worker back |
| `/mcp` rejects the host | `STUDIX_ALLOWED_HOSTS`, `STUDIX_APP_URL`              | Include the TOSE default host; redeploy              |
| Jobs stay queued        | `studix-worker` running? recent worker logs           | Restart worker; leases expire and jobs are reclaimed |
| Jobs fail at render     | Worker logs for Chromium/FFmpeg errors, memory limits | Raise worker resources or reduce concurrency         |
| Preview URL 403         | URL expired or signing config changed                 | Call `studix_get_job` again for a fresh URL          |
| `/mcp` 401 for everyone | Auth secret or key table migration                    | Check deploy diff; roll back if needed               |
| Bad deploy              | TOSE deployment history                               | Roll back both projects (above)                      |
| Suspected key leak      | Dashboard API keys                                    | Revoke the key; issue a new one                      |

Trace ids from MCP errors map to the dashboard trace view.

## Domain cutover to studix.io

Hostnames are configuration, so the cutover changes no business code:

1. Attach `studix.io` (marketing Worker) and `app.studix.io` (proxy Worker
   route, or the TOSE project on a Production server) alongside the old names.
2. Update `STUDIX_PUBLIC_URL`, `STUDIX_APP_URL`, `STUDIX_MARKETING_URL`; the host
   allow-list, CORS, links and (later) OAuth redirect URIs derive from them.
3. Redeploy, run the smoke test against the new hostnames.
4. Keep the old hostnames redirecting until clients have moved their MCP URL.
