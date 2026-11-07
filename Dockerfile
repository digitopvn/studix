# Studix runtime image: one image, two roles selected by STUDIX_ROLE.
#   STUDIX_ROLE=app    -> apps/mcp-server (/mcp, /api, dashboard static, migrations on start)
#   STUDIX_ROLE=worker -> apps/worker (job claim loops, HyperFrames + FFmpeg rendering, QA tools, /healthz)
# Node + FFmpeg + chrome-headless-shell for rendering, the multix CLI, and Python for the
# QA measurement tools.

# The multix CLI, built from the commit tagged v1.27.0-beta.2 in mrgoonie/multix-cli. Pinning the commit is
# stricter than pinning the npm version, which has no lockfile integrity hash in this image.
FROM node:22-bookworm-slim AS multix
ARG MULTIX_REPO=https://github.com/mrgoonie/multix-cli.git
ARG MULTIX_COMMIT=40fab6e2118457d9801e313a2dc7b7db58d53e97
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/multix
RUN set -eu; \
    git init -q .; \
    git remote add origin "$MULTIX_REPO"; \
    git fetch -q --depth 1 origin "$MULTIX_COMMIT"; \
    git checkout -q --detach FETCH_HEAD; \
    test "$(git rev-parse HEAD)" = "$MULTIX_COMMIT"; \
    npm ci --no-audit --no-fund; \
    npm run build; \
    npm prune --omit=dev --no-audit --no-fund; \
    rm -rf .git /root/.npm; \
    node dist/cli.js --version

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    HYPERFRAMES_NO_TELEMETRY=1 \
    HYPERFRAMES_NO_UPDATE_CHECK=1 \
    HYPERFRAMES_SKIP_SKILLS=1 \
    STUDIX_ROLE=app \
    PORT=8080 \
    WORKER_HEALTH_PORT=8081 \
    STUDIX_DASHBOARD_DIST=/app/apps/dashboard/dist

# FFmpeg for probing/finishing, unzip for HyperFrames' managed Chrome download, fonts and the
# shared libraries chrome-headless-shell needs. python3 runs the QA measurement tools (tools/qa).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl ffmpeg unzip fonts-liberation fontconfig python3 \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libdbus-1-3 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxext6 libx11-6 libxcb1 \
      libgbm1 libasound2 libpango-1.0-0 libcairo2 libexpat1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# The image ships multix and points MULTIX_BIN at it, so a deployment whose secrets omit the variable
# still has the provider. Paid kinds stay off until `multix check` sees their vendor key; set
# MULTIX_BIN to an empty value to disable the provider.
COPY --from=multix /opt/multix /opt/multix
RUN chmod +x /opt/multix/dist/cli.js && ln -s /opt/multix/dist/cli.js /usr/local/bin/multix
ENV MULTIX_BIN=/opt/multix/dist/cli.js

# Layers that change rarely come first so a builder with a layer cache reuses them across commits:
# the browser, the QA venv (keyed on tools/qa) and the pnpm store (keyed on the lockfile).
# Pin the browser path so the renderer never depends on the runtime user's cache layout.
# Chrome for Testing ships chrome-headless-shell for linux64 and, from build 153, linux-arm64, so amd64
# and arm64 (local Apple Silicon) images install the same pinned build. @puppeteer/browsers resolves
# linux-arm64 from 3.2.0; 3.2.6 is the version already in pnpm-lock.yaml. The build id is pinned so
# pixels and the WebGL measurements in docs/RENDERER.md do not drift between image builds; CI reads
# this same line. Bump the id deliberately and re-measure (see docs/RENDERER.md).
ARG CHROME_HEADLESS_SHELL_VERSION=156.0.8078.80
ENV PRODUCER_HEADLESS_SHELL_PATH=/opt/studix-browser/chrome \
    HYPERFRAMES_BROWSER_PATH=/opt/studix-browser/chrome
# npx runs from / because /app already has this version as a transitive pnpm dependency without a
# `browsers` bin on PATH; outside the project npx fetches the package and its bin.
RUN set -eu; mkdir -p /opt/studix-browser; cd /; \
    npx --yes --package @puppeteer/browsers@3.2.6 -- browsers install "chrome-headless-shell@${CHROME_HEADLESS_SHELL_VERSION}" --path /opt/studix-browser/cache; \
    ln -s "$(find /opt/studix-browser/cache -type f -name chrome-headless-shell | head -n1)" /opt/studix-browser/chrome; \
    /opt/studix-browser/chrome --version; \
    rm -rf /root/.npm

WORKDIR /app
# Job scratch directories (WORKER_WORK_DIR). Created here and owned by node so a named volume or a PVC
# mounted over it starts writable by the unprivileged user. See docs/DEPLOYMENT.md.
ENV WORKER_WORK_DIR=/var/lib/studix/work
RUN mkdir -p /var/lib/studix/work && chown -R node:node /var/lib/studix

# QA measurement tools: a venv at tools/qa/.venv (where packages/qa looks by default) on Debian's python3,
# pinned by tools/qa/uv.lock. uv is used at build time only. The default image has no torch; build the
# optional image with `--build-arg STUDIX_QA_EXTRAS=depth`, which also bakes the depth model in at a pinned
# revision (tools never download anything at run time). `STUDIX_QA_EXTRAS=speech` adds Silero VAD, whose
# model ships inside the wheel (the worker's STUDIX_SPEECH_GATE needs it); extras combine as "depth speech".
# See docs/QA.md.
ARG STUDIX_QA_EXTRAS=""
ARG DEPTH_MODEL_REVISION=5426e4f0f36572d16453bbda7a8389317b1bef99
COPY --from=ghcr.io/astral-sh/uv:0.13.6 /uv /usr/local/bin/uv
COPY tools/qa /app/tools/qa
RUN set -eu; extras=""; for e in $STUDIX_QA_EXTRAS; do extras="$extras --extra $e"; done; \
    UV_PYTHON_DOWNLOADS=never UV_PYTHON=/usr/bin/python3 UV_NO_CACHE=1 UV_LINK_MODE=copy \
      uv sync --project tools/qa --locked --no-dev --no-editable $extras; \
    case " $STUDIX_QA_EXTRAS " in *" depth "*) \
      tools/qa/.venv/bin/python -m studix_qa.depth_maps fetch /opt/studix-qa/models/depth-anything-v2-small \
        --revision "$DEPTH_MODEL_REVISION";; \
    esac; \
    rm /usr/local/bin/uv; \
    tools/qa/.venv/bin/python -I -m studix_qa --list

# Downloads every locked package into the store from the lockfile alone, so a source-only change
# skips the download.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches ./patches
RUN pnpm fetch --prod=false

COPY . .

# Full install from the store fetched above (tsx runs the TypeScript sources directly), then build the dashboard SPA.
# This also installs the pinned Claude Agent SDK and its native CLI: pnpm picks the lockfile's
# optional @anthropic-ai/claude-agent-sdk-linux-<arch> package matching this glibc image, and it
# has no install script, so `onlyBuiltDependencies` does not apply. Nothing is installed at runtime.
RUN pnpm install --offline --frozen-lockfile --prod=false \
 && pnpm --filter @studix/dashboard build \
 && chown -R node:node /app

USER node

EXPOSE 8080 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD /app/docker/healthcheck.sh

ENTRYPOINT ["/app/docker/entrypoint.sh"]
