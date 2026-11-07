# Shot tiers, model routing and money

Cost and quality are decided per shot, before anything is bought. The rule of thumb from three films: code
for everything a camera, light or particle can do; a still for every held pose; AI video only where a body
or a face must act; at most one expensive sakuga shot per scene.

## Tiers

| Tier | What it is | Cash | Share of runtime | Use for |
|---|---|---|---|---|
| T0 | Code only: GL multiplane set, weather, light FX, title, transitions | $0 | 40-50% | establishing, flybys, petal/snow storms, flashes, impact frames, title cards |
| T1 | One Nano Banana still + code motion (cel push, glints, parallax) | $0.03-0.15 | 20-30% | reaction holds, eye close-ups with sparkle, poses at the peak of an action |
| T2 | Omni first/last-frame insert, 3s minimum, trimmed to the beat | ~$0.30 per 3s at 720p | 4-6 shots per 15s | face acting with lip-synced speech, hair and cloth secondary motion, a short swing |
| T3 | Seedance (or a long Omni) sakuga shot | $0.4-1.2 | one per scene by default; every big-action shot in an action-heavy episode once the user approves | the full-body exchange the scene is about; chases, crashes, fights |

A 15s scene at this mix lands at $2.6-3.4 cash; the measured xianxia film was $3.80 including design,
tests and waste. `generate-media-via-multix.py` refuses a second Seedance shot in one scene unless
`--allow-seedance` is passed. FRONTIER ep03 passed it for 16 action shots after the user compared them with
local H3 and chose Seedance; at the reseller's 480p price ($0.42 per 4 s) that cost $10.08.

### Deciding the tier of a shot

- Does a body need to move in a way a still cannot fake (turn, swing with follow-through, fall, catch)? T2;
  T3 only if it is the scene's signature and longer than ~2s.
- Does a face need to talk or change emotion? T2 (Omni lip-syncs its own speech).
- Is it a held pose, a look, a reaction? T1 with a slow push and FX.
- Is the camera the actor (flyby, crane, storm)? T0.
- When over the ceiling, drop the costliest shot one tier and cover it with cutting (shorter insert, a cel
  at the peak, an impact frame) before cutting a beat.

### Dialogue scenes need their own mix

The 15 s tier mix above is for action. FRONTIER cut 1 was mostly held cels with a few clips, cost $11.40 for
5:58, and the user rejected it as static, far from the Netflix/ufotable bar. For dialogue and emotion:

- Dialogue and emotion shots default to Omni (it acts the line; see `audio-voice-and-mix.md`, "Dialogue on
  screen"). Physical action (falls, stomps, runs, spit-takes) goes to H3.
- At least 60% of a dialogue scene's runtime is motion (Omni or H3).
- No cel holds longer than about 1.5 s as a static frame: give it a push plus handheld, or replace it with
  motion. `qa-prescan.py picture` flags static holds.
- Quote the budget from that mix: the Omni-heavy cut 2 came to about $41.7 against cut 1's $11.40.

## Roles, not engines

The pipeline needs roles, and any engine that fills a role can be used. The table below and the scripts were
measured with one set of engines (FRONTIER, one 16 GB GPU, Atlas through multix); another user may have a
different GPU, no local GPU, or other API accounts.

| Role | What it does | Scripts that use it | Tested adapters (measured) |
|---|---|---|---|
| `i2v-cloud` | paid image-to-video, fast and parallel | `generate-media-via-multix.py` (routed per job by `gen-plan.json` and `price-table.json`) | Omni $0.099/s 720p; H3 $0.13/s 720p, about $0.32 per 4 s at 768p; Seedance $0.30/s 720p on Atlas, $0.105/s 480p through a reseller |
| `i2v-local` | image-to-video on a local GPU, free per clip, bounded by VRAM | `generate-video-via-comfyui.py` | MiniMax H3 (ComfyUI) median 301 s for a 4 s take at 1344x768, 88% of 112 shots accepted; LTX-2.5 (ComfyUI) 80-145 s, about 15.7 GB peak, rejected for acting |
| `tts` | speech for every line | gen-plan `tts` jobs; any provider's takes go through `gate-tts-takes.py` | Gemini 3.8 Flash TTS about $0.0009/call billed; ElevenLabs v3 |
| `asr` | transcribe a take or a clip | `gate-tts-takes.py` | ElevenLabs Scribe; seed-asr (template) |
| `upscaler` | 720p to 1080p, frame-exact | `upscale-finished-scenes.py`, gen-plan `upscale` jobs | BytePlus standard $0.0069/s; any local upscaler CLI (template) |
| `ai-judge` | multimodal model returning JSON findings on a clip | `ai-shot-qa.py` | Gemini analyze |
| `audio-aesthetic` | learned quality score of an asset | regression gate only | Audiobox Aesthetics (untested) |

The routing table is `assets/templates/engines.json`. A series overrides it with `<series>/engines.json`,
merged per role and per adapter, and every script that uses a role takes `--engine <adapter>`. To add an
engine, add an adapter of a kind the scripts already run:

- `cli`: any command; `cmd` is an argv list with the role's `{placeholders}`, `output` says where the result
  is (`stdout`, `stdout-json`, or the file `{out}`).
- `comfyui`: an API-format workflow in `assets/comfyui-workflows/` that carries `_slots` (which node input
  takes the prompt, image, size, length, seed...), `_lora` (the model node and every sampler a style LoRA
  must feed) and `_save` (how to force a CRF). Export the workflow with "Save (API)", replace the loaders'
  file names with neutral ones, then list the slots.
- `atlas-async`: a multix Atlas model with upload, submit and fetch.

Only a new kind needs code. Record `status` (`chosen`, `rejected`, `untested`, `template`) and what you
measured in the adapter, so the next run starts from numbers instead of claims.

### Comparing a new engine against the current one

1. Same keyframe, prompt, seed and length on both; one job at a time on a local GPU.
2. Measure wall time and peak VRAM (`generate-video-via-comfyui.py` writes both to the sidecar) and the
   cash per second of footage.
3. For anime, give a general video model a style LoRA, on every stage of a multi-stage workflow; without
   it LTX-2.5 drifted to a semi-realistic look.
4. Re-encode at a low CRF (`--crf 12`) before judging faces: a ~2.8 Mbps default encode smeared small faces
   on its own and made the model look worse than it was.
5. Put the takes in one labelled grid (`make-review-tiles.py`, `--crop face` for faces) and let the user
   judge acting and blocking. LTX-2.5 was about 3x faster than H3 on the same GPU and the user still
   rejected it: its acting and camera control did not reach H3's; speed does not decide it.

## Model routing (measured on Atlas through multix unless noted)

| Task | Model | Measured price | Notes |
|---|---|---|---|
| Model sheet, set frame, keyframe | `google/nano-banana-2.1-developer/edit` (`/text-to-image` without refs) | $0.026-0.028 per 2K image | same model as the standard tier at about a third of its $0.075 |
| Set layers for multiplane | `bytedance/seedream-v5.0-pro/layer-decomposition` | $0.324 | catalog said $0.018; returns base + layers with z_index, bbox, alpha |
| Face/body acting insert | `google/gemini-omni-1.1-flash/image-to-video` | $0.099/s at 720p, $0.0387/s at 360p, 3s minimum | image + last_image, seed, native audio; catalog said $0.039/s |
| Physical action insert | `minimax/h3/image-to-video` | $0.13/s at 720p ($0.52 for 4 s, $0.78 for 6 s; blind A/B 2026-10-27) | 4 s minimum (shorter fails with only "next: multix atlas run --help"); `end_image`; expect an end-frame snap |
| Sakuga shot | `bytedance/seedance-2.5/image-to-video` | $0.30/s at 720p | catalog said $0.134/s; 4s = $1.21, 45% of one film's video budget |
| Blockout-guided action shot | `bytedance/seedance-2.0-mini/reference-to-video` (Kling 4.0 ref2v for polish) | $0.58 per 5 s 720p (Kling $0.87) | follows a 3D blockout video's cuts and camera; see keyframes-and-ai-video.md |
| Upscale to 1080p | `byteplus/video/upscaler`, `tool_version` standard | $0.0069/s at 1080p24 | professional tier is 10x for a near-identical result |
| SFX, music, isolate, align, voice changer | ElevenLabs direct via `multix elevenlabs` | credits (~$0.30 per 1k assumed) | 696 credits for a 15.7s film; Atlas offers only TTS |
| TTS (series voice) | `gemini-3.8-flash-tts` | about $0.005 per call | FRONTIER's voice for every character; 306 takes cost $2.86 |
| TTS | ElevenLabs `eleven_v3` (direct) or `elevenlabs/v3/text-to-speech` (Atlas, $0.10 catalog) | | language code + seed |
| Forced alignment | ElevenLabs align | about $0.005 per call | word timings for karaoke and placement |
| Transcription | seed-asr via `multix atlas audio` | ~$0.0001 | checking what Omni actually said |
| Video/film QA | `multix gemini analyze` | negligible | hints only, see grade-master-and-qa.md |

Untested alternatives worth an A/B when a run has room: `fal-ai/topaz/upscale/video` ($0.02/s at 1080p,
doubled above 30fps), `atlascloud/video-upscaler` ($0.018/s, 5s minimum), `minimax/music-3.0` ($0.15),
`suno/chirp-v6` ($0.132), `veed/lipsync` ($0.012/s), `sync/lipsync-v3` ($0.22).

Codex (ChatGPT plan) can draw sheets and poses at no per-image price, about 2.5 minutes per image; use it
when the user prefers plan quota to cash (see keyframes-and-ai-video.md).

## Price traps

Catalog prices were wrong by up to 18x. The only true price is the billed `data.price` of a finished
prediction, which `anime-studio.py ledger <episode>` reads back for every id in `logs/predictions.log`.

- `assets/templates/price-table.json` marks each item `basis: measured | catalog | assumed`.
- The runner sends only one job of a model whose basis is not `measured` (calls under $0.05 excepted) and
  holds the rest until the price is read. After the probe: run `ledger`, update the table to `measured`,
  rerun with `--probe-ok` if the price still fits.
- Write measured prices back into the price table with the date in `source`, so the next run starts honest.

## Budget arithmetic

- `anime-studio.py budget <episode>` estimates every job of gen-plan.json (minimum units applied, takes
  counted), adds measured spend and prints headroom against the ceiling and video utilization (seconds used
  in the edit / seconds paid). Utilization below 50% means buying footage the film does not use; plan
  shorter clips or cut one clip into two shots.
- Omni bills 3s minimum: one 4s clip that contains two usable beats (Omni often cuts by itself mid-clip) is
  cheaper than two 3s clips.
- 360p previz with a fixed seed reproduces the first ~1.5s of the 720p motion closely; use it to choose
  which shots to buy at 720p when the plan has more than four T2 shots.
- 48fps doubles render time and the upscaler's fps factor. Masters are 24fps unless the user asked; the
  48fps samurai run cost $7.04 for 16.8s, the 24fps xianxia run $3.80 for 15.7s.

## Pre-spend checklist

1. Scope approved (G0) and designs approved (G1).
2. Every shot has a tier, every paid job is in gen-plan.json with units, variant and takes.
3. `budget` shows no unknown prices and positive headroom including one retake per T2 shot.
4. A tiny probe proved the network path and output download for each new provider (an unreachable
   download host once cost a paid job).
5. `preflight` shows disk and load can take the next phase.
