# Studix runtime image: one image, two roles selected by STUDIX_ROLE.
#   STUDIX_ROLE=app    -> apps/mcp-server (/mcp, /api, dashboard static, migrations on start)
#   STUDIX_ROLE=worker -> apps/worker (job claim loops, HyperFrames + FFmpeg rendering, QA tools, /healthz)
# Node + FFmpeg + chrome-headless-shell for rendering, the multix CLI, and Python for the
# QA measurement tools.

# The multix CLI, built from the commit tagged v1.26.0 in mrgoonie/multix-cli. Pinning the commit is
# stricter than pinning the npm version, which has no lockfile integrity hash in this image.
FROM node:22-bookworm-slim AS multix
ARG MULTIX_REPO=https://github.com/mrgoonie/multix-cli.git
ARG MULTIX_COMMIT=7922a2741b86c56eaac328778eaee3a2f29344ea
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

# multix stays opt-in: the worker uses it only when MULTIX_BIN=/opt/multix/dist/cli.js is set.
COPY --from=multix /opt/multix /opt/multix
RUN chmod +x /opt/multix/dist/cli.js && ln -s /opt/multix/dist/cli.js /usr/local/bin/multix

WORKDIR /app
COPY . .

# Full install (tsx runs the TypeScript sources directly), then build the dashboard SPA.
# This also installs the pinned Claude Agent SDK and its native CLI: pnpm picks the lockfile's
# optional @anthropic-ai/claude-agent-sdk-linux-<arch> package matching this glibc image, and it
# has no install script, so `onlyBuiltDependencies` does not apply. Nothing is installed at runtime.
RUN pnpm install --frozen-lockfile --prod=false \
 && pnpm --filter @studix/dashboard build

# QA measurement tools: a venv at tools/qa/.venv (where packages/qa looks by default) on Debian's python3,
# pinned by tools/qa/uv.lock. uv is used at build time only. The default image has no torch; build the
# optional image with `--build-arg STUDIX_QA_EXTRAS=depth`, which also bakes the depth model in at a pinned
# revision (tools never download anything at run time). See docs/QA.md.
ARG STUDIX_QA_EXTRAS=""
ARG DEPTH_MODEL_REVISION=5426e4f0f36572d16453bbda7a8389317b1bef99
COPY --from=ghcr.io/astral-sh/uv:0.13.6 /uv /usr/local/bin/uv
RUN set -eu; extras=""; for e in $STUDIX_QA_EXTRAS; do extras="$extras --extra $e"; done; \
    UV_PYTHON_DOWNLOADS=never UV_PYTHON=/usr/bin/python3 UV_NO_CACHE=1 UV_LINK_MODE=copy \
      uv sync --project tools/qa --locked --no-dev --no-editable $extras; \
    case " $STUDIX_QA_EXTRAS " in *" depth "*) \
      tools/qa/.venv/bin/python -m studix_qa.depth_maps fetch /opt/studix-qa/models/depth-anything-v2-small \
        --revision "$DEPTH_MODEL_REVISION";; \
    esac; \
    rm /usr/local/bin/uv; \
    tools/qa/.venv/bin/python -I -m studix_qa --list; \
    chown -R node:node /app

# Pin the browser path so the renderer never depends on the runtime user's cache layout.
# Chrome for Testing ships chrome-headless-shell for linux64 and, from build 153, linux-arm64, so amd64
# and arm64 (local Apple Silicon) images install the same pinned build. @puppeteer/browsers resolves
# linux-arm64 from 3.2.0; 3.2.6 is the version already in pnpm-lock.yaml. The build id is pinned so
# pixels and the WebGL measurements in docs/RENDERER.md do not drift between image builds; CI reads
# this same line. Bump the id deliberately and re-measure (see docs/RENDERER.md).
ARG CHROME_HEADLESS_SHELL_VERSION=156.0.8078.80
ENV PRODUCER_HEADLESS_SHELL_PATH=/opt/studix-browser/chrome \
    HYPERFRAMES_BROWSER_PATH=/opt/studix-browser/chrome
RUN set -eu; mkdir -p /opt/studix-browser; \
    npx --yes --package @puppeteer/browsers@3.2.6 -- browsers install "chrome-headless-shell@${CHROME_HEADLESS_SHELL_VERSION}" --path /opt/studix-browser/cache; \
    ln -s "$(find /opt/studix-browser/cache -type f -name chrome-headless-shell | head -n1)" /opt/studix-browser/chrome; \
    /opt/studix-browser/chrome --version; \
    rm -rf /root/.npm

USER node

EXPOSE 8080 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD /app/docker/healthcheck.sh

ENTRYPOINT ["/app/docker/entrypoint.sh"]
