# 0018. Skill sandbox for tool-using Pi tasks

- Status: Accepted
- Date: 2026-11-07

## Context

A Pi agent that follows an imported skill (for example `motion-video`) has to run
scripts: write a HyperFrames composition, call a TTS provider, render with
Chromium and check the result with ffprobe. Pi's built-in `bash`, `read`, `write`,
`edit` and `ls` tools act on the worker's own filesystem and environment, where
the database URL, the storage keys and the secrets box live. A path guard or a
`cwd` is not a boundary ([SECURITY.md](../SECURITY.md#worker-isolation)), and the
skill files are untrusted ([ADR-0017](0017-external-github-skill-store.md)).

## Decision

- A stage that asks for tools runs them in a **per-task Docker container** started
  by the worker (`STUDIX_SANDBOX=docker`). The Pi session itself stays in the
  worker; Studix registers Pi's own tool definitions with their operations
  delegated to `docker exec`, so they replace the built-ins of the same name.
  Without a sandbox, a task that asks for tools fails with `VALIDATION`.
- The image (`docker/sandbox.Dockerfile`, `studix-sandbox:local`) holds only the
  toolchain: Python 3, Node 22, ffmpeg, the pinned chrome-headless-shell,
  HyperFrames and the multix CLI at the Studix `MULTIX_COMMIT`. It holds no Studix
  code and no secrets.
- The container runs with a read-only root, `--cap-drop ALL`,
  `no-new-privileges`, uid 1000, `--init`, and caps on CPU, memory (no swap),
  PIDs and wall time (`STUDIX_SANDBOX_CPUS`, `_MEMORY_MB`, `_PIDS`,
  `_WALL_SECONDS`). The stage's own turn, token, cost and time caps still apply
  ([ADR-0015](0015-agent-stage-caps-and-host-handoff.md)). The network is open
  (`bridge`, or `STUDIX_SANDBOX_NETWORK`) because skills call provider APIs.
- Each task gets its own work directory mounted at `/work` and the enabled skills
  mounted read-only at `/skills/<name>/`. Files the agent leaves in `/work/out`
  are copied out to the stage's attempt directory; the container and its
  directory are removed when the task ends, and leftovers of a crashed worker are
  swept at start (label `studix.sandbox=1`).
- The container's environment holds only the task's media vendor keys
  (`MULTIX_ENV_KEY_NAMES`, every key Multix reads: the workspace's own key first, then the platform
  key, then the worker's variable). Values are passed by name (`--env NAME`), never
  on the command line. Model keys stay in the worker with the Pi session.
- Skills reach the sandbox through the `SkillBundleSource` port: the skill store
  in production, a directory (`STUDIX_SANDBOX_SKILLS_DIR`) in tests and local runs.
  Bundles are written with safe relative paths only and need a `SKILL.md`.
- The `skill-agent` pack uses it: the agent makes the whole MP4, Studix probes it
  (an audio track is required), stores it, wraps it in a one-shot VideoIR and
  ships it through the normal upload and finalize stages.
- `studix_create_video` and `studix_submit_agent_task` accept `model`
  (`provider/modelId` from the catalog) and `reasoningEffort`; the effort is
  passed to Pi as `thinkingLevel` and both are recorded on the job's model
  snapshot or the task's usage.

## Consequences

- The worker needs a Docker daemon. Running the worker itself in a container
  (self-host compose) needs the socket and a host path mapping for the work
  directory; that wiring is not part of this decision, so the sandbox is off there
  by default.
- A skill can still spend the task's vendor keys and reach the internet; the
  budget caps and the per-task key scope bound that, not the network.
- The sandbox image must follow the Studix image's pins (multix, Chromium) so a
  skill render matches an engine render.

## Alternatives considered

- **Pi tools on the worker with a path guard**: rejected, it is not a process
  boundary and exposes the worker's secrets.
- **The whole Pi session in the container**: the model key would have to enter the
  container, and the harness caps and spend recording would move out of the
  worker.
- **gVisor or Firecracker**: stronger isolation, but not available on the current
  hosts; the driver port (`SandboxDriver`) keeps that option open.
