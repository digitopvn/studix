---
name: ak-youtube
description: "Convert YouTube videos into blog posts, infographics and social content via the VidCap.xyz API: captions, transcripts, summaries and comment analysis."
when_to_use: "Invoke when a YouTube URL should be repurposed."
category: media
keywords: [youtube, transcript, blog, infographic, social]
argument-hint: "[blog|infographic|social] [youtube-url]"
metadata:
  author: agentkit
  version: "1.0.1"
---

# YouTube

YouTube video content repurposing and VidCap.xyz API integration.

<args>$ARGUMENTS</args>

## When to Use

- Convert YouTube videos to blog posts, infographics, social content
- Download video/audio from YouTube
- Extract captions and transcripts
- Generate AI summaries of video content
- Analyze video comments

## Subcommands

| Subcommand | Description | Reference |
|------------|-------------|-----------|
| `blog` | Convert YouTube video to SEO-optimized blog post | `references/blog.md` |
| `infographic` | Convert YouTube video to visual infographic | `references/infographic.md` |
| `social` | Convert YouTube video to multi-platform social posts | `references/social.md` |

## References (Knowledge Base)

| Topic | File |
|-------|------|
| VidCap Content API | `references/api-content.md` |
| VidCap Media API | `references/api-media.md` |

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/vidcap.py` | VidCap.xyz API client (download, captions, summaries) |
| `scripts/test_vidcap.py` | VidCap API test suite |

## Routing

1. Resolve extraction (info/captions/comments/media) versus transformation (blog/infographic/social) intent. Reuse an existing transcript only when video ID, language, and version match.
2. For extraction, load the applicable API content/media reference; for transformation, load only the matching subcommand reference. Verify API readback before claiming content was obtained.
3. Preserve video URL/ID, language, capture date/version, timestamps, and whether captions are automatic or incomplete. No transcript or failed readback means an evidence gap, not a license to invent a summary.
4. Transform only supported content, distinguishing source statements from added context; link quotes and claims to timestamps. Download media only when the requested deliverable needs it.
