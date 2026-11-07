# Action sound measured on reference films

Numbers from eight action anime references (25 s to 6 min) and FRONTIER ep02, measured in 2026-10 with
`measure-reference-cut.py` (the 12 strongest transients per film), `mix-shape-features.py` and htdemucs stems.
Use them as a band to hold an action scene against, not as a verdict on taste. Picture rhythm is in
`edit-captions-and-render.md` (Cutting craft) and `gl-compositing-and-fx.md` (Anime craft).

## Hits

- **On the contact, not on the cut.** 1-3 of the 12 hits sat within 2 frames of a cut, against 1.4-3.1
  expected by chance, and no more often near an impact frame. Spot each hit on the contact or release frame
  inside the shot; a cut is not a cue.
- **Find the contact frame on the generated clip, not in the plan.** A clip guided by a blockout put its
  impact flash 3 frames after the blockout's. Read per-frame brightness (`signalstats` YAVG) around the beat
  and place the hit, the suck-out and the music accent on the measured frame.
- **Low end across the mix.** The hits themselves had most of their 250 ms energy under 120 Hz in seven
  references (median share -0.45 to -3.9 dB of total; the eighth is music and vocal led), and ep02's hits
  matched them (-0.3 dB). The gap is the whole mix: the band under 120 Hz sat at -1.7 to -3 dB of total in five
  of eight references, ep02 at -5.0 with more energy at 120-500 Hz. Keep a low layer in the music and beds of an
  action beat, not only in the hits.
- **Density.** Action shorts mixed as a wall: 0.4 s block levels p10/p50/p90 about -19/-14/-9 dBFS (the
  densest -14/-11/-9), hits riding a bed that takes 1.6-35 s (median per film) to fall 20 dB under them, and
  integrated loudness -9.6 to -15.4 LUFS in seven of eight. Longer references with dialogue opened up to about
  -25/-17/-12. Ep02's hits fell 20 dB in a median 0.65 s onto a sparse floor: in action beats keep a music or
  debris bed under the hits instead of silence between them.
- **Silence before impact is rare and saved for the climax.** A drop of 6 dB or more in the second before a
  hit came before 0-4 of the 12 hits (seven references had at most one): 6.6 dB at 2.6 s in a 25 s short,
  6.9-8.5 dB before four hits at the peaks of a 30 s long take, 11.4 dB 4 s from the end of a 140 s piece. Use
  the suck-out once or twice a sequence; used on every hit it stops working.

## Music under action (stems)

Music here is the htdemucs `other` plus `bass` stems; SFX debris and whooshes leak into `other` and `drums`,
so treat a dB or two as noise.

- **Music share.** Music sat 4.1-8.3 dB under the full mix in the references (median over active blocks);
  ep02 at 2.3 dB under. In the references SFX and voice carry more of the mix than the score does.
- **Ducking under voice is small.** Music was 0.7-4.2 dB lower while a voice led the mix in six references (two
  ran it louder under shouts); ep02 ducked 3.9 dB. A model's "ducked 3-12 dB" overstated it. Duck enough for the
  words to read, and let the music stay up under a battle cry.
- **No ducking at hits.** Around the 10 strongest drum-stem onsets, music changed by a median -1.7 to +2.1 dB.
  The hit wins by its transient and low end, not by pulling the music down. FRONTIER EP03 ducked music and beds
  over its hits and the hits measured flat (+0.1 to -0.8 dB over the 0.25 s before): the music was quieter at
  the hit than ahead of it. A 0.28 s dip that releases on the hit frame gave +3.7 to +5.2 dB, but measured
  against the hole it made; against the bed before the dip the landing was still -0.6 dB. Measure a hit against
  the 0.8-0.3 s before it, and in 200-5000 Hz for a phone speaker. The cause was the hits-bus compressor holding
  the contact near the bed; on an uncompressed bus with the bed lowered, the landing and stop came to +5.5 and
  +5.8 dB.
- **Music stops are real but short and few.** The music stem fell 12 dB or more under its 3 s median, for
  0.2-3 s, 0-2 times in each piece up to 140 s and 7-8 times in each 5-6 minute film; one sat 1.5 s before the climax hit
  of a 140 s piece. Ep02 had 11 in 6 minutes, a similar rate.
- **Model claims.** Gemini placed five "hard stops" or pre-hit silences; on the music stem none was a stop
  (three rose or held level, one fell 2 dB, one 6 dB). Verify any claimed stop on a stem before copying it:
  split with htdemucs (any torch environment with a GPU) and read
  0.1 s block levels of `other` plus `bass` around the time.

## Voice in action (heard, not measured)

Effort breaths and grunts on the strike frames, a shout that peaks on the release, panting over the quiet
aftermath. Breaths and grunts are performance, so generate them as takes with the line, not as SFX.

## Action plan before the shots

`scenes/<sc>/action-plan.json` (example: `assets/templates/action-plan.example.json`) writes a fight as
beats: phase (anticipation, execution, contact, reaction, recovery), positions per actor, props in hand, contact,
visibility (show, imply, hybrid), emphasis (signature, support) and the shots with an `event_frame`.

- `anime-studio.py validate-action <scene-dir>`: axis jumps need `axis_cross` with a reason, a contact uses a
  prop the attacker holds, implied contact needs a legible reaction, one signature beat per scene, event
  frames inside their shot; more than 3 flashes within 1 s is a warning.
- `anime-studio.py plan-action <scene-dir> [--grid] [--reduced-flash]` writes `work/action/<sc>-proposal.json`
  (EDL rows, hit times on the frame grid, keyframe jobs, edit cues from `impact-fx-presets.json`, SFX anchors)
  and a beat grid. `--reduced-flash` swaps full-screen tints for softer presets. It never edits the EDL.
