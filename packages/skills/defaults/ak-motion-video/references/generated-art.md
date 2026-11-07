# Generated art: baked illustration layers

Some looks cannot be drawn convincingly with CSS and SVG: an editorial paper
collage, a woodblock print, a 1950s pulp poster, a riso zine. For those, an
image model paints the art once, the art is cut into layers and baked to PNG
under `assets/images/`, and GSAP animates the layers. The video stays a
deterministic HyperFrames composition; no video model is involved. Adapted from
the image layer and local keyframe engine of vox-director (MIT).

Use it when the base profile's `texture` or `material` calls for printed or
hand-made imagery, or when the user supplies a photo of a person or product to
place in the scene. Skip it for UI, data, terminal and diagram scenes: those
stay live HTML so they remain crisp and editable.

## Rules that do not change

- **Text stays live HTML.** Do not bake headlines into generated images: the
  composition renders type crisply, kinetic type and captions need it, and
  facts must be editable. Leave a clean area in the art for the headline.
- **Generate with the `multix` CLI**, the same tool the audio pipeline uses
  (section "Tools" below). No other image service or API key is needed.
  Check the flags with `--help` on the installed version before running.
- **Review the art before animating it.** Look at every image with native
  vision. Re-rolling a still is cheap; rebuilding choreography around weak art
  is not.
- **Record how each asset was made** (model, prompt, seed if any) in
  `data/art.json` so a re-roll reproduces the look.
- Treat the provider's licence and content rules as binding. Real people and
  brand marks follow `style-system.md`'s brand policy: no logos, marks or
  likenesses unless the user supplied them and has the rights.

## Tools

Pick the route once per video and use it for every image, so the look stays
consistent:

| Condition | Generate | Edit / anchor a supplied photo |
|---|---|---|
| `codex` CLI on PATH (`command -v codex`) | `multix openai generate --driver codex` | `multix openai i2i --driver codex --ref <photo>` |
| otherwise | `multix gemini generate --model <verified id> --aspect-ratio 16:9 --size 2K` | `multix gemini i2i --ref <photo>` |

```bash
# Codex route: image generation runs through the local Codex CLI session
multix openai generate --driver codex --size 1536x1024 --quality high \
  --prompt "<five-part prompt>" --image-format original --output assets/images/s03-bg.png

# Gemini route
multix gemini generate --model <verified-image-model> --aspect-ratio 16:9 --size 2K \
  --prompt "<five-part prompt>" --image-format original --output assets/images/s03-bg.png
```

- Always pass `--image-format original` (or `--no-webp`): multix converts to
  WebP by default, and cut-outs need lossless PNG with alpha.
- The Codex size presets are 1536x1024 (landscape), 1024x1536 (portrait) and
  1024x1024; generate backdrops a little wider than needed and crop, or
  upscale the backdrop only, since pieces are usually smaller than the frame.
- If the Codex route fails (not signed in, driver error), fall back to the
  Gemini route for the whole video, and say so in the plan.

## The image prompt (five parts)

```text
[1 STYLE BLOCK, identical for every image of the video]
  <medium> in the style of <era or movement>; <print finish>; <lighting>.
  Printed, hand-made texture, not 3D, not CGI, not photoreal; keep grain and
  paper imperfections.
[2 PIECES, described as separate cut-outs]
  <main subject>, <a prop>, <a decorative scrap>, each a distinct piece with a
  clear edge and its own drop shadow.
[3 BACKGROUND] backdrop: one flat <colour from the base palette> background;
  single piece to cut out: a pure flat #00ff00 background, no shadow on it.
[4 SPACE] keep the <top-left / lower third> empty for a headline; no text,
  no letters, no logos anywhere in the image.
[5 TECH] aspect ratio <16:9 | 1:1 | 9:16>, high resolution.
```

- Reuse the style block verbatim on every image. Only the pieces and the
  background colour change; that is what makes ten images read as one video.
- Describe distinct pieces with visible edges and shadows. Layered art can be
  cut apart and parallaxed; a blended painting can only be panned as one plane.
- Take colours from the base profile's palette tokens, by name and hex.
- Phrase positively for models that ignore negatives; keep the "no text" line
  explicit because image models add lettering when they are not told otherwise.

### Dimension vocabulary

Fill the style block with one term per axis. The era is the strongest lever: it
moves palette, layout and finish together.

| Axis | Terms |
|---|---|
| Medium | paper collage, torn-paper collage, photomontage, screenprint, risograph, letterpress, linocut, woodcut, lithograph, gouache, flat vector, photocopy, rubber stamp |
| Era / movement | Swiss International, Bauhaus, mid-century modern, Russian Constructivism, Dada photomontage, Pop Art, '60s psychedelic, punk zine, Memphis, Art Deco, WPA travel poster, atomic age, retro-futurism |
| Composition | modular grid, asymmetric, strong negative space, diagonal, foreground–mid–background depth, full-bleed, radial, stacked bands, off-centre focal point |
| Palette | 2–3 colours, duotone, monochrome plus one accent, riso pink and federal blue, Bauhaus primaries, '70s mustard/rust/avocado, cream or kraft base, named hex values |
| Print finish | halftone, Ben-Day dots, riso misregistration, letterpress deboss, newsprint, kraft card, aged paper, fold creases, deckled or scissor-cut edges |
| Lighting | flat even light, shadowless scanned-document light, straight-on, flat-lay top-down, soft paper drop shadows |
| Mood | playful, bold, urgent, editorial, nostalgic, optimistic, ominous, satirical |

The collage-family profiles (`editorial-collage-explainer`, `paper-cut-collage`,
`mid-century-retro`, `punk-zine`, `constructivist-poster`, `wpa-screenprint`,
`groovy-seventies`, `ink-woodblock`, `newsprint-editorial`, `art-deco-luxury`)
list their medium, era and finish in `texture` and `material`; start the style
block from those.

## From one image to animated layers

1. **Generate pieces, not posters, when you can.** One image per hero element
   on a flat background is easier to cut than a busy poster. Generate the
   backdrop separately.
2. **Cut out.** Generate each piece on a pure chroma background that does not
   appear in the piece (`#00ff00`, or `#ff00ff` for green subjects) and key it
   out locally, with no extra service:
   `ffmpeg -y -i piece-raw.png -vf "colorkey=0x00ff00:0.28:0.06,format=rgba" piece.png`.
   Tune similarity and blend until edges are clean with no green fringe. For an
   existing poster, ask the edit route (`i2i --ref poster.png`) to isolate one
   piece on the chroma background, or crop rectangles for strips and blocks that
   are already rectangular. Clean residue: keep the largest connected blob and
   erase fragments of neighbouring pieces.
3. **Bake** each piece as a transparent PNG; bake heavy textures (halftone,
   grain) into the PNG rather than CSS filters (`composition-contract.md`
   renderer limits).
4. **Assemble in the composition** with the collage-assembly recipe in
   `motion-craft.md`: pieces fly to their home positions so the settled frame
   reconstructs the poster.

## A supplied photo of a person or product

Place the subject in the illustrated world as a photographic sticker; never
redraw it.
- **Person:** cut the face and hair out of the photo as is: no halftone, ink
  or texture on skin or hair, no change to the expression. Poses and gestures
  belong to an illustrated body or to the layout, never to the face. If the
  model also draws a body, lock the outfit in words or it drifts.
- **Product:** keep its exact shape, materials, reflections and every letter of
  its label pixel-faithful; restyle only the world around it.
- Because the composition animates the cut-out as a rigid layer, its pixels
  cannot drift during motion. Re-check the face and label in the generated
  stills before cutting them, since an edit model can still re-letter a label.

## Cost and review loop

Generate a small batch for one scene first, review it, then fill the rest with
the same style block. When the style is still open, the bake-off in
`style-system.md` can use one generated backdrop per candidate style.
