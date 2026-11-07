# Assembly and delivery

Assembly conforms approved shots to the graph's cut and mixes the separate
stems. It does not replace a professional NLE: export what an editor needs when
the user wants finishing elsewhere.

## Final timeline

```bash
python3 scripts/film.py validate films/<slug> --check-media
python3 scripts/film.py timeline films/<slug> --mode final --write
```

`final/timeline.json` places each shot's picture source: the finished dedicated
lipsync output for shots routed to a dedicated pass (never the raw generation),
otherwise the selected generation. It
lists DX, FX, AMB and MX cues separately with their start times, and marks
`video_audio: discard`. Blockers name every shot not yet APPROVED (or still
QC_FAILED), any missing picture source, and any cue that is not master/approved
or has no file. Every open `validate` error (gate, continuity, audio-first) is
also a final-mode blocker. Resolve blockers; do not assemble around them.

`final/video.ffconcat` is the picture track (each clip trimmed to its
`duration_target` with `outpoint`). Paths are relative to `final/` and start
with `../`, which the concat demuxer only accepts with `-safe 0`; quotes inside
paths are already escaped. `--write` refuses to write either file while
blockers remain, because a track list with skipped shots drifts against the
absolute audio starts. Render, conform frame rate and aspect, lay
the stems and mix through the installed media-processing skill.

## Dialogue master remux

Always lay the original DX master from `audio/dialogue/` on the final timeline,
replacing any audio a video generator or lipsync tool produced. Visual lipsync
was conditioned on that master, so the master stays in sync while keeping its
original waveform and quality.

## Delivery checklist

- Duration matches the timeline; frame rate and aspect match `project.json`.
- Dialogue is the master, intelligible over music; loudness meets the delivery
  target the user names (platform or festival spec).
- Stems exported alongside the mix (DX, FX, AMB, MX) for later fixes.
- Spot-check every scene transition and every QC-repaired shot in context.
- Shots move to ASSEMBLED only after the cut containing them is approved.

Keep `final/` reproducible from the graph: rebuild the timeline after any graph
change rather than editing an exported cut by hand.
