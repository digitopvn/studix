#!/bin/sh
# Probes the health endpoint of whichever role this container runs.
set -eu
if [ "${STUDIX_ROLE:-app}" = "worker" ]; then port="${WORKER_HEALTH_PORT:-8081}"; else port="${PORT:-8080}"; fi
exec curl -fsS "http://127.0.0.1:${port}/healthz" >/dev/null
