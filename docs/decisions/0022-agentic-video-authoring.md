# ADR-0022: Agentic video authoring is the main path

## Context

The Claude planner filled a small VideoIR (headlines and captions) that a fixed renderer drew. A live
run of a 10-second teaser came out as text cards on a dark background, silent, at 960x540, with
captions over the headline. A reference run of Claude Code on the same prompt
(`plans/261107-1244-claude-motion-demo/process-report.md`) wrote its own composition, generated audio
first, looked at rendered keyframes three times and fixed two bugs that were invisible in code. It
cost under US$0.50 and matched the target quality.

## Decision

- The `skill-agent` pack is the main path for agent-made video. The job's agent (Claude Code, Pi or
  Codex, chosen by `agent`) authors the composition in the skill sandbox
  ([ADR-0018](0018-skill-sandbox.md)) with the enabled skills mounted whole, renders it and leaves
  `/work/out/video.mp4`.
- Studix states only the output contract: 1080p at the brief's aspect ratio, duration within 0.5 s of
  the brief, an audible voice-over, -16 LUFS integrated (+/-2 LU) with true peak at or under -1 dBTP.
  The skill decides the method. The agent must look at rendered frames before and after the final
  render and reports each pass as `qaRounds`, which land in the version's metadata.
- The server re-checks that contract with ffprobe and a loudnorm measurement before it stores the
  file. A miss fails the job with `VALIDATION`, listing every problem; nothing is shipped silently.
- Template fallbacks stay for packs whose agent stage cannot run, but each one shows on the job view
  (`stages[].fallback`) and on the dashboard job page.
- A Claude `planner` or `agent` combines with every pack.

## Consequences

- `skill-agent` needs `STUDIX_SANDBOX=docker` and a job budget above the stage cap (800¢); the cap is
  a ceiling, the reference run spent far less.
- Quality now depends on the skill and the sandbox toolchain (Chromium, ffmpeg, fonts, audio tools),
  which the sandbox image pins.
- A file that misses the contract costs the agent run without a result; the job's stages keep the
  run's cost and QA record for diagnosis.
