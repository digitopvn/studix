# Motion graphic: cuts on beats, reveals on words, music ducked (#433)

Status: in progress

## Outcome

A motion graphic with a music bed cuts on the music's downbeats, reveals each card's headline and layout
when the voice says them, gets a music bed composed in intro / build / drop sections (the drop on the CTA
card), and the music dips under speech.

## Constraints

- Beat analysis is local (FFmpeg decode + onset detection), never a paid call.
- Word timings come from the ElevenLabs `with-timestamps` alignment (Multix `elevenlabs tts --timestamps`)
  when the speech route is ElevenLabs; any other route, or a take stored without timings, falls back to an
  estimate inside the measured speech span.
- Composition plan through Multix `elevenlabs music --plan`; MiniMax keeps its prompt-only call.
- Graphics without music keep today's cuts; graphics without a voice-over keep today's reveal times.

## Non-goals

- No new paid calls (no forced-alignment call, no extra music call).
- No change to other packs' timing. Ducking is opt-in per track (`duckDb`).

## Phases

1. Renderer + IR: `AudioTrack.duckDb`, ducking envelope in the FFmpeg mix, `analyzeBeats` beat grid.
2. Provider: ElevenLabs speech `params.timestamps` -> `GeneratedMedia.words`; ElevenLabs music
   `params.sections` -> composition plan file.
3. Motion-graphic pack: music stage before the voice stage (composition plan from the cards, beat grid
   kept in IR metadata, `duckDb` on the bed); voice stage snaps cuts to downbeats within tolerance and
   moves headline / layout reveals onto spoken words; stored takes keep their word timings.
4. Docs: `docs/WORKFLOW_PACKS.md`, `docs/RENDERER.md`, IR schema docs.

## Acceptance

- Unit tests: beat grid on a synthetic click track, ducking graph runs in FFmpeg, composition plan argv,
  timestamps parsing, cut snapping respects every voiced card's need, reveals land on words.
- `pnpm check` green.
