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
stage fails if the fetched HEAD is not that commit. The pin is v1.27.0-beta.3:
it counts Sume cost once per job (since v1.26.0) and lists each provider's key
names in `multix catalog providers`, which `pnpm multix:keys` turns into the
keys Studix stores and injects (`packages/providers/src/multix-key-providers.generated.ts`).
After a bump, rerun `MULTIX_BIN=<multix dist/cli.js> pnpm multix:keys` and commit the result.
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

### Storage and media settings (platform operators)

A platform operator (a user whose `role` is `operator`, set directly in the
database) sees **Storage & Media** in the dashboard. Nobody else does, and the
API behind it (`/api/platform/*`) answers `FORBIDDEN` to every other role, API
key and OAuth client.

- **The R2 key pair can be set on the page; the bucket stays in the deployment.**
  Endpoint, bucket and region come from `S3_*`. The page shows them, a masked
  access key id and whether the secret works. **Set key** / **Rotate** takes an
  access key id and secret, runs the same write/read/delete probe with that
  pair, and stores it (sealed, as `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`
  rows in `platform_credentials`) only when the probe passes. A stored pair
  overrides the environment on the app and the worker within about 20 seconds,
  with no redeploy; **Revoke** falls back to the environment pair. Without
  `STUDIX_SECRETS_KEY` on both, the pair can only come from the environment.
  **Test connection** writes, reads, checks and
  deletes one small object under a probe prefix. A failure is classified as
  missing credential, bad credential, missing permission (token can reach the
  bucket but not write it), bucket not found or remote unavailable.
- **Storage profiles move new objects to another bucket without a redeploy.**
  **Storage profiles** on the same page holds named profiles: provider
  (`cloudflare-r2`, `aws-s3`, `s3-compatible`), endpoint, bucket, region,
  path-style addressing, an optional key prefix and a key pair (sealed with
  `STUDIX_SECRETS_KEY`, shown only as a hint). **Test and save** first runs the
  write/read/head/delete probe with the typed settings, and stores nothing
  when the probe fails. The endpoint must be a public HTTPS host. R2 endpoints
  must be `https://<account>.r2.cloudflarestorage.com`. IP literals, private,
  loopback, link-local and metadata addresses are refused, both at save time
  and on every connection. `STUDIX_STORAGE_ALLOW_LOCAL_ENDPOINTS=true` allows
  `http` and private hosts, for a local MinIO only. Metadata addresses stay
  blocked even then.
  **Activate** makes one profile the target of new objects. The app and the
  worker pick it up within about 20 seconds. A job keeps the profile of its
  first write. The `S3_*` settings remain the `env` profile and the fallback.
  Workspace owners and admins can add and activate their workspace's own
  profile on the same page; it overrides the platform choice for that workspace
  only ([ADR-0023](decisions/0023-workspace-storage-profiles.md)).
  Every asset version and render records the profile that holds its bytes
  (`storage_profile_id`; rows written before the change record `env`).
  Reads and signed URLs use that profile. If an object is not found there,
  the other profiles are tried, so a deactivated profile stays readable.
  A profile cannot be deleted while it is active or while any asset references
  it.
- **Media vendor keys can be set on the page.** `SUME_API_KEY`,
  `ATLASCLOUD_API_KEY`, `ELEVENLABS_API_KEY`, `FISH_API_KEY`, `MINIMAX_API_KEY`
  and `OPENROUTER_API_KEY` are stored sealed with `STUDIX_SECRETS_KEY` in the
  `platform_credentials` table (no second vault) and are never shown again,
  only a hint of the last four characters. A stored key overrides the
  environment variable of the same name; revoking it falls back to the
  environment. The worker reads them with the same `STUDIX_SECRETS_KEY`, so set
  that on the app **and** the worker, otherwise the page reports that keys
  cannot be stored. The worker passes the Multix CLI only these allowlisted
  names and keeps `MULTIX_DISABLE_HOME_ENV=1`.
- **Applying a change needs no restart.** The next media call on the app and the
  worker uses the new key (within a few seconds); a call already running keeps
  the key it started with. `MULTIX_BIN` is still deployment configuration.
- **Test checks one vendor key for free.** It looks the key in use (stored or
  from the environment) up at the vendor's fixed account endpoint:
  `OPENROUTER_API_KEY` (a 401 means invalid) and `ELEVENLABS_API_KEY` (a 401
  stays unverified, since restricted keys are refused too). Vendors without
  such an endpoint answer unverified; no paid call is made.
- **Audit events can go to the operators' workspace.** Set
  `STUDIX_PLATFORM_WORKSPACE_ID` (app only) to write `platform_credential.*`
  events there instead of the workspace the operator has selected, so tenant
  admins never see them. An operator who is not an `operator` member of that
  workspace is then refused before anything changes.
- **The safe check calls no paid provider.** It runs `multix check`, which only
  reports which keys exist, so it cannot tell a wrong key from a right one; a
  bad key shows up on the first real job. The check runs in the app process. The
  worker runs its own `multix check` (at most once a minute) and reports it under
  `media` in `/readyz`: `executable`, `state`, `code`, `secretsKey` and, per
  vendor, only whether a key exists. It never gates readiness. Set
  `STUDIX_WORKER_HEALTH_URL` on the app (for example `http://studix-worker:8081`)
  and the page lists where the app and the worker disagree (`MULTIX_BIN`,
  `STUDIX_SECRETS_KEY`, a key found on one side only). A worker without
  `STUDIX_SECRETS_KEY` also logs a warning at startup when keys exist in the
  database.
- **Rollback:** revoke the key on the page (the environment value applies again)
  and revoke it at the provider if it leaked. Losing `STUDIX_SECRETS_KEY` makes
  stored keys unreadable (they are skipped and logged); set them again.

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

Paid media runs through the Multix provider (`packages/providers`). The image
sets `MULTIX_BIN=/opt/multix/dist/cli.js`, so the provider is on in every
deployment built from the root `Dockerfile`, even when the platform secrets
omit the variable; an empty `MULTIX_BIN=` in the secrets turns it off. Before
this default, a deployment whose secrets lacked the variable failed `motion-graphic` jobs
with a voice-over with `UNAVAILABLE` ("The Multix provider is not
configured") after compose. Routes: Sume models
run image, video, lip-sync and video upscale as Sume jobs; every other provider `multix generate` serves
(Gemini, MiniMax, OpenAI, OpenRouter, Leonardo, BytePlus, Cloudflare, fal, Atlas Cloud, Replicate, Runway,
HeyGen and TopView, listed in `GENERATE_VENDORS` in
[`multix-routes.ts`](../packages/providers/src/multix-routes.ts)) runs them through
`multix generate <task> --model=<vendor>:<model>`; image upscale runs on Atlas Cloud or Leonardo; voice,
music and SFX on ElevenLabs, Fish or MiniMax, and voice also on OpenRouter speech. The model pickers list
every provider's models from `multix models --task <task> --live`, and mark a provider without all its keys
"needs key". multix cannot price these providers before a run yet (mrgoonie/multix-cli#581), so a job reserves a ceiling rounded up from the public list price ([`multix-generate-prices.ts`](../packages/providers/src/multix-generate-prices.ts), shown as "est. ≤ X¢" in the picker). It books the receipt when multix reports one and the ceiling otherwise. A provider without a public price (Leonardo, HeyGen) is labelled "no trusted price" and refused. The worker passes only the key names multix reads (`MULTIX_ENV_KEY_NAMES`, plus PATH, HOME,
temp and proxy variables) to the CLI, and
sets `MULTIX_DISABLE_HOME_ENV=1` so `~/.multix/.env` is never read on servers
(`MULTIX_ALLOW_HOME_ENV=true` is for local development only). A model is
advertised only when `multix check` reports every key of its vendor. Default models per
role come from `MULTIX_<ROLE>_MODEL` as `<vendor>:<model>`, and voice per language from
`MULTIX_VOICE_LANGUAGE_MODELS` (`vi=openrouter:fish-audio/drama-3`, optionally
`@<voice>`), which also carries the packs' delivery direction to models that take it;
`MULTIX_WAIT_TIMEOUT_SECONDS` (default 900) bounds the wait for one upstream
job. Every paid call is estimated first and refused above the request's cap.

These env values are the server defaults. A workspace admin (`member:manage`) can override them on the
dashboard's Providers page, or through `GET|PUT|DELETE /api/providers/multix`: turn Multix off for the
workspace, change the wait timeout (30–7200 s), the model of each role and the voice routes. Saved values
win over env field by field; a blank field keeps the env value, and a workspace cannot turn Multix on
where the server has no `MULTIX_BIN`. `POST /api/providers/multix/check` reports the CLI version and
`multix check`. The CLI version itself stays pinned in the image (`MULTIX_COMMIT`).
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
`MULTIX_BIN` (set to empty) their paid stages fail with `UNAVAILABLE`; without the QA
toolchain (see [QA.md](QA.md)) their QA stage fails, so an unmeasured render
is never published.

### Skill sandbox (worker)

The `skill-agent` pack, and any agent stage that asks for `bash`, `read`, `write`, `edit` or `ls`, runs
its tools in a per-task Docker container
([ADR-0018](decisions/0018-skill-sandbox.md)). It is off by default.

| Variable                      | Default                | Meaning                                                                        |
| ----------------------------- | ---------------------- | ------------------------------------------------------------------------------ |
| `STUDIX_SANDBOX`              | `off`                  | `docker` turns it on; the worker needs a Docker daemon                         |
| `STUDIX_SANDBOX_IMAGE`        | `studix-sandbox:local` | Image built from `docker/sandbox.Dockerfile`                                   |
| `STUDIX_SANDBOX_NETWORK`      | `bridge`               | Docker network of the containers (egress is open)                              |
| `STUDIX_SANDBOX_CPUS`         | `2`                    | CPU cap per task                                                               |
| `STUDIX_SANDBOX_MEMORY_MB`    | `4096`                 | Memory cap per task, no swap                                                   |
| `STUDIX_SANDBOX_PIDS`         | `512`                  | Process cap per task                                                           |
| `STUDIX_SANDBOX_WALL_SECONDS` | `1800`                 | Wall-time cap of one container                                                 |
| `STUDIX_SANDBOX_SKILLS_DIR`   | unset                  | Local skills (`<dir>/{platform,workspace}/<name>/`) instead of the skill store |
| `DOCKER_BIN`                  | `docker`               | Docker CLI path                                                                |
| `STUDIX_CODEX_MODEL`          | `gpt-5.5`              | Default model of the `codex` agent runtime when the job names none             |

The `codex` runtime runs `codex exec` inside this sandbox, so it needs `STUDIX_SANDBOX=docker`. The image
pins the Codex CLI with the `CODEX_VERSION` build argument of `docker/sandbox.Dockerfile`. A Claude agent's
tool-using stages run the Claude Code CLI there too, pinned by `CLAUDE_CODE_VERSION`.

Build the image with `docker compose --profile sandbox build sandbox-image`. It pins the same multix
commit and chrome-headless-shell as the Studix image; bump both together. The container receives only
the task's media vendor keys (every name in `MULTIX_ENV_KEY_NAMES`). The self-host `worker` service does not mount
the Docker socket, so run a sandboxed worker on a host with Docker until that wiring exists.

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

### Log queries

`studix_query_logs` and `studix_tail_logs` read the activity trail of the
database the server runs on. The server answers only for its own environment,
`production` when `NODE_ENV=production` and `development` otherwise; set
`STUDIX_LOG_ENVIRONMENT` where a development deployment also runs with
`NODE_ENV=production`, or its logs would be labelled production. Cursors are
signed with a key derived from `BETTER_AUTH_SECRET`, so rotating that secret
invalidates open cursors (clients start again without one). TOSE runtime and
build logs and Cloudflare Workers logs are not connected: they wait for
project-scoped seven-day retention and safe history and live access on TOSE
(saasvn/tose-app#545) and for a check of the Cloudflare plan's retention.

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
- Each environment has its own R2 bucket, S3 API with path-style addressing,
  and its own R2 API token (Object Read & Write) scoped to that bucket only.
  App and worker of one environment share the token; environments never share
  it. A token scoped to another bucket fails every object call with 403
  `AccessDenied`. Check a token with the worker's storage probe or the R2
  `Test connection` on the operator Storage page.
- Storage write probe: on start, the app and the worker each write, read back and delete one tiny object
  under `orgs/healthcheck/workspaces/probe/` and log `object storage write probe failed` (with only the
  step, HTTP status and S3 error code) when the store refuses it. The worker also reports the result under
  `storage` in `/readyz`; it does not gate readiness, so the deploy that fixes a credential is never blocked.
  The key must be allowed to write under `orgs/*`. A failed `upload` stage reports `status` and `s3Code` in
  `error.details`; after fixing the credential, retry the job: the render checkpoint is reused while the
  render file is still on that worker (otherwise the render stage runs again), and the upload key is
  deterministic, so no duplicate object is created.
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
- Storage profile: activate the previous profile (or `env`) on **Storage &
  Media**. New objects go there within about 20 seconds. Objects written in
  the meantime stay readable from the profile they were written to. Migration
  `0028` only adds a table and columns with a default, so the previous image
  runs against it unchanged.
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
