# Studix runtime image: one image, two roles selected by STUDIX_ROLE.
#   STUDIX_ROLE=app    -> apps/mcp-server (/mcp, /api, dashboard static, migrations on start)
#   STUDIX_ROLE=worker -> apps/worker (job claim loops, HyperFrames + FFmpeg rendering, /healthz)
# Node + FFmpeg + chrome-headless-shell (Chromium on arm64) for rendering.
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
# shared libraries chrome-headless-shell needs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl ffmpeg unzip fonts-liberation fontconfig \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libdbus-1-3 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxext6 libx11-6 libxcb1 \
      libgbm1 libasound2 libpango-1.0-0 libcairo2 libexpat1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app
COPY . .

# Full install (tsx runs the TypeScript sources directly), then build the dashboard SPA.
# This also installs the pinned Claude Agent SDK and its native CLI: pnpm picks the lockfile's
# optional @anthropic-ai/claude-agent-sdk-linux-<arch> package matching this glibc image, and it
# has no install script, so `onlyBuiltDependencies` does not apply. Nothing is installed at runtime.
RUN pnpm install --frozen-lockfile --prod=false \
 && pnpm --filter @studix/dashboard build \
 && chown -R node:node /app

# Pin the browser path so the renderer never depends on the runtime user's cache layout.
# Chrome for Testing ships chrome-headless-shell for linux x64 only; arm64 images (local Apple
# Silicon builds) fall back to Debian's Chromium, which HyperFrames drives in screenshot mode.
ENV PRODUCER_HEADLESS_SHELL_PATH=/opt/studix-browser/chrome \
    HYPERFRAMES_BROWSER_PATH=/opt/studix-browser/chrome
RUN set -eu; arch="$(dpkg --print-architecture)"; mkdir -p /opt/studix-browser; \
    if [ "$arch" = "amd64" ]; then \
      npx --yes --package @puppeteer/browsers@2.13.0 -- browsers install chrome-headless-shell@stable --path /opt/studix-browser/cache; \
      ln -s "$(find /opt/studix-browser/cache -type f -name chrome-headless-shell | head -n1)" /opt/studix-browser/chrome; \
    else \
      apt-get update && apt-get install -y --no-install-recommends chromium && rm -rf /var/lib/apt/lists/*; \
      ln -s /usr/bin/chromium /opt/studix-browser/chrome; \
    fi; \
    /opt/studix-browser/chrome --version; \
    rm -rf /root/.npm

USER node

EXPOSE 8080 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD /app/docker/healthcheck.sh

ENTRYPOINT ["/app/docker/entrypoint.sh"]
