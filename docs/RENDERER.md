# Renderer

`@studix/renderers` implements the `RendererAdapter` port
([ADR 0010](decisions/0010-renderer-and-media-provider-adapters.md)):
HyperFrames composes and captures the picture in headless Chromium, FFmpeg mixes
the sound and finishes the deliveries. The code is the reference; this page
records the contract and the measurements behind it.

## What renders (Implemented)

| IR element                         | How                                                                                                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title, text, image shots, captions | HTML + GSAP timeline per scene (`hyperframes/scene-composition.ts`, `shot-markup.ts`)                                                                                            |
| Video shot, video background       | Muted `<video>` with scene-local `data-start` / `data-media-start` (`trimStartMs`); HyperFrames extracts the frames with FFmpeg and injects them                                 |
| Audio tracks (all kinds)           | Mixed by FFmpeg, never by the browser: trim, `volume` x `gainDb`, `fadeInMs` / `fadeOutMs`, delay to `startMs`, summed without normalisation (`ffmpeg/audio-mix.ts`)             |
| Sound of an unmuted video shot     | Joins the mix at the shot's absolute time, clamped to the shot window                                                                                                            |
| Composition shot (film scene)      | Captured first by the ported film engine (`film-engine/film-composition-render.ts`), each scene as its own HyperFrames root composition, then spliced back as a muted video shot |

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

Music is not ducked under `dialogue` / `voiceover` yet; the IR allows it but the
mix sums tracks at their own levels. Looping a short bed would need an IR field.

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
