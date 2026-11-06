# Deployment

One container image serves both runtime roles; `STUDIX_ROLE=app|worker`
selects which ([ADR-0009](decisions/0009-deployment-cloudflare-and-tose.md)).
The marketing site deploys separately to Cloudflare.

Executable owners (read these, not this page, for exact steps): the root
`Dockerfile`, `docker-compose.yml`, `.env.example`, `apps/marketing` Wrangler
config, `deploy/` (TOSE deploy script, Kubernetes manifests, dev proxy Worker) and
the GitHub Actions workflows under `.github/workflows/`.

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
and HyperFrames because the worker renders, and the multix CLI for paid media
generation. The app role does not invoke them; shipping one image keeps build,
pinning and rollback to a single artifact.

Layers are ordered from rarely to often changed (system packages, multix,
Chromium, the QA venv, the pnpm store fetched from `pnpm-lock.yaml`, then the
sources), so a builder that keeps its layer cache rebuilds only the source
layers on an ordinary commit.

multix is built in a separate stage from a pinned commit of
`mrgoonie/multix-cli` (`MULTIX_COMMIT` in the `Dockerfile` owns the value). The
stage fails if the fetched HEAD is not that commit. The pin must be v1.26.0 or
later: the first stable release with the Sume commands that counts Sume cost
once per job.
The image keeps the git build instead of `npm install -g @mrgoonie/multix`,
because a commit pin is checked and an npm install here has no lockfile
integrity hash. To upgrade, set `MULTIX_COMMIT` to the new release tag's commit
and re-run the live smoke test.

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

`STUDIX_SECRETS_KEY` (32 random bytes, base64) encrypts workspace provider
credentials such as Anthropic API keys. Without it the app still starts, but
saving keys is disabled. Losing it makes every stored key unreadable, so back
it up with the database secrets. To rotate it, move the old value to
`STUDIX_SECRETS_KEYS_PREVIOUS` and set a new one.

Dashboard sign-in with GitHub and Google is off until a provider's client id
and secret are both set (`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`,
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`); setting only one of a pair fails
config validation. Set them on the app only. Each environment needs its own
OAuth client whose callback URL is `<STUDIX_APP_URL>/api/auth/callback/github`
(GitHub OAuth App, "Authorization callback URL") or
`<STUDIX_APP_URL>/api/auth/callback/google` (Google OAuth client of type "Web
application", "Authorized redirect URIs"; the consent screen needs the
`openid`, `email` and `profile` scopes). Linking rules are in
[SECURITY.md](SECURITY.md#api-keys-inbound).

Keys for the Pi runtime and the per-stage model preferences need no extra
setting: they use the same `STUDIX_SECRETS_KEY`, which the worker also needs to
run a stage on a workspace key. Without it the worker keeps the operator's
default routing. The Pi SDK and its model catalog are pinned in
`packages/agent-runtime/package.json`; upgrading it can change which models the
dashboard offers.

The Claude planner is off unless `STUDIX_CLAUDE_PLANNER=true`. Set it on both
the app (so job creation accepts a `planner` selection) and the worker. The
worker then also needs the same `STUDIX_SECRETS_KEY` to open the selected key,
and refuses to start without it. At startup the worker also runs the Claude
binary with `--version` (no model call, no key) and refuses to start when it
cannot run on the host, for example an image platform the SDK ships no binary
for; unset the flag to run without the planner. Tuning, all optional:
`STUDIX_CLAUDE_PLANNER_MODEL`, `STUDIX_CLAUDE_PLANNER_MAX_TURNS` (default 4),
`STUDIX_CLAUDE_PLANNER_MAX_COST_CENTS` (default 200, lowered further by the
job's remaining budget) and `STUDIX_CLAUDE_PLANNER_TIMEOUT_SECONDS` (default
300). The worker image needs no extra install step: `pnpm install
--frozen-lockfile` brings the pinned Agent SDK and its platform binary. Each
run uses a temporary directory under `WORKER_WORK_DIR/claude` that is removed
when the run ends; the worker creates that directory at startup and removes
sandboxes left by a crashed worker once they are older than the run timeout.
Job scratch directories (`WORKER_WORK_DIR/<jobId>`) are removed when the job
finishes; those of failed jobs are kept for retries and swept after
`WORKER_WORK_DIR_RETENTION_HOURS` (default 168, minimum 24) without writes.

Keep `WORKER_WORK_DIR` on a persistent volume. The image sets it to
`/var/lib/studix/work`; `deploy/k8s/worker.yaml` mounts a PVC there (the worker
Deployment uses `Recreate` because the volume is ReadWriteOnce) and the
`selfhost` compose profile mounts a named volume. Synchronous Multix audio
(voice, music, sound effects) has no upstream idempotency key, so a call counts
as finished only while its output file is on this directory. On a scratch disk
that a pod restart wipes, a retry would call the upstream again and be charged a
second time. As a second line of defence, once an output is uploaded the stage
journal records that object, and a retry of the same unchanged request reuses it
without calling the upstream even if the directory is gone. The remaining window
is a crash between the upstream call and that upload. Size the volume for
in-flight jobs only (20Gi in the manifest); finished jobs remove their
directories and the sweep above bounds the rest. The manifest pins
`WORKER_WORK_DIR` in the container `env`, so a value in the `studix-env` secret
cannot move it off the volume. The ReadWriteOnce claim means one worker pod; to
scale the worker out, give each replica its own volume (a StatefulSet with
`volumeClaimTemplates`), and note that a retry that lands on another replica
then relies on the journal fallback alone.
TOSE production (`studix-prod-worker`) is built from the root `Dockerfile` and
has no persistent volume attached: `deploy/k8s/worker.yaml` and the compose
volume do not apply to it. There the work directory is lost on every restart or
deploy, so only the journal fallback protects synchronous audio, and two
windows remain where a retry calls the upstream (and is charged) again: the
worker is stopped while the call runs (the abort kills the call, the upstream
may still charge it), and a crash between the upstream call and the upload. A
volume would not close the first one either, because a killed call writes no
file. Before a deploy, restart the worker only when no job is in its voice,
music or sound-effect stage (the same check as for the render stage above).
Attach a TOSE volume to the project at `/var/lib/studix/work` once TOSE offers
one; this needs the TOSE dashboard, not a repository change.
When Anthropic answers a run with 401, the worker re-tests that key directly
and, only if it is still rejected and was not rotated meanwhile, marks its
connection `invalid`, so job creation stops accepting it until the key is
replaced. A 401 that the re-test does not repeat (a gateway token, a short
Anthropic incident) leaves the key alone.

Smoke tests of the planner live in the `live` test project (`STUDIX_LIVE=1
ANTHROPIC_API_KEY=... pnpm test:live`) and are skipped without the key. The
plan test is capped by `STUDIX_CLAUDE_LIVE_MAX_COST_CENTS` (default 100); the
rejected-key test uses a made-up key and costs nothing.

Paid media runs through the Multix provider (`packages/providers`), which is
off unless the worker has `MULTIX_BIN=/opt/multix/dist/cli.js`. Routes: image,
video, lip-sync and video upscale on Sume; image upscale on Atlas Cloud; voice,
music and SFX on ElevenLabs, Fish or MiniMax, and voice also on OpenRouter speech.
The worker passes only `SUME_API_KEY`, `ATLASCLOUD_API_KEY`, `ELEVENLABS_API_KEY`,
`FISH_API_KEY`, `MINIMAX_API_KEY` and `OPENROUTER_API_KEY` (plus PATH, HOME, temp and proxy variables) to the CLI, and
sets `MULTIX_DISABLE_HOME_ENV=1` so `~/.multix/.env` is never read on servers
(`MULTIX_ALLOW_HOME_ENV=true` is for local development only). A kind is
advertised only when `multix check` reports its vendor key. Default models per
role come from `MULTIX_<ROLE>_MODEL` as `<vendor>:<model>`, and voice per language from
`MULTIX_VOICE_LANGUAGE_MODELS` (`vi=openrouter:fish-audio/drama-3`, optionally
`@<voice>`), which also carries the packs' delivery direction to models that take it;
`MULTIX_WAIT_TIMEOUT_SECONDS` (default 900) bounds the wait for one upstream
job. Every paid call is estimated first and refused above the request's cap.
A video request on `sume:seedance-2.5` runs at `480p` unless it passes
`params.resolution`; a higher resolution is an explicit, separately estimated
choice
([`DEFAULT_VIDEO_RESOLUTIONS`](../packages/providers/src/multix-routes.ts)).
Sume jobs are submitted with an idempotency key and collected with `status
--wait --download`, so a retry resumes the paid job by its id. Stages pass the
provider a job journal stored on the stage row (`stages.media_jobs`), written
right after each submission: a worker that dies mid-stage leaves the upstream
job ids behind, and the next attempt, on any worker, collects those jobs
instead of submitting again. Atlas Cloud has no idempotency key, so the adapter
journals a `submitting` record right before `atlas run`. If the worker dies
before the job id is journaled, a retry with the same idempotency key is
refused (non-retryable) instead of paying twice for one upscale (about $0.01):
find the prediction in `multix history` or the Atlas Cloud console, attach it
with `studix_attach_media_job` (platform `operator` role only; the app process
needs `MULTIX_BIN` and the Atlas key to check the prediction), then retry the job
([docs/MCP_API.md](MCP_API.md#retrying-a-failed-job)). The intent is an
insert-if-absent, so two concurrent calls with the same idempotency key submit
once; the other fails `CONFLICT` (retryable). Its retry collects the job once
the winner journaled it, or reports the request as possibly charged if the
winner died first.
Only errors that prove Atlas never accepted the run (invalid
request, missing key) release the key for a retry. Calls made outside a
workflow stage fall back to an in-process journal, which a restart loses.

Pack stages (`marketing-video`, `motion-graphic`) get the media provider, the
storage, the renderer and the hard QA gate from the worker
([`pack-services.ts`](../apps/worker/src/pack-services.ts)). Without
`MULTIX_BIN` their paid stages fail with `UNAVAILABLE`; without the QA
toolchain (see [QA.md](QA.md)) their QA stage fails, so an unmeasured render
is never published.

Secrets are injected by the platform's secret store (TOSE project secrets,
Cloudflare secrets, local `.env`), never baked into the image.

The worker checks generated sound effects for a human voice when
`STUDIX_SPEECH_GATE=true`. That needs the optional QA image built with
`--build-arg STUDIX_QA_EXTRAS=speech`; with the flag on and the default image,
the worker refuses to start (`UNAVAILABLE`) instead of paying for effects it cannot check.
See [QA.md](QA.md#chặn-tiếng-nói-trong-sfx).
TOSE builds the image without build arguments, so production runs the default
image and keeps `STUDIX_SPEECH_GATE` unset until a build with the `speech` extra
exists for it.

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
Kubernetes manifests (Kustomize) live under `deploy/k8s`.

### Claude subscription (self-hosted only)

On a personal or self-hosted server, members can run Claude jobs on their own
Claude Pro/Max subscription instead of an API key. It is off by default, and
the hosted Studix cloud keeps it off, so the card on Settings → AI & Providers
stays "Restricted" there.

The simplest setup is one env flag, `STUDIX_SELF_HOSTED=true`, on both the app
and the worker. Then:

- The workspace owner switches "Claude planner" and "Claude subscription" on
  in Settings → AI & Providers → Self-hosted Claude features. Other roles see
  the switches read-only. Without `STUDIX_SELF_HOSTED` the switches are
  hidden, saved values are ignored, and only the env flags below apply.
- If `STUDIX_SECRETS_KEY` is unset, the server generates a random master key
  into `STUDIX_SECRETS_KEY_FILE` (default `.studix/secrets.key`, mode 0600) on
  first start and reads it on later starts. The key never goes into the
  database. With Docker, mount one volume into both the app and the worker and
  point `STUDIX_SECRETS_KEY_FILE` at it, so both open the same credentials.
  Back the file up: losing it makes every stored credential unreadable. An
  explicit `STUDIX_SECRETS_KEY` always wins over the file.
- If the worker host cannot run the Claude Code binary, the worker logs a
  warning and keeps running; Claude jobs fail until it is installed.

Operators can still force the features on for every workspace with
`STUDIX_CLAUDE_SUBSCRIPTION=true` and `STUDIX_CLAUDE_PLANNER=true` (plus
`STUDIX_SECRETS_KEY`); the Dashboard then shows them as set by the server.
Without any master key, the card says storage is not configured and nothing
is stored.

Each member then runs `claude setup-token` on their own machine, signs in with
their own Claude account, and pastes the printed token on the card. Members
can also add their own Anthropic API key (personal key, usage-based) on the
API key card on the same page; that also needs only `STUDIX_SECRETS_KEY`.

What Studix does and does not do with a subscription token, following
Anthropic's [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
page:

- Only the official, unmodified Claude Code executable uses it, run directly
  as `claude --print` with the token in `CLAUDE_CODE_OAUTH_TOKEN`. The token is
  never passed to the Claude Agent SDK, never used to call the Anthropic API
  directly, and never tested against it (the first run verifies it; a token
  Claude Code rejects is marked invalid).
- It is personal: stored encrypted for its owner, usable only by jobs that
  owner creates, only on the `claude` runtime, never shared with other members
  or the workspace. A subscription token pasted into the API key form is
  refused.
- Turning the switch (or flag) off hides stored subscriptions and stops
  releasing them; the worker re-reads the switch for every job.

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

### TOSE access

- When to use: any TOSE API or CLI call outside CI (runbook, backup, rollback).
- Scope: workspace `wearetopgroup`, `studix-` resources only.
- Credential: CI reads `TOSE_API_KEY` from the GitHub environment (below).
  Locally, the maintainers keep the `wearetopgroup` key in `.env` as
  `TOSE_API_KEY_WEARETOPGROUP`; a plain `TOSE_API_KEY` in that file belongs to
  another workspace. Pass the workspace key explicitly
  (`TOSE_API_KEY="$TOSE_API_KEY_WEARETOPGROUP"`) to `deploy/tose/deploy.ts` or a
  direct API call; never rely on whichever key the shell happens to hold.
- Verify: before any write, make a read-only call (for example
  `tose db list --json` or `tose status studix-app --json`) and confirm it
  returns `studix-` resources. An auth error or no `studix-` resource means the key belongs to
  another workspace.

### Database backup

- When to use: before a production release that applies migrations, and before
  any manual data repair.
- How: TOSE API, same base as `deploy/tose/deploy.ts`: `POST` on the database's
  `backups` resource (`.../databases/<id>/backups`), with the database id from
  `tose db list --json` and the key from [TOSE access](#tose-access).
- Limits: a restore through this route has not been verified; treat the
  backup as a safety net, not a rollback path (see [Rollback](#rollback)).

### CI deploy

`.github/workflows/deploy.yml`: a push to `dev` deploys dev, a push to `main`
deploys production. Pushes that only touch Markdown, `docs/`, `plans/`,
`.claude/` or `ci.yml` do not deploy. The workflow does not re-run CI: `main`
only receives merged pull requests, whose CI already passed, and `dev` skips CI
during the bootstrap stage. This is a pre-MVP speed trade-off: a direct push to
`main` (the branch is not protected) deploys untested. Run CI on such a commit
by opening a pull request, or restore the `ci` job in `deploy.yml` once the
project needs the extra gate.

How the image is built depends on the environment variable
`STUDIX_DEPLOY_IMAGE`:

- `1` (image mode): the `image` job builds the root `Dockerfile` once with
  Buildx, layer cache in the GitHub Actions cache, and pushes
  `ghcr.io/digitopvn/studix:<sha>`. `deploy/tose/deploy.ts` then calls TOSE
  `deploy-image` with that digest for the app, waits until it is live (the app
  applies migrations on start), then does the same for the worker. Both
  projects run the exact commit that was pushed, and a rollout takes a minute or
  two instead of a TOSE build.
- unset (branch mode): TOSE builds each project from the branch tip itself. TOSE
  keeps no layer cache, so each build takes about 15 minutes; the script starts
  both builds at the same time. Because the worker no longer waits for the app,
  it can go live first and briefly run new code against the old schema; jobs
  that need the new schema can fail until the app has migrated. For a release
  whose worker code cannot run before its migration, deploy the app alone first
  (`node deploy/tose/deploy.ts <app-project>` with the
  [TOSE access](#tose-access) key), then run the workflow. Before starting the
  builds the script checks that the tip is still the pushed commit; if a newer
  push landed, it skips and leaves the deploy to that push's run. If TOSE still
  built another commit, the job fails so someone looks.

Either way the job then checks `/healthz` and `/readyz` on the public hostname.

One-time setup for image mode, per environment: TOSE pulls the private GHCR
package with a workspace registry credential (TOSE `createRegistryCredential`,
host `ghcr.io`, a token with `read:packages` only). Put its id in the
environment variable `TOSE_REGISTRY_CREDENTIAL_ID`, check that `TOSE_API_KEY`
has the `deployments:execute` scope, then set `STUDIX_DEPLOY_IMAGE=1`. Unset it
to fall back to branch mode.

A started rollout is never cancelled; a newer push queues behind it.

The GitHub environments `dev` and `production` hold what the job needs, and
each accepts deployments only from its own branch:

| Kind     | Name                                      | Value                             |
| -------- | ----------------------------------------- | --------------------------------- |
| Secret   | `TOSE_API_KEY`                            | TOSE API key for `wearetopgroup`  |
| Variable | `TOSE_WORKSPACE`                          | `wearetopgroup`                   |
| Variable | `TOSE_APP_PROJECT`, `TOSE_WORKER_PROJECT` | the environment's projects        |
| Variable | `STUDIX_APP_URL`                          | the environment's public origin   |
| Variable | `STUDIX_DEPLOY_IMAGE`                     | `1` for image mode (optional)     |
| Variable | `TOSE_REGISTRY_CREDENTIAL_ID`             | TOSE GHCR credential (image mode) |

To redeploy without a push, run the workflow manually (**Run workflow** on the
branch). Env-only changes need no build: `tose redeploy <project> -y`.

### Production hostname

`studix-prod-app` carries `app.studix.digitop.ai` as a TOSE custom domain
(TOSE issues the certificate once DNS points at it). Cloudflare DNS has an A
record to the SGP1 ingress, the address the project's default domain
(`wearetopgroup-studix-prod-app.tose.sh`) resolves to, **DNS-only** (not
proxied), which is why production trusts one proxy hop. The `target_ip` the
TOSE domains API reports was not reachable when the record was created; trust
the default domain's address instead.

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
the job. Chrome keeps rendering through the grace period: the HyperFrames
engine is patched so Puppeteer does not close it on SIGTERM (see
`docs/RENDERER.md`). An attempt that fails while the pool is draining anyway is
released, not failed
(`packages/workflow/src/worker-pool.ts`, `job-executor.ts`). Verified on
dev: `tose restart studix-worker` during a render left the job
`succeeded` at attempt 1.

## MCP OAuth

`/mcp` accepts OAuth access tokens next to `stx_` API keys; the dashboard's
Better Auth instance is the authorization server.

- Migrating: deploy a build that includes the additive migration (new `auth_jwks`
  and `oauth_*` tables, `auth_sessions.oauth_workspace_id`). API-key clients
  are unaffected. Set `STUDIX_MCP_OAUTH=false` to turn OAuth off.
- Issuer `<STUDIX_APP_URL>/api/auth`, resource `<STUDIX_PUBLIC_URL>/mcp`. Both
  must be reachable by AI clients, and the reverse proxy must pass
  `/.well-known/*` and `/api/auth/*` to the app.
- No new callback is registered with GitHub or Google: the dashboard sign-in
  reuses the existing SSO callbacks. AI clients' own redirect URIs are
  registered by the clients (dynamic registration or Client ID Metadata).
- Signing keys are generated on first use and stored in `auth_jwks`; they
  rotate through Better Auth, and the app refreshes its cached JWKS when it
  sees an unknown key id.
- Check after deploy:

```bash
APP=https://dev-app.studix.digitop.ai
curl -s $APP/.well-known/oauth-protected-resource/mcp
curl -s $APP/.well-known/oauth-authorization-server/api/auth
curl -si -X POST $APP/mcp | grep -i www-authenticate
```

- Revoke a misbehaving client for everyone by setting `disabled` on its
  `oauth_clients` row; users revoke their own grants on the Connected apps page.

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
  safe without a database restore. TOSE has no API to scale a project, so the
  deploy script cannot pause the worker while the app migrates; it only orders
  app before worker, and the previous worker keeps running against the new
  schema until its own rollout.
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

| Symptom                     | Check                                                                                                                | Action                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `/readyz` failing           | Database URL, managed Postgres status, R2 credentials                                                                | Fix secret or dependency; pods recover on next probe                                                         |
| Dev hostname 5xx, TOSE fine | Proxy Worker logs (Cloudflare observability)                                                                         | Check `STUDIX_UPSTREAM_ORIGIN`; roll the Worker back                                                         |
| Deploy job fails            | Workflow log names the deployment and its status                                                                     | TOSE dashboard build log; fix, push again                                                                    |
| `/mcp` rejects the host     | `STUDIX_ALLOWED_HOSTS`, `STUDIX_APP_URL`                                                                             | Include the TOSE default host; redeploy                                                                      |
| Jobs stay queued            | `studix-worker` running? recent worker logs                                                                          | Restart worker; leases expire and jobs are reclaimed                                                         |
| Jobs fail at render         | Worker logs for Chromium/FFmpeg errors, memory limits                                                                | Raise worker resources or reduce concurrency                                                                 |
| Upload fails with 403       | Worker `/readyz` shows `storage:false`; worker log "object storage write probe failed" has the step, status and hint | Fix R2 key/permissions or bucket policy, restart worker, then retry the job (render/QA checkpoints are kept) |
| Preview URL 403             | URL expired or signing config changed                                                                                | Call `studix_get_job` again for a fresh URL                                                                  |
| `/mcp` 401 for everyone     | Auth secret or key table migration                                                                                   | Check deploy diff; roll back if needed                                                                       |
| Bad deploy                  | TOSE deployment history                                                                                              | Roll back both projects (above)                                                                              |
| Suspected key leak          | Dashboard API keys                                                                                                   | Revoke the key; issue a new one                                                                              |

Trace ids from MCP errors map to the dashboard trace view.

## Domain cutover to studix.io

Hostnames are configuration, so the cutover changes no business code:

1. Attach `studix.io` (marketing Worker) and `app.studix.io` (TOSE custom
   domain on `studix-prod-app`) alongside the old names.
2. Update `STUDIX_PUBLIC_URL`, `STUDIX_APP_URL`, `STUDIX_MARKETING_URL`; the host
   allow-list, CORS, links and (later) OAuth redirect URIs derive from them.
3. Redeploy, run the smoke test against the new hostnames.
4. Keep the old hostnames redirecting until clients have moved their MCP URL.
