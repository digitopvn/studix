#!/bin/sh
# Selects the process for this container from STUDIX_ROLE (app | worker).
set -eu
case "${STUDIX_ROLE:-app}" in
  app) exec node --import tsx apps/mcp-server/src/main.ts ;;
  worker) exec node --import tsx apps/worker/src/main.ts ;;
  *) echo "Unknown STUDIX_ROLE '${STUDIX_ROLE}' (expected app or worker)" >&2; exit 64 ;;
esac
