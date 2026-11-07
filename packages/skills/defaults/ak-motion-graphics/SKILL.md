---
name: ak-motion-graphics
description: "Route motion, animation or video work to an installed workflow, verify rendered artifacts, and propose template packs only when nothing covers it."
when_to_use: "Invoke when unsure which skill should build the request."
category: media
keywords: [motion-graphics, animation, video, routing, packs]
license: Proprietary; includes MIT-licensed third-party material, see LICENSE.txt
argument-hint: "[intent-or-pack] [--list|--propose <pack>|--verify <file>]"
metadata:
  author: agentkit
  version: "1.0.1"
  upstream: iart-ai/motion-skills
  upstream_ref: master@945c4c7
  upstream_license: MIT
---

# Motion Graphics

Router + verify-loop toolkit for motion / animation / video work. This skill
does **not** reimplement any motion skill. It:

1. Prefers in-repo skills that already cover the request.
2. When the request needs a template outside their scope, **proposes** the
   matching pack from the external MIT-licensed
   [iart-ai/motion-skills](https://github.com/iart-ai/motion-skills) family and
   waits for the user to run the install command.
3. Ships the upstream deliver-and-verify shell helpers under `scripts/` so any
   rendered artifact — from an in-repo skill or an external pack — can be
   inspected with the same freeze-frame / contact-sheet / probe-MP4 loop.

<args>$ARGUMENTS</args>

## Route in this order

### 1) In-repo skills first

**Prefer when installed; fall through when absent.** The `Kit` column marks
each row's origin. On a marketing-only install `overrides.skills` replaces the
inherited list per the [kit-yaml spec](../../../../docs/specs/kit-yaml-spec.md),
so `core`-marked rows are not automatically available — treat them as
opportunistic routes, not guarantees. Confirm the target skill is discoverable
in the current installation before routing to it (Claude Code `/skills`,
`ak skills list`, or the runtime's skill catalog). Any row whose target is not
installed skips to the next matching row, and only if no row lands does the
request fall through to step 2.

| Request shape | Skill | Kit |
|---|---|---|
| Programmatic video, Remotion (React), data-driven video | `ak-remotion` | core |
| Beat-synced launch/explainer motion-graphic with voice-over, captions, SFX and music (HyperFrames + GSAP) | `ak-motion-video` | marketing |
| HTML/CSS/JS → local MP4 (HeyGen HyperFrames CLI; nexu-io/html-video templates via its reference) | `ak-hyperframes` | core |
| Veo generation, video scripts, storyboards, thumbnails | `ak-video` | marketing |
| GLSL shaders, procedural graphics | `ak-shader` | core |
| Three.js / WebGL / WebGPU / GLTF | `ak-threejs` | core |
| FFmpeg / ImageMagick encode, filter, batch | `ak-media-processing` | core |
| Mermaid diagrams (static, not motion) | `ak-mermaidjs-v11` | marketing |

Only fall through to step 2 when the request needs a template the available
in-repo skills do not carry.

### 2) External pack (propose, do not auto-install)

When the request needs one of the specific templates the packs specialize in
(vertical hook-beat, ad hook/body/CTA variants, chart animation with real
numbers, kinetic type, editorial map, Manim scene, generative illustration…):

1. Look up the pack in `references/packs.md` by trigger phrase.
2. **Print** the install command the user should run:

   ```bash
   npx skills add iart-ai/<pack>
   # or, for Claude Code plugin delivery:
   /plugin marketplace add iart-ai/<pack>
   ```

3. Explain in one sentence what the pack ships and why it fits.
4. Wait for the user's explicit go-ahead before executing anything. Third-party
   skill packs are user-installed, never auto-installed. Never run the install
   command on your own initiative, even when the user's intent seems to imply it.
5. After installation, verify that the current runtime actually discovers the selected skill before routing.

Read `references/packs.md` only after native/installed routes are insufficient, or for `--list`/`--propose`. Select by the required template and explain overlap when relevant. A keyword such as TikTok alone is not a reason to install a pack.

### 3) Verify what actually rendered

Reuse the destination skill's render and inspection evidence when it covers
the requested artifact and current file. Run these helpers only for missing
checks or an explicit `--verify` request. Short form:

**Light tier** (standalone HTML with a `?t=N` seek harness — the convention
web-animation and kinetic-typography packs follow):

```bash
scripts/seek-shot.sh anim.html 0 1.5 3
scripts/contact-sheet.sh sheet.png frame-*.png
```

**Heavy tier** (Remotion / Manim / HyperFrames / any encoded MP4):

```bash
scripts/probe-mp4.sh out/short.mp4 1080x1920 30
```

The MP4 probe reads real width × height / codec / fps / duration straight from
the file with `ffprobe`. It fails loud when the render lies. See
`references/verify-loop.md` for tier selection, real dep list, and per-format
invocations.

## Subcommands

| Subcommand | Behavior | Reference |
|---|---|---|
| `--list` | Print the 15 packs, their audiences, trigger phrases, and install commands | `references/packs.md` |
| `--propose <pack>` | Print the `npx skills add iart-ai/<pack>` command with a one-line rationale; do not execute | (external) |
| `--verify <file>` | Route the file to the right verify helper (`.mp4` → `probe-mp4`, `.html` → `seek-shot` + `contact-sheet`) | `references/verify-loop.md` |
| _(default, no subcommand)_ | Run the "Route in this order" flow above on `$ARGUMENTS` | This file |

## Compose with

Same availability rule as step 1: each item is opportunistic — skip it when
the target skill is not installed.

- `ak-copywriting` — hook line, CTA, on-screen copy. _(core; skip if absent)_
- `ak-brand`, `ak-logo-design`, `ak-design-system` — brand tokens the motion
  templates need. _(marketing)_
- `ak-video script-create` — the extended script when the beat isn't enough.
  _(marketing)_
- `ak-elevenlabs` — voice-over audio. _(marketing)_
- `ak-youtube-thumbnail-design` — thumbnail beside the YouTube pack.
  _(marketing)_
- `ak-paid-ads`, `ak-ads-management` — spend and placement around the creative
  the ad pack produces. _(marketing)_

## Attribution

- Upstream hub: [iart-ai/motion-skills](https://github.com/iart-ai/motion-skills) — MIT.
- The three POSIX scripts under `scripts/` are copied verbatim from upstream
  `tools/verify/` (`master` branch, commit `945c4c7`); each carries an
  origin / license header. Full MIT text and copyright notice: `LICENSE.txt`.
- Showcase artifact (`showcase.gif`, `showcase.html`) is not vendored — view
  it on the upstream README.
- Built by [iart.ai](https://iart.ai) — the AI motion agent.
