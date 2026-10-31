# Renderer

`@studix/renderers` implements the `RendererAdapter` port
([ADR 0010](decisions/0010-renderer-and-media-provider-adapters.md)):
HyperFrames composes and captures the picture in headless Chromium, FFmpeg mixes
the sound and finishes the deliveries. The code is the reference; this page
records the contract and the measurements behind it.

## What renders (Implemented)

| IR element                         | How                                                                                                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title, text, image shots, captions | HTML + GSAP timeline per scene (`hyperframes/scene-composition.ts`, `shot-markup.ts`)                                                                                |
| Video shot, video background       | Muted `<video>` with scene-local `data-start` / `data-media-start` (`trimStartMs`); HyperFrames extracts the frames with FFmpeg and injects them                     |
| Audio tracks (all kinds)           | Mixed by FFmpeg, never by the browser: trim, `volume` x `gainDb`, `fadeInMs` / `fadeOutMs`, delay to `startMs`, summed without normalisation (`ffmpeg/audio-mix.ts`) |
| Sound of an unmuted video shot     | Joins the mix at the shot's absolute time, clamped to the shot window                                                                                                |

Media types: images `png/jpeg/webp/gif/avif/svg`, video `mp4/webm/mov`, audio any
`audio/*` FFmpeg decodes. `hyperframesSupport()` reports anything else instead of
dropping it.

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

### Pending IR fields

The IR has no place yet for the finish choices, so they travel in the renderer's
own `FinishSpec` (`HyperFramesRendererOptions.finish` or the per-render
`finish` option). When the IR grows them, map them onto `FinishSpec`:

- `RenderSpec.grade?: "warm" | "neutral" | "night" | "dusk"`
- `RenderSpec.deliveries?: ("preview" | "phone")[]`

Music is not ducked under `dialogue` / `voiceover` yet; the IR allows it but the
mix sums tracks at their own levels. Looping a short bed would need an IR field.

## Pinned browser build

The worker image (amd64) and CI install the same `chrome-headless-shell` build,
`156.0.8078.80`, set once as `ARG CHROME_HEADLESS_SHELL_VERSION` in the root
`Dockerfile`; CI reads that line. An unpinned `@stable` let pixels, golden tests
and the WebGL measurements below change between builds with no code change.

Why `156.0.8078.80`: it is the build the WebGL table below was measured on, so
pinning it invalidates no measurement. `@hyperframes/engine@0.8.223` manages its
own Chrome at `152.0.7977.30`; moving to that build would mean re-measuring the
table and is a decision for the film-engine work (#47). To change the build, edit
the `ARG`, re-run the measurement, and update this section.

The arm64 image (local Apple Silicon) uses Debian's `chromium` package, which is
not deterministic: its version follows the Debian archive. Do not compare pixels
or timings across architectures.

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
