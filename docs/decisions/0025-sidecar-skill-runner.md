# 0025. Sidecar skill runner for the TOSE worker

- Status: Accepted
- Date: 2026-11-09
- Extends: [ADR-0018](0018-skill-sandbox.md)

## Context

The skill sandbox of ADR-0018 starts one Docker container per task with `docker run`, so the worker needs a
Docker daemon. The TOSE worker pod has none: TOSE offers no Docker socket, no privileged pod and no way for a
project to create pods. On TOSE the `skill-agent` pack, delegated agent stages that ask for tools, and
`studix_composition_run` therefore could not run. TOSE now lets a project declare up to three sidecars in its
pod (saasvn/tose-app#533, [project-sidecars](https://github.com/saasvn/tose-app/blob/main/docs/project-sidecars.md)).

## Decision

- Add a second sandbox backend, `STUDIX_SANDBOX=sidecar`. The Pi session, model keys, caps and billing stay in
  the worker. Only the tool operations (`bash`, `read`, `write`, `edit`, `ls`), imported skills and renders run
  in a `pi-runner` process in a sidecar container of the worker's own pod. The tool definitions are the same
  ones the Docker backend uses; only their transport differs.
- The runner image is the `pi-runner` target of `docker/sandbox.Dockerfile`: the ADR-0018 toolchain plus a small
  HTTP server (`apps/pi-runner`). The wire contract, shared by both sides, is
  `packages/agent-runtime/src/sandbox-runner-protocol.ts`.
- A pool of one to three runners listens on pod loopback (`STUDIX_SANDBOX_RUNNERS`). A runner serves one session
  at a time and wipes its writable paths between sessions. Each runner has its own bearer token. Concurrent
  sandboxed tasks are therefore bounded by the pool size.
- TOSE sets CPU and RAM per sidecar and forces non-root, all capabilities dropped, the default seccomp profile,
  no privilege escalation and no service account token. The sandbox's PID and wall-time caps still come from
  `STUDIX_SANDBOX_PIDS` and `STUDIX_SANDBOX_WALL_SECONDS`.
- The backend is allowed only for workspaces listed in `STUDIX_SANDBOX_SIDECAR_WORKSPACES`; any other workspace
  gets `FORBIDDEN`.
- The runner API listens on loopback only; the kubelet's probe gets `GET /healthz` alone on a second listener at
  the API port + 100, since probes call the Pod IP. A worker resets each runner on first use, closing a session a
  previous worker process left, and asks a runner to drop the session of an open it gave up on.
- `studix_media_exec` is unavailable on this backend because it needs an offline sandbox and sidecars have open
  egress. `studix_composition_run` works.
- CI builds the runner image next to the app image and `deploy/tose/deploy.ts` saves the worker's `sidecars`
  with its digest before deploying any project ([DEPLOYMENT.md](../DEPLOYMENT.md#skill-sandbox-worker)). Production
  is unchanged until it opts in.

## Consequences

- Skills run on TOSE for the dev environment and for any later environment that opts in.
- Sidecar CPU and RAM count toward the pod's billing and the workspace quota. A pool of two runners at the default
  1.5 cores and 3 GiB reserves 3 cores and 6 GiB on top of the worker.
- A crash-looping runner makes the whole pod unready, so a bad runner image blocks the worker rollout.
- The worker and the runners share no volume. File exchange (skills in, outputs out) goes through the runner's HTTP
  API, which has a per-file cap (`STUDIX_RUNNER_MAX_FILE_MB`), a disk cap (`STUDIX_RUNNER_MAX_DISK_MB`) and a
  768 MB cap on `/tmp` (TOSE gives each sidecar a 1 GiB `/tmp` and evicts the Pod past it). Commands get
  `TMPDIR=/work/.tmp`, so most temp files count against the session's work dir instead.
- Kubernetes shares `/dev/shm` and IPC across every container of a Pod. The runners neither wipe nor count it, so
  files one session leaves there (at most the Pod's 64 MiB) stay visible to later and concurrent sessions on any
  runner. Chrome and HyperFrames run with `--disable-dev-shm-usage` and keep nothing there.
- Rollback is configuration: unset `TOSE_WORKER_RUNNERS` and set `STUDIX_SANDBOX=off`. A TOSE runbook rollback
  changes only the worker's own image and keeps the sidecars.

## Threat model

Protected: the database URL, storage keys, secrets box and model keys held by the worker. Exposed to skill code:
everything a process in the runner can reach.

- The runner receives no database or storage secret, no worker-held model key and no Kubernetes token. It gets
  the task's media vendor keys, passed per session, and its own bearer token. Exception, the same as on Docker:
  a task that runs the `codex` or `claude` CLI inside the sandbox has that task's own model credential written
  under `/work` for the CLI to read (`codex-agent-runtime.ts`, `claude-code-sandbox-runtime.ts`); it is wiped
  when the session closes. A Pi task's model key never leaves the worker.
- Containers of one pod share a network namespace, so a process in a runner can reach the worker's loopback
  ports (`/healthz`, `/readyz`) and the other runners. The bearer token, not `127.0.0.1`, authorizes a runner call.
  Each runner holds only its own token.
- Egress is open: skill code can reach the internet and cluster-internal addresses.
- Non-goal: a same-Pod sidecar is not strong isolation between hostile tenants. The backend is gated to
  allowlisted, trusted workspaces for that reason.
- Residual risks: the kernel is shared with the worker, egress is open, and processes inside one runner share a
  uid, so processes of one session can touch that session's files and each other.

## Alternatives considered

- Kubernetes Job per task: strong isolation and per-task resources, but TOSE gives projects no Kubernetes API and
  the worker would need a service account token with pod-create rights, which would break the isolation it is
  meant to add.
- Docker-in-Docker or a mounted Docker socket: needs a privileged pod or host access, which TOSE does not offer
  and which would give skill code the node.
- gVisor or another sandboxed runtime class: the right long-term boundary for untrusted tenants, but it needs a
  cluster-level runtime class that projects cannot select today. Revisit if TOSE adds one.
