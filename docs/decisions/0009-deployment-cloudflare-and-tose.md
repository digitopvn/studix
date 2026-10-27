# 0009. Deployment on Cloudflare and TOSE

- Status: Accepted
- Date: 2026-10-27 (production environment and CI deploy added the same day)

## Context

The marketing site is static and independent. The app (UI, `/api`, `/mcp`) is
I/O bound; the worker needs Chromium, FFmpeg and HyperFrames and is CPU bound.
Digitop runs workloads on TOSE over DigitalOcean Kubernetes. The product will
move from `studix.digitop.ai` to `studix.io` later.

## Decision

- **Marketing:** Cloudflare Worker static assets on the Digitop Cloudflare
  account, at `studix.digitop.ai`.
- **One image, two roles:** a root `Dockerfile` builds one image with Chromium,
  FFmpeg and HyperFrames. `STUDIX_ROLE=app|worker` selects the process.
- **Two environments in TOSE workspace `wearetopgroup`**, each with its own
  app and worker projects, managed PostgreSQL and R2 bucket:
  - **production** from branch `main`: SGP1 Production server, projects
    `studix-prod-app` and `studix-prod-worker`, bucket `studix-production`,
    `app.studix.digitop.ai` attached to the project directly (DNS-only record).
  - **dev** from branch `dev`: Development server, projects `studix-app` and
    `studix-worker`, bucket `studix-staging`. That server only serves
    `*.local.diginext.site` hosts, so a Cloudflare Worker
    (`deploy/cloudflare-app-proxy`) owns `dev-app.studix.digitop.ai` and
    proxies to the project's TOSE default domain.
- **CI deploys, not TOSE webhooks:** TOSE auto-deploy is off. A push to `dev` or
  `main` runs CI and, only if it passes, triggers the TOSE build of the app and
  then the worker and waits for both (`.github/workflows/deploy.yml`). An
  auto-deploy would ship commits that fail CI.
- **Hostnames are configuration:** `STUDIX_PUBLIC_URL`, `STUDIX_APP_URL`,
  `STUDIX_MARKETING_URL`. The `studix.io` cutover changes env and DNS only.
- **Local and self-host:** Docker Compose (Postgres + MinIO) and the same image.
- Only `studix-*` resources are touched in the shared TOSE workspace.

## Consequences

- One artifact to build, pin, scan and roll back; app pods carry an image
  larger than they need.
- Scaling app and worker independently is a TOSE project setting, not a code
  change.
- The dev proxy adds one hop and a second deploy target for the dev hostname.
- Production costs a second database and Production-server resources.
- TOSE builds the branch tip, not a given commit, so the deploy checks the tip
  against the tested commit before each build and fails if TOSE built another.
- TOSE capabilities (no-port worker, restarts, rollback) were verified at
  deploy time ([DEPLOYMENT.md](../DEPLOYMENT.md#tose-environments)).

## Alternatives considered

- Separate app and worker images: smaller app image, two build pipelines and a
  version-skew risk.
- VPS with Docker Compose and a tunnel (the `motion-mcp` setup): no managed
  restarts or scaling, single host.
