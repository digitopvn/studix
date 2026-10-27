# 0009. Deployment on Cloudflare and TOSE

- Status: Accepted
- Date: 2026-10-27

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
- **Staging:** TOSE workspace `wearetopgroup`, Development server, projects `studix-app` and `studix-worker`, git-connected
  auto-deploy from the repo branch, TOSE managed PostgreSQL, Cloudflare R2
  bucket `studix-staging`.
- **Domain:** TOSE's Development server only serves `*.local.diginext.site`
  hosts, so a Cloudflare Worker (`deploy/cloudflare-app-proxy`) owns
  `app.studix.digitop.ai` and proxies to the project's TOSE default domain; MCP
  at `https://app.studix.digitop.ai/mcp`. Chosen over moving to a TOSE
  Production server (separate database and billing) for staging; revisit for
  production.
- **Hostnames are configuration:** `STUDIX_PUBLIC_URL`, `STUDIX_APP_URL`,
  `STUDIX_MARKETING_URL`. The `studix.io` cutover changes env and DNS only.
- **Local and self-host:** Docker Compose (Postgres + MinIO) and the same image.
- Only `studix-*` resources are touched in the shared TOSE workspace.

## Consequences

- One artifact to build, pin, scan and roll back; app pods carry an image
  larger than they need.
- Scaling app and worker independently is a TOSE project setting, not a code
  change.
- The proxy adds one hop and a second deploy target for the public hostname.
- TOSE capabilities (no-port worker, restarts, rollback) were verified at
  deploy time ([DEPLOYMENT.md](../DEPLOYMENT.md#tose-staging)).

## Alternatives considered

- Separate app and worker images: smaller app image, two build pipelines and a
  version-skew risk.
- VPS with Docker Compose and a tunnel (the `motion-mcp` setup): no managed
  restarts or scaling, single host.
