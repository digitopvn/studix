# Skill sandbox image: the container one tool-using agent task runs its tools in (docs/decisions/0018-skill-sandbox.md).
# The worker starts it per task with `docker run` (read-only root, no capabilities, uid 1000, CPU/RAM/PID
# caps) and removes it when the task ends. It holds no Studix code and no secrets: only the toolchain a
# skill may call (Python 3, Node, ffmpeg, Chromium for HyperFrames, git, curl and the multix CLI).
#
#   docker build -f docker/sandbox.Dockerfile -t studix-sandbox:local .

# The multix CLI at the same pinned commit as the Studix image (MULTIX_COMMIT in Dockerfile).
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

ENV HYPERFRAMES_NO_TELEMETRY=1 \
    HYPERFRAMES_NO_UPDATE_CHECK=1 \
    HYPERFRAMES_SKIP_SKILLS=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git ffmpeg unzip jq \
      python3 python3-pip python3-venv python3-yaml python3-numpy python3-pil \
      fonts-liberation fonts-noto-core fonts-noto-color-emoji fontconfig \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libdbus-1-3 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxext6 libx11-6 libxcb1 \
      libgbm1 libasound2 libpango-1.0-0 libcairo2 libexpat1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=multix /opt/multix /opt/multix
RUN chmod +x /opt/multix/dist/cli.js && ln -s /opt/multix/dist/cli.js /usr/local/bin/multix

# The same pinned chrome-headless-shell as the Studix image, so a skill's HyperFrames render matches.
ARG CHROME_HEADLESS_SHELL_VERSION=156.0.8078.80
ENV PRODUCER_HEADLESS_SHELL_PATH=/opt/studix-browser/chrome \
    HYPERFRAMES_BROWSER_PATH=/opt/studix-browser/chrome \
    PUPPETEER_EXECUTABLE_PATH=/opt/studix-browser/chrome
RUN set -eu; mkdir -p /opt/studix-browser; cd /; \
    npx --yes --package @puppeteer/browsers@3.2.6 -- browsers install "chrome-headless-shell@${CHROME_HEADLESS_SHELL_VERSION}" --path /opt/studix-browser/cache; \
    ln -s "$(find /opt/studix-browser/cache -type f -name chrome-headless-shell | head -n1)" /opt/studix-browser/chrome; \
    /opt/studix-browser/chrome --version; \
    rm -rf /root/.npm

# A HyperFrames CLI on PATH. A skill that runs `npx hyperframes@<other version>` downloads that version
# into its own HOME at run time (the network is open).
ARG HYPERFRAMES_VERSION=0.8.77
RUN npm install -g --no-audit --no-fund "hyperframes@${HYPERFRAMES_VERSION}" \
 && hyperframes --version && rm -rf /root/.npm

# The worker mounts the task's directory at /work (HOME=/work/.home) and the skills read-only at /skills.
RUN mkdir -p /work /skills && chown 1000:1000 /work
WORKDIR /work
USER 1000:1000
# The worker runs it with `--init` and `sleep infinity`, then `docker exec`s each tool call.
CMD ["sleep", "infinity"]
