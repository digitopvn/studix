# Studix runtime image: one image, two roles selected by STUDIX_ROLE.
#   STUDIX_ROLE=app    -> apps/mcp-server (/mcp, /api, dashboard static, migrations on start)
#   STUDIX_ROLE=worker -> apps/worker (job claim loops, HyperFrames + FFmpeg rendering, /healthz)
# Node + FFmpeg + chrome-headless-shell (managed by HyperFrames) for rendering.
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
    STUDIX_DASHBOARD_DIR=/app/apps/dashboard/dist

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
RUN pnpm install --frozen-lockfile --prod=false \
 && pnpm --filter @studix/dashboard build \
 && chown -R node:node /app

# HyperFrames caches its managed Chrome under the runtime user's ~/.cache/hyperframes.
USER node
RUN pnpm --filter @studix/renderers exec hyperframes browser ensure

EXPOSE 8080 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD /app/docker/healthcheck.sh

ENTRYPOINT ["/app/docker/entrypoint.sh"]
