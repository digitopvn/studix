---
name: ak-video
description: "Create marketing video scripts, storyboards, rendered videos and platform repurposing at the requested stage, using an available provider."
when_to_use: "Invoke for video marketing; thumbnails are a separate deliverable."
category: media
keywords: [video, script, storyboard, production, marketing]
argument-hint: "[create|script-create|storyboard-create] [topic]"
metadata:
  author: agentkit
  version: "1.0.3"
---

# Video

Video production, scripts, storyboards, and AI video generation.

<args>$ARGUMENTS</args>

## When to Use

- Video script writing with creative direction
- Storyboard creation for video content
- Video rendering with an available authorized generation or production capability
- Video optimization for platforms
- Requested thumbnail design through an available thumbnail owner
- Video SEO optimization

For a beat-synced HyperFrames motion-graphic with voice-over, captions and
music, use `ak-motion-video`. To write, direct, or synthesize the voice-over
itself with ElevenLabs, use `ak-elevenlabs`.

## Subcommands

| Subcommand | Description | Reference |
|------------|-------------|-----------|
| `create` | Render a video through an available production capability | `references/create.md` |
| `script-create` | Create production-ready video script | `references/script-create.md` |
| `storyboard-create` | Create storyboard for video content | `references/storyboard-create.md` |

## References (Knowledge Base)

| Topic | File |
|-------|------|
| Production Workflow | `references/production-workflow.md` |
| Video Types & Specs | `references/video-types-specs.md` |
| Script Templates | `references/script-templates.md` |
| Storyboard Format | `references/storyboard-format.md` |
| Thumbnail Design | `references/thumbnail-design-guide.md` |
| Art Directions | `references/video-art-directions.md` |
| Audio Directives | `references/audio-directive-guide.md` |
| Veo Prompt Guide | `references/veo-prompt-guide.md` |
| Video Optimization | `references/video-optimization.md` |
| Video SEO | `references/video-seo-optimization.md` |
| Quality Review | `references/quality-review-workflow.md` |

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/generate-video.cjs` | AI video generation |
| `scripts/create-storyboard.cjs` | Storyboard generation |
| `scripts/analyze-video.cjs` | Video analysis |
| `scripts/extract-captions.cjs` | Caption extraction |
| `scripts/optimize-for-platform.cjs` | Platform optimization |

## Templates

| Template | Purpose |
|----------|---------|
| `templates/explainer.json` | Explainer video template |
| `templates/product-demo.json` | Product demo template |
| `templates/short-form.json` | Short-form video template |
| `templates/testimonial.json` | Testimonial video template |

## Routing

1. Resolve script, storyboard, render, or repurpose intent. Reuse approved inputs and brand context.
2. Load only the corresponding subcommand reference; repurposing uses production/optimization guidance for the supplied video. A script request does not call a video API.
3. Discover the installed generation/media owner for current provider/model syntax and real access. Create thumbnails only when requested.
4. Complete with the actual requested artifact: distinguish script and storyboard from a rendered video. For video, inspect duration, dimensions, audio, captions when requested, and representative frames; do not claim a render from a plan or missing file.
