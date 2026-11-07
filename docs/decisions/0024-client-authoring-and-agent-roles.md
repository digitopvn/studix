# ADR-0024: Client-authored compositions and agent roles

## Context

Studix ran agent-made video only as a delegated job: the client asked, a worker agent made it. A
capable MCP client (Claude Code, Codex) can author video itself, and did so better when it could
look at its own frames. Delegated jobs also ran one agent for every concern, so a cheap fast model
could not build while a stronger one judged.

## Decision

- Compositions: `studix_composition_write`, `_run` and `_read` give the client a file tree in
  object storage and a way to run any command over it in the skill sandbox
  ([ADR-0018](0018-skill-sandbox.md)): HyperFrames or Remotion renders, `multix generate` for images,
  TTS, music and SFX, ffmpeg, contact sheets. Studix locks no flow; the only hard checks are on
  outputs (size, duration, loudness, budget), and only when the run asks for them.
- Compositions need no table: a manifest sits next to the files under `compositions/<id>/`. A run is
  a `composition.run` job, so budget, audit, cancel and the dashboard job list work unchanged.
- Delegation keeps its in-sandbox tools (bash, read, write, edit): the same capabilities as the
  composition tools, without a round trip through MCP.
- `skill-agent` jobs take optional `roles`. The director writes script and direction, the builder
  makes the video, QA looks at the render (vision, or `multix gemini analyze`), scores taste, motion,
  brief and audio against a rubric and sends it back below 7, at most 3 rounds. Each role is any
  catalogue runtime and model. Roles live in the job payload; scores land in the version metadata.

## Consequences

- No migration. A composition's size is bounded by `COMPOSITION_LIMITS`.
- An overrun approval inside the QA loop restarts the loop from round 1.
- The QA render is stored at `generated/<job>/skill-agent/qa-r<n>.mp4` and reaches the QA agent by
  signed URL.

## Alternatives considered

- MCP tools per step (render, TTS, frames): more tools to keep in sync, and each locks a flow.
- A compositions table: unneeded while the manifest answers every read.
