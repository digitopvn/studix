# Voice takes: gating and stylized voices

Open when generating or choosing takes for a line, from any TTS provider, or when a character needs a
processed voice (robot, radio, creature). The provider-specific prompting lives in
`audio-voice-and-mix.md` ("Voice: choosing the source").

## Gating takes from any TTS provider

`gate-tts-takes.py` runs the checks above on takes from any provider, through the `asr` role of
engines.json: the word match against the script, the voiced f0 median and its offset in octaves from the
speaker's baseline (the median of their approved takes; keep it in the character's notes), and the speech
span for fitting the slot. Emotional or shouted direction drifted a male voice toward a female pitch in some
takes while the words stayed right; the pitch gate (default 0.25 octave) removes those before anyone
listens. The gate only removes takes; the user's ear picks among the rest.

Non-verbal takes (effort grunts, battle shouts, panting) sit far above a speaker's talking baseline by
nature, and the 0.25 default rejected every one. Gate them with `--max-octave 0.75` (plus `--min-match 0`
when the take has no words) and record the relaxed threshold in the run report.

Two more traps from FRONTIER ep03:

- **Swallowed opening words.** The word match passed takes whose first word was clipped or mumbled, because
  the rest of the line matched. Transcribe the first second of each take on its own and require the first
  word of the script.
- **Shouts from a baseline that is too high.** Shouted male lines failed the pitch gate because the baselines
  in the character files sat 0.3-0.5 octave above the voices' real talking pitch. Measure the baseline from
  approved calm takes before gating shouts. When a good take drifted high, a pyworld (WORLD vocoder)
  down-shift of the f0 kept the voice natural; rubberband pitch shifting did not.
- **Peak lines need direction.** Shouts, anger and a stammer read flat with the beat's one-sentence style;
  direct the peak line on its own (volume, breath, a break in the voice) and generate it as its own batch.
- **Slot fit.** 18 of 40 lines ran past their slots on ep03. Check the speech span against the slot at the
  gate and retime the edit to the take early, not in the final mix.

## Stylized voices (robots, radios, creatures)

Prompt-only TTS did not make a convincing robot: the user rejected the first try, which only changed the
TTS style prompt. DSP on the paid clean takes did, with no new API call. `make-voice-variants.py` applies a
preset group from `assets/templates/voice-dsp-presets.json` (robot A-E, radio; a series adds its own in
`<series>/voice-dsp-presets.json`) and builds one reel with a labelled card per variant and the line in
place.

- The voice of a character is a taste call: send the reel and wait for the pick; do not choose for the user.
  FRONTIER's chatbot android got variant C (three detuned voices, a tight flanger, high-pass) from five.
- Record the pick (group, variant, source take) in the character file so later lines get the same chain.
- Some variants start from a brighter take than others (`source` in the preset); generate both takes first.
