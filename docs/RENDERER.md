# Renderer

`@studix/renderers` implements the `RendererAdapter` port
([ADR 0010](decisions/0010-renderer-and-media-provider-adapters.md)):
HyperFrames composes and captures the picture in headless Chromium, FFmpeg mixes
the sound and finishes the deliveries. The code is the reference; this page
records the contract and the measurements behind it.

## What renders (Implemented)

| IR element                         | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Title, text, image shots, captions | HTML + GSAP timeline per scene (`hyperframes/scene-composition.ts`, `shot-markup.ts`); burned captions are 44 px semibold at a 1080 px short edge                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Video shot, video background       | Muted `<video>` with scene-local `data-start` / `data-media-start` (`trimStartMs`); HyperFrames extracts the frames with FFmpeg and injects them                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Audio tracks (all kinds)           | Mixed by FFmpeg, never by the browser: trim, `playbackRate` (atempo, pitch kept), `volume` x `gainDb`, music `duckDb` under speech, `fadeInMs` / `fadeOutMs`, delay to `startMs`, summed without normalisation (`ffmpeg/audio-mix.ts`)                                                                                                                                                                                                                                                                                                                                               |
| Sound of an unmuted video shot     | Joins the mix at the shot's absolute time, clamped to the shot window                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Layout shot                        | Built-in layout drawn from typed content (`prompt-box`, `code`, `chips`, `checklist`, `counter`, `cards-row`, `swatches`, `stat`, and the product UI kit `chat`, `tool-call`, `pipeline`, `player`, `usage`, whose own words such as "Running" or "Approve" follow the IR language) in palette roles, its parts built in by the same seek-safe GSAP timeline (`hyperframes/layout-markup.ts`); code uses bundled JetBrains Mono. A landscape (wider than tall) frame draws it 1.25x larger, and it is centred above the burned-caption band                                          |
| Logo shot (`lockup`)               | The logo mark beside `text` (or the brand name), both sized by the shot's text role (mark 1.5x); a lockup in the top region shrinks a layout under it so both fit                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Scene camera, depth, motif         | `camera` moves every plane over the whole scene by its depth (back 0.5, underlay 0.75, shots 1, front 1.4; `parallax` spreads them to 0.2 / 0.5 / 1 / 2.4). `depth.background` draws a grid and a glow behind the shots and grain and a vignette as a fixed lens over them; `depth.foreground` draws bokeh in front and corner brackets on the fixed lens. A `motif` shape travels one frame edge per scene and rests at the same pose on both sides of a cut, so a `match-cut` (a hard cut, no stage tween) reads as one object (`hyperframes/scene-depth.ts`). Captions never move |
| Scene transitions                  | `transitionOut` plays half at the end of the scene and half at the start of the next: `fade`, `slide`, `wipe`, `zoom`, `iris` (circle clip), `whip` (fast lateral throw); `cut` and `match-cut` play nothing (`hyperframes/scene-timeline.ts`). Neighbours follow the timeline order, not the order of the scenes array. IR validation (issue code `camera`) rejects two adjacent scenes with the same camera move other than `static`, and a `match-cut` without a motif of the same shape on both scenes                                                                           |
| Composition shot (film scene)      | Captured first by the ported film engine (`film-engine/film-composition-render.ts`), each scene as its own HyperFrames root composition, then spliced back as a muted video shot                                                                                                                                                                                                                                                                                                                                                                                                     |
| Composition shot (HTML card)       | Compiled inline as a full-frame card layer above the scene shots, under the front depth plane, the lens and the captions (`hyperframes/html-card-compile.ts`); see [HTML cards](#html-cards)                                                                                                                                                                                                                                                                                                                                                                                         |

Media types: images `png/jpeg/webp/gif/avif/svg`, video `mp4/webm/mov`, audio any
`audio/*` FFmpeg decodes. `hyperframesSupport()` reports anything else instead of
dropping it.

### Film scenes

A composition shot names a code asset of type `application/vnd.studix.film-scene+json`: a
versioned package with an EDL and an ES module that exports `scene` (`film-scene-package.ts`).
The package refers to IR media only as `asset:<id>`; the renderer resolves those tokens to project
paths, and a malformed package is `VALIDATION`. The engine under `packages/renderers/film-engine/`
is ported as-is from anime-creator ([PORTING.md](PORTING.md#port-record-film-engine-và-pack-phim)).
Its page loads GSAP and fonts from the project, and a CSP keeps it off the network.

Captures are keyed by the scene content, its media, params, duration, fps and quality, so a retry
in the same work directory reuses them.

Packs author scenes through `@studix/renderers/film-scene`, which has no browser dependency.
`filmPlateScene` builds a one-shot scene that moves a still: a camera push towards a focus point
and, optionally, particle weather (`petal`, `sakura`, `snow`, `ember`, `leaf`, `ash`). The
narrative packs use it for T0/T1 shots instead of an image-to-video call.

### HTML cards

A composition shot can also name a code asset of type `application/vnd.studix.html-card+json`:
`{ format: "studix.html-card", version: 1, html, css, tweens }` (`hyperframes/html-card.ts`). `html`
holds up to 16,000 characters, `css` up to 12,000, and `tweens` up to 40 entries. A card is agent-authored
data only, and **no agent code runs**. Studix checks the markup and CSS against allowlists, re-serializes
them, and generates every line of the card's script itself.

- **`html`** is parsed with htmlparser2, and only the checked tree is serialized into the page, never the
  original string.
  - Allowed tags: `div`, `span`, `p`, `h1`–`h3`, `strong`, `em`, `b`, `i`, `br`, `ul`, `ol`, `li` and
    inline `svg` with its shape, text, gradient, `clipPath` and `mask` elements.
  - Allowed attributes: `class`, `id`, SVG geometry and paint attributes, `aria-hidden` and `role`. Event
    handlers and `style` are not allowed.
  - Attribute values may contain no URL scheme, and `url()` may only point at `#id`.
  - SVG elements must sit inside `<svg>` and HTML elements outside it, inline elements hold only inline
    content, and lists hold only `<li>`. The browser therefore builds the same tree Studix checked.
  - Every `id` becomes `<card element id>-<id>`, and `url(#id)` references and `#id` selectors are
    rewritten to match, so two cards never share an id.
- **`css`** is parsed with PostCSS and re-serialized rule by rule.
  - At-rules, nested rules, `!important`, `url()` other than `url(#id)`, `expression()`, `image-set()`,
    `element()`, `behavior` and `-moz-binding` are rejected, and so is a parse error.
  - Every selector is prefixed with the card id as a descendant selector. Selectors that start with `+`
    or `~`, or that use `*`, `&`, `:root`, `html` or `body`, are rejected, so a rule can only style
    elements inside the card.
  - Bare declarations style the card element itself. The renderer's own rule comes after them and always
    wins on placement, clipping and visibility. `contain: paint` keeps fixed-position children inside the
    card.
  - Palette roles are `var(--c-<role>)`. The bundled brand fonts are `var(--font-heading)` (700 and 800
    bundled) and `var(--font-body)` (400 and 600 bundled).
- **`tweens`** are validated objects, `{ target, at, duration, from?, to?, ease?, stagger? }`.
  - `target` is a simple selector (at most four parts) resolved with `querySelectorAll` inside the card.
  - Properties are limited to transforms, `opacity` and `strokeDashoffset`, eases come from a fixed list,
    and `at` is in seconds from the card start.
  - Studix writes each tween as a GSAP `fromTo`, `from` or `to` call with JSON-encoded values, on a
    sub-timeline placed at the shot start. The card element fades in and out with the shot.

`htmlCardProblems()` returns every broken rule as a short sentence. The renderer reads each card from
`assetFiles` and parses it. A missing file, bad JSON, a schema failure or any problem stops the render with
`VALIDATION`, and `details.problems` lists the reasons. Code assets are never copied into the project.

As defense in depth, `index.html` of a render with a card carries a CSP
(`default-src 'self' 'unsafe-inline' data: blob:; connect-src 'self' data: blob:; form-action 'none'`).
Cards themselves load nothing, because no allowed tag, attribute or CSS value can name an external URL.

Light imports (parsers only, no browser or renderer) come from `@studix/renderers/html-card`. The main entry also
exports `lintHtmlCard(pkg, { width, height, durationMs, palette?, fonts?, workDir })`, which never throws.
It returns schema failures and allowlist problems as errors. Otherwise it builds a one-scene project from
the card in a temporary directory under `workDir` and runs the HyperFrames linter on it, which catches, for
example, font families that are not bundled. It reports tweens that run past the card end as warnings and
internal failures as errors. The result is `{ errors, warnings }` as agent-readable lines.

## Finish and deliveries (Implemented)

1. **Loudness.** The mix is normalised with a real two-pass `loudnorm`
   (`I=-14`, `TP=-2`, `LRA=11`, `linear=true`; loudnorm falls back to dynamic mode
   only when one static gain would break the peak target).
2. **Deliveries.** Each one encodes AAC through a true-peak-safe chain (18 kHz
   lowpass, limiter on a 4x-oversampled copy) and is measured again with a
   loudnorm analysis pass. A file outside **-14 LUFS ±1 / true peak ≤ -1.5 dBTP**
   is never returned: the limiter drive is raised at most three times (≤ 9 dB),
   then the render fails.

| Delivery  | File                          | When                              | Picture                                     | Audio                 |
| --------- | ----------------------------- | --------------------------------- | ------------------------------------------- | --------------------- |
| `master`  | `render-<preset>.mp4`         | always                            | captured H.264, stream-copied unless graded | AAC 192k, limiter 0.8 |
| `preview` | `render-<preset>.preview.mp4` | `final` preset by default         | long edge 640, CRF 30                       | master stream copied  |
| `phone`   | `render-<preset>.phone.mp4`   | `final` preset and IR `9:16` only | width ≤ 720, two-pass sized under 28 MiB    | AAC 128k, limiter 0.6 |

`RenderOutput.deliveries` lists every file with its probe and measured loudness;
`RenderOutput.filePath` stays the master. A silent render ships the master only,
without loudness.

**Grade** is optional and accepts named looks only (`warm`, `neutral`, `night`,
`dusk`, `ffmpeg/grade.ts`), never a raw filter string.

FFmpeg always runs with an argv array (no shell) and never overwrites silently.
The behaviour is verified on both FFmpeg 8.0 and the worker image's FFmpeg 5.1.

## HyperFrames version

`@hyperframes/core`, `@hyperframes/lint` and `@hyperframes/producer` are pinned
to the exact same version in `packages/renderers/package.json` (currently
`0.8.223`, Apache-2.0). Bump the three together and re-run the renderer tests
(`compile-composition.test.ts`, the two `*.integration.test.ts` files).

- **FFmpeg 7.1 / 8.0 and width 1080.** Before `0.8.223`
  ([heygen-com/hyperframes#5559](https://github.com/heygen-com/hyperframes/pull/5559))
  those FFmpeg versions blacked out the 8 rightmost pixel columns of an SDR MP4
  whose width is `16k+8`, and 1080 is one. A 1080x1920 or 1080x1080 master rendered
  on an FFmpeg 8 dev machine got a black edge that the stream-copy carried into the
  delivery. The worker image (FFmpeg 5.1) was never affected. Keep the pin at
  `0.8.223` or later.
- **Encode changes since `0.8.78`:** keyframe interval
  ([#6444](https://github.com/heygen-com/hyperframes/pull/6444)) and the `high`
  quality preset using x264 `fast`
  ([#6640](https://github.com/heygen-com/hyperframes/pull/6640)). Output bytes
  differ from older renders; the contract above (codec, size, loudness) does not.
- **Capture isolation patches.** `patches/@hyperframes__engine@0.8.223.patch`
  also adds `CAPTURE_NETWORK_ISOLATION_ARGS` to the Chrome flags. A proxy that
  does not exist (`socks5://127.0.0.1:9`) fails every routable request without
  a DIRECT fallback. Chrome skips proxies for loopback and link-local targets
  (including the `169.254.169.254` metadata address), so
  `--host-resolver-rules` fails every host name and IP literal except the name
  `localhost`, which the producer's file server uses
  (`http://localhost:<port>`). If upstream switches that URL to `127.0.0.1`,
  every capture breaks. WebRTC is limited to proxied UDP.
  `patches/@hyperframes__producer@0.8.223.patch` makes the producer ignore
  media that the page creates at runtime unless its source stays inside the
  project. The probe stage's `discoverMediaFromBrowser` is the only place that
  takes a media source from the browser. As a result, the engine never reads a
  host path or downloads a URL for it.
  `capture-isolation.integration.test.ts` renders a page that tries fetch,
  beacon, image, WebSocket, popup, iframe, WebRTC and runtime `<video>` sources
  (`..%2f`, `..%5c`, double encoding, `file:`, `http:`). A canary server must see
  nothing and the frame must stay black, while a project clip still renders
  ([#451](https://github.com/digitopvn/studix/issues/451)). The compile step
  runs in Node, where those flags do not apply, and matches URLs over the whole
  compiled HTML, user text included. The engine patch makes `downloadToTemp` and
  `fetchPublicHttpsText` throw `RemoteFetchDisabledError` before any request,
  which covers remote media, images, `background:url(…)`, remote `@font-face`
  sources, external stylesheets, media probing and the audio/video extractors.
  The producer patch stops `inlineExternalScripts` from fetching and
  `collectExternalAssets` from copying any path outside the project. It also
  gives `injectDeterministicFontFaces` (from `@hyperframes/core`) a fetch that
  always fails and turns off system font capture. Otherwise a `font-family`
  without `@font-face`, such as `Helvetica` in an HTML card, made the compiler
  ask Google Fonts with every character of the page, or embed a host font file.
  Compositions must reference project files only, which `compileComposition`
  already guarantees, and Studix fonts always come with `@font-face`. The same
  test file renders a composition whose title, text shot and caption carry
  `background:url(https://…)`, and HTML cards using `Helvetica` and `Lobster`,
  and checks that no download or non-loopback `fetch` happens with an empty font
  cache (`HYPERFRAMES_FONT_CACHE_DIR`). A raw page whose `<img>`, inline style and
  stylesheet point at a host file outside the project checks that the file never
  reaches the frame
  ([#457](https://github.com/digitopvn/studix/issues/457)). Both patches are
  keyed to the exact version, like the SIGTERM one below.
- **`handleSIGTERM` patch.** The engine launches Chrome through
  `ownedLaunchOptions()`, which leaves Puppeteer's `handleSIGTERM` at `true`,
  so a worker SIGTERM closed Chrome mid-render and lost the grace period.
  `patches/@hyperframes__engine@0.8.223.patch` (wired in
  `pnpm-workspace.yaml` → `patchedDependencies`) adds `handleSIGTERM: false`;
  the worker then aborts the render itself after the grace period and the
  producer closes Chrome. The patch is keyed to the exact version, so a bump
  must redo it (`pnpm patch @hyperframes/engine@<version>`, then
  `pnpm patch-commit`) or `pnpm install` fails. Drop it once upstream exposes a
  host switch for SIGTERM like `setHostHandlesSigint`.
- **Deadline budget.** `RenderOptions.deadlineAt` (the job deadline) becomes the
  producer's `maxRenderMs` for each capture, read when that capture starts.
  The producer then fails fast once its projected finish passes the deadline
  (after its calibration pass, or after about a minute of measured capture),
  and the renderer reports that as a non-retryable `TIMEOUT`. It is a second
  stop behind the job executor's deadline abort, aimed at a capture that hangs
  or crawls.

### Pending IR fields

The IR has no place yet for the finish choices, so they travel in the renderer's
own `FinishSpec` (`HyperFramesRendererOptions.finish` or the per-render
`finish` option). When the IR grows them, map them onto `FinishSpec`:

- `RenderSpec.grade?: "warm" | "neutral" | "night" | "dusk"`
- `RenderSpec.deliveries?: ("preview" | "phone")[]`

A music track with `duckDb` (-40..0) dips by that many dB while any `voiceover`
or `dialogue` clip plays: the gain ramps down over 150 ms before the speech and
back up over 350 ms after it, and speech gaps shorter than the two ramps are
bridged (`planAudioClips` / `audioMixGraph`). A music track without `duckDb`
keeps its own level. Looping a short bed would need an IR field.

`analyzeBeats` (`ffmpeg/beat-grid.ts`) finds the tempo, beats and downbeats of
an audio file locally: FFmpeg decodes it to mono PCM, an onset envelope is
autocorrelated over 70–180 BPM, and each beat is moved to its nearest onset.
Tempos above about 170 BPM come back at half speed. It returns undefined for
silence, files under 4 s and sound without a clear pulse.

## Pinned browser build

The worker image (amd64 and arm64) and CI install the same
`chrome-headless-shell` build, `156.0.8078.80`, set once as
`ARG CHROME_HEADLESS_SHELL_VERSION` in the root
`Dockerfile`; CI reads that line. An unpinned `@stable` let pixels, golden tests
and the WebGL measurements below change between builds with no code change.

Why `156.0.8078.80`: it is the build the WebGL table below was measured on, so
pinning it invalidates no measurement. `@hyperframes/engine@0.8.223` manages its
own Chrome at `152.0.7977.30`; moving to that build would mean re-measuring the
table and is a decision for the film-engine work (#47). To change the build, edit
the `ARG`, re-run the measurement, and update this section.

Chrome for Testing publishes `chrome-headless-shell` for `linux-arm64` from build
153, so the arm64 image (local Apple Silicon) installs the same build id instead
of Debian's `chromium`. Installing it needs `@puppeteer/browsers` 3.2.0 or later;
older releases resolve arm64 to the x64 archive. Same build id does not mean same
pixels: do not compare pixels or timings across architectures.

Check: two builds of the image print the same `chrome --version`; the build
already runs it as its last browser step.

## WebGL in headless Chromium without a GPU

Measured for the film-engine port (#47): can the worker draw WebGL scenes on CPU?

- **Image and browser:** the worker image built from the root `Dockerfile`
  (Debian bookworm, `chrome-headless-shell` 156.0.8078.80), no GPU, launched with
  `--use-angle=swiftshader --enable-unsafe-swiftshader`. WebGL reports
  `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)`.
- **Scene:** WebGL2 multiplane, six full-frame mip-mapped RGBA image layers with
  per-layer parallax pan and zoom, alpha-blended, seeked frame by frame.
- **Measure:** _draw_ is one frame drawn and finished in the page (`readPixels`
  forces completion); _draw + capture_ adds a JPEG screenshot round trip through
  CDP, the way a frame-by-frame capture works. 90 frames after 5 warm-up frames.
- **Host:** Intel i7-14700K, Docker Desktop on WSL2.

| Frame size | Container limit | Draw p50 / p95 (ms) | Draw + capture p50 / p95 (ms) |
| ---------- | --------------- | ------------------- | ----------------------------- |
| 540x960    | 4 CPU, 4 GB     | 7.8 / 10.3          | 49.9 / 52.9                   |
| 1080x1920  | 4 CPU, 4 GB     | 57.5 / 122.8        | 100.4 / 183.4                 |
| 540x960    | none (28 CPU)   | 11.2 / 19.4         | 53 / 69.4                     |
| 1080x1920  | none (28 CPU)   | 29.5 / 32.7         | 76.7 / 85.3                   |

Reading: SwiftShader works in the worker image without a GPU. A six-layer
multiplane frame at 1080x1920 costs about 60 ms of draw on 4 CPUs, so a 10 s,
30 fps shot (300 frames) needs roughly 30 s of capture on one browser, before
encoding. Capture, not drawing, dominates at preview size. Fill rate scales with
CPU count, so full-HD film-engine renders want more cores per worker or parallel
capture workers.
