#!/bin/sh
# Image entrypoint of studix-pi-runner. Session commands share the runner's uid and can read /proc/*/environ,
# so the token must not stay in the environment of any long-lived process. This shell (briefly pid 1) hands it
# to the runner on stdin through a here-document (a pipe in dash) and execs tini without it; from then on
# neither pid 1 (tini) nor the runner carries STUDIX_RUNNER_TOKEN in its exec-time environment.
set -eu
if [ -z "${STUDIX_RUNNER_TOKEN:-}" ]; then
  echo '{"event":"start_failed","error":"STUDIX_RUNNER_TOKEN is not set"}'
  exit 1
fi
# Container args (e.g. `--port 7072`, set per sidecar by deploy/tose/worker-sidecars.ts) pass through to the runner.
exec env -u STUDIX_RUNNER_TOKEN tini -- node /opt/pi-runner/apps/pi-runner/src/main.ts --token-stdin "$@" <<EOF
$STUDIX_RUNNER_TOKEN
EOF
