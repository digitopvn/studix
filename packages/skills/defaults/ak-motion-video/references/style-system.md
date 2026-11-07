# Style system: profiles and composition

A style is a motion-design grammar: a set of choices along the dimensions below.
Each style ships as a compact semantic profile. A video uses one **base** style
and can borrow individual dimensions from other styles for particular scenes.
Composition changes only presentation and choreography. `composition-contract.md`,
the timing pipeline, the audio mix and the render checks stay the same whatever
styles are used.

## Files

| File | Read when |
|---|---|
| `styles/index.yaml` | always, to pick a style: one entry per style (id, aliases, summary, energy, best_for) |
| `styles/profiles/<id>.yaml` | for the base and each layer style you actually use |
| `style-<id>.md` (a profile's `detail:`) | when the base has one: tokens, layers, components and edge cases from a finished edition |

Do not load every profile. The index is enough to choose.

## Picking styles

1. Map the request onto the index. Match an exact `id` first, then `aliases`
   (brand and inspiration names live only there), then the summaries and
   `best_for` tags. `python scripts/resolve-style.py find "<words>"` does the
   same lookup and prints the top matches.
2. A single style by name ("comic style", "Apple-like") means base only, no
   layers. Stop here unless the brief describes different looks for different
   parts.
3. Add layers only when the brief names a trait the base lacks ("product UI like
   Linear", "blueprint diagrams", "a Nike-style finale"). Each layer borrows
   named dimensions for named scenes, never a whole style.
4. Say which styles you resolved, and why, in the plan. If a name matches
   nothing, or matches two styles equally well, report the candidates rather than
   guessing.
5. When the brief names no style, or two candidates tie, run a bake-off instead
   of asking in the abstract: pick 3–4 profiles that fit the topic's era,
   culture and tone (`resolve-style.py find "<topic words>"`; match the topic,
   not the narration language), build the same hook scene once per candidate
   from the skeleton in `assets/videos/<slug>/bakeoff/<style-id>/` (create the
   project directory first; one sub-session per candidate in default mode (`orchestration.md`), the session itself in `--poor`),
   `snapshot` its busiest moment and show the stills side by side. The user
   picks by eye; record the pick as the base. A bake-off uses no audio;
   generated backdrops (`generated-art.md`) are optional and paid.

Brand names are aliases only: canonical ids describe the motion language. The
output borrows no logos, marks, sonic logos, mascots, trademarked fonts, product
imagery, slogans or exact brand colour values, and never implies endorsement.
Profiles name only freely licensed web fonts and "inspired" hues.

## Dimensions

This is a closed set. Profiles define every one, and layers may borrow only these.

| Dimension | Covers |
|---|---|
| `palette` | mode (dark, light or mixed), colour tokens, colour rule |
| `typography` | font families and weights, scale, tracking, text treatment |
| `layout` | grid, framing, density, where the hero and text sit |
| `material` | surfaces: glass, paper, metal, clay, flat, and their borders and shadows |
| `texture` | grain, halftone, scanlines, noise, gradient meshes (bake heavy ones to PNG) |
| `camera` | virtual camera: push, parallax, orbit, locked-off, handheld shake |
| `transitions` | the scene-in and scene-out vocabulary (the `WINDOWS` kinds) |
| `pacing` | BPM band `[lo, hi]` plus how scene length and holds vary by section |
| `beat_response` | what reacts to beats and kicks, and how strongly |
| `ui_choreography` | how product UI, cards and lists enter, update and exit |
| `diagrams` | how flows, graphs, charts and architecture are drawn and animated |
| `character_motion` | mascots, figures and objects: squash, stepping, "on twos", none |
| `captions` | caption look within the contract's bottom-band rules |
| `sound` | music genre family and SFX density and character |

## Scene types

Use these in a profile's `scene_types` and when scoping layers. Tag each scene in
`data/script.json` with an optional `"type"`.

`cover`, `hook`, `title`, `stats`, `feature`, `ui-demo`, `product-hero`, `spec`,
`diagram`, `chart`, `terminal`, `code`, `comparison`, `timeline`, `montage`,
`quote`, `testimonial`, `cta`, `outro`.

## Composition spec

Write the spec to `data/style.json` (the template is
`assets/templates/data/style.example.json`). The base alone is a complete spec.

```json
{
  "base": "cinematic-product-launch",
  "layers": [
    { "style": "precision-dark-product", "dimensions": ["ui_choreography", "material"],
      "scenes": { "types": ["ui-demo"] } },
    { "style": "blueprint-engineering", "dimensions": ["diagrams", "texture"],
      "scenes": { "types": ["diagram"] } },
    { "style": "accelerated-compute", "dimensions": ["camera", "diagrams"],
      "scenes": { "ids": ["s07-benchmarks"] } },
    { "style": "athletic-impact", "dimensions": ["transitions", "pacing", "beat_response", "typography"],
      "scenes": { "ids": ["s11-finale"] } }
  ]
}
```

A layer's `scenes` selects scenes by `ids` (exact id, or the `sNN` prefix) or by
`types`, both lists. If `scenes` is left out, the layer applies to the whole video.
Style fields accept ids or aliases. The scene list comes from `--script
data/script.json`; a top-level `"scenes": [{"id", "type"}]` array in the spec, used
for drafts before the script exists, wins over `--script`. Unknown keys, scene types
or `palette_mode` values are errors, not silent fallbacks.

## Resolution (deterministic)

1. Resolve every style name to one id: exact id, then alias, case-insensitive.
   Anything else is an error that lists the nearest ids.
2. The base supplies all dimensions for every scene.
3. Layers apply in the order listed. In each scene a layer selects, it replaces
   only the dimensions it names. When two layers touch the same dimension of the
   same scene, the later one wins.
4. A layer's `palette` adds only its accent colours on top of the base
   `bg`/`ink`, unless the layer sets `"palette_mode": "full"`.
5. The base's `constraints` stay binding everywhere. A layer's constraints bind
   only in the scenes it selects. If a borrowed value breaks a base constraint,
   keep the base value and note it in the plan.
6. The invariant layer can never be overridden: the composition contract,
   determinism, the TIMING and word anchors, the caption band and legibility, the
   mix targets, renderer limits and "Done when".
7. Use at most one base and four layers. More than two transition languages in
   one video reads as noise, and the resolver warns about it.

`python scripts/resolve-style.py resolve data/style.json --script data/script.json`
prints the per-scene table (the source style for each dimension), the binding
constraints and any warnings. Paste that table into the plan and build
`index.html` from it. Add `--json` for machine-readable output.

## Building from a resolved table

- Define CSS tokens once from the base palette, then add each layer's accents.
- Give each scene the transition kind of the style that owns `transitions` in that
  scene, and keep the `WINDOWS` loop from the contract.
- Implement signature moves with the contract's helpers (`W`, `WE`, `B`,
  `isKick`, `pop`, `rise`, `draw` and the rest). Do not add CSS animations.
- Loops (idle bobs, drifts, yoyos) get finite repeats sized to the hold. The main
  timeline is paused and seeked, so `repeat: -1` breaks its duration.
- Profiles that call for footage need supplied clips and a HyperFrames video path
  verified with `snapshot`; otherwise use stills with scale and pan.
- If the base has a `detail:` reference, follow it for anything the profile
  leaves open.

## Adding a style

1. Copy an existing profile to `styles/profiles/<id>.yaml`. The id is kebab-case
   and describes the look, not a brand.
2. Fill every dimension with concrete, implementable values: hex colours, Google
   Fonts or OFL families, GSAP eases, durations, pixel sizes.
3. Put brand or inspiration names in `aliases` only.
4. Run `python scripts/resolve-style.py index --write` and then
   `python scripts/resolve-style.py validate`.
