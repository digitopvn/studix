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
| App (UI, `/api`, `/mcp`) | TOSE project `studix-app`                                        | `app.studix.digitop.ai`  |
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

To be verified at deploy time: TOSE's build model (Dockerfile per project,
build args), running a project without an exposed port (worker), probe
configuration, secret injection, long-running jobs, SSE/streaming through
ingress, egress, and rollback mechanics. Record evidence or open a blocker
issue; do not mark this section verified from docs alone.

- Workspace: `wearetopgroup` on DigitalOcean Kubernetes (`sgp1`). The workspace
  hosts other production projects: touch only resources prefixed `studix-`.
- Projects: `studix-app` (`STUDIX_ROLE=app`, HTTP port exposed) and
  `studix-worker` (`STUDIX_ROLE=worker`). Both build from the root `Dockerfile`.
- Auto-deploy: git-connected to the repo branch; a push triggers build and
  deploy of both projects.
- Database: TOSE managed PostgreSQL; its connection URL is injected into both
  projects.
- Storage: R2 bucket `studix-staging`; R2 credentials injected into both.
- Domain: `app.studix.digitop.ai` is a Cloudflare DNS CNAME to the TOSE default
  domain of `studix-app`; TLS terminates at TOSE ingress.
- Probes on `studix-app`: liveness `GET /healthz` (process up), readiness
  `GET /readyz` (database and storage reachable). Worker liveness depends on the
  TOSE capability found above.

## Smoke test

Run after every deploy, against the public hostname:

1. `curl -sf https://app.studix.digitop.ai/healthz` and `/readyz` return 200.
2. Dashboard loads and a test user can sign in.
3. An MCP client lists tools at `https://app.studix.digitop.ai/mcp` with a
   staging `stx_` key; a request without a key returns `UNAUTHENTICATED`.
4. `studix_create_video` with the demo Vietnamese prompt returns a `jobId`;
   `studix_get_job` reaches a preview URL that plays and expires as configured.
5. Restart the worker mid-job; the job resumes and completes once.
6. `curl -sI https://studix.digitop.ai` returns 200.

## Rollback

- App and worker: redeploy the previous successful deployment of `studix-app`
  and `studix-worker` in TOSE (exact control to be verified at deploy time).
  Roll both back to the same commit.
- Migrations are forward-only. Write them expand-then-contract so the previous
  image still runs against the new schema; that is what makes a code rollback
  safe without a database restore.
- Marketing: redeploy the previous Worker version with Wrangler or the
  Cloudflare dashboard.

## Runbook

| Symptom                 | Check                                                 | Action                                               |
| ----------------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| `/readyz` failing       | Database URL, managed Postgres status, R2 credentials | Fix secret or dependency; pods recover on next probe |
| Jobs stay queued        | `studix-worker` running? recent worker logs           | Restart worker; leases expire and jobs are reclaimed |
| Jobs fail at render     | Worker logs for Chromium/FFmpeg errors, memory limits | Raise worker resources or reduce concurrency         |
| Preview URL 403         | URL expired or signing config changed                 | Call `studix_get_job` again for a fresh URL          |
| `/mcp` 401 for everyone | Auth secret or key table migration                    | Check deploy diff; roll back if needed               |
| Bad deploy              | TOSE deployment history                               | Roll back both projects (above)                      |
| Suspected key leak      | Dashboard API keys                                    | Revoke the key; issue a new one                      |

Trace ids from MCP errors map to the dashboard trace view.

## Domain cutover to studix.io

Hostnames are configuration, so the cutover changes no business code:

1. Attach `studix.io` (marketing) and `app.studix.io` (app) in Cloudflare and
   TOSE alongside the old names.
2. Update `STUDIX_PUBLIC_URL`, `STUDIX_APP_URL`, `STUDIX_MARKETING_URL`; the host
   allow-list, CORS, links and (later) OAuth redirect URIs derive from them.
3. Redeploy, run the smoke test against the new hostnames.
4. Keep the old hostnames redirecting until clients have moved their MCP URL.
