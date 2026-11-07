# Prompt compilation

Shot prompts are compiled from production state, never hand-written per shot.

```bash
python3 scripts/film.py prompt films/<slug> S02_SH004          # readable
python3 scripts/film.py prompt films/<slug> S02_SH004 --json   # for automation
```

## Output

- `image_inputs`: the shot's canonical references in a fixed order (identity,
  wardrobe, location, props), each with its `Image N` slot and file path.
- `audio_inputs`: dialogue masters bound to visible speakers, with the trim
  into the cue and the interval on the shot clock.
- `prompt`: sections in this order, omitting empty ones:

```text
IDENTITY REFERENCES   which image slots are which character, identity version
WARDROBE              wardrobe state per character (+ its image slot)
LOCATION              location, time of day, weather, lighting
PROPS                 props and their holder/position
AUDIO AUTHORITY       Audio N = authoritative dialogue, sentence timings in shot
SHOT / LENS           framing, lens, duration
ACTION                what happens
PERFORMANCE           emotion
CAMERA                movement
LIPSYNC               match Audio N; no mouth motion outside bound intervals
CONTINUITY            screen sides, conditions, hair/accessories, cut-from shot
STYLE                 project visual language
NEGATIVE CONSTRAINTS  no subtitles, no extra dialogue, no music + project list
```

Off-screen dialogue appears as an instruction that nobody in frame lip-moves
to it. Music and dialogue are always excluded from the generated audio because
the stems are mixed separately.

## Using it with a provider

Pass the images and audio in the listed order through the installed generation
skill, which owns parameter names, upload calls and length or format limits.
If a provider takes fewer images than the shot lists, drop from the end of the
list (props, then location) and never drop identity references; record the
dropped references on the generation entry.

Adapting wording to a provider's documented prompt style is fine; changing
facts (wardrobe, props, timing, sides) is not. Any fact change goes into the
graph first, then the prompt is recompiled and `prompt_version` is bumped on
the next generation.
