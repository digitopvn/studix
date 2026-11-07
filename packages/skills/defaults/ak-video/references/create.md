Render the requested video, reusing an approved script or storyboard. Resolve an installed generation owner for provider/model selection and syntax; the Veo/CLI examples below describe one pipeline, not universal runtime access. Use the supported production path that satisfies the brief.

## Your Brief

<args>$ARGUMENTS</args>

## Resources by Production Need

1. **Read the relevant video production guidance**
   - Load:
     - `references/production-workflow.md`
     - `references/storyboard-format.md`
     - `references/veo-prompt-guide.md`
     - `references/video-art-directions.md`
2. **Discover creative-direction guidance only for an unresolved direction**
   - Load for style templates, color psychology, voiceover styles, audio/music trends
3. **Resolve an installed generation capability**
   - Use for Nano Banana Flash / Veo 3.1 generation and review gates.
4. **Resolve media processing when assembly/export is needed**
   - Use for FFmpeg assembly + platform exports.
5. **Resolve the requested/project output path**
   - Use for standardized output paths and naming conventions.

## Parse Input

- If `$ARGUMENTS` is a file path:
  - If it looks like a **script** (e.g. `content/video/.../script.md`) â†’ start at **Script**.
  - If it looks like a **storyboard** (e.g. `assets/storyboards/.../storyboard.md|storyboard.json`) â†’ start at **Storyboard**.
- Otherwise treat `$ARGUMENTS` as a **text prompt** describing the video concept.

## Required Inputs (ask if missing)

- **Platform**: `youtube` (16:9) | `tiktok` (9:16) | `reels` (9:16) | `youtube-shorts` (9:16) | `instagram` (1:1) | `linkedin` (16:9)
- **Goal**: what should the viewer do/think/feel?
- **Audience**: who is this for?
- **CTA**: what action should the viewer take?

If the user provides only a prompt, infer defaults and ask only for missing items that materially change the video.

## Workflow

### Step 0: Preflight

1. Verify the selected provider's credentials and authorized generation scope without exposing secrets.
2. Check dependencies and model support through that installed capability; do not assume this example provider.
3. Confirm `ffmpeg` is installed if you will export platform versions.
4. Determine:
   - **Slug** (kebab-case)
   - **Output platform** and **aspect ratio**
5. Create output directories:
   - `assets/videos/{date}-{slug}/`
   - `assets/storyboards/{date}-{slug}/`

### Step 1: Script (if starting from prompt)

If the input is a prompt (not a script file):

1. Execute:

```text
/video:script:create {type} "{prompt}"
```

2. Use the generated script output:
   - `content/video/{type}/{date}-{slug}/script.md`

### Step 2: Storyboard (if starting from prompt or script)

If the input is a prompt or a script (not a storyboard yet):

1. Execute:

```text
/video:storyboard:create {script-file-or-prompt}
```

Recommended handoff (when Step 1 was used):

```text
/video:storyboard:create content/video/{type}/{date}-{slug}/script.md
```

2. Use the generated storyboard output:
   - `assets/storyboards/{date}-{slug}/storyboard.md`
   - `assets/storyboards/{date}-{slug}/storyboard.json`

### Step 3: Generate START/END frames (Nano Banana Flash) + Review Gate

This step is handled by `/video:storyboard:create ...`.

Confirm the storyboard directory contains:
- `scene-{N}-start.png`
- `scene-{N}-end.png`

### Step 4: Generate Audio (Voiceover + Music) + Review Gates

Generate audio assets based on script/storyboard `audio` directives. This step can run in parallel with Step 5 (video clips). Each audio asset must pass review before proceeding.

#### 4a: Generate Voiceover (if script has narration)

Extract voiceover text from each scene and generate with Gemini TTS:

```bash
npx -y -p @mrgoonie/multix@0.2.0 multix gemini generate-speech \
  --model gemini-2.5-flash-preview-tts \
  --voice "Charon" \
  --prompt "Audio Profile: Professional narrator. Director's Notes: Clear, measured pace. Transcript: {voiceover_text}" \
  --output "assets/videos/{date}-{slug}/voiceover-scene-01.wav"
```

Resolve supported voices from the chosen generation capability; the command above is an illustrative provider-specific example.

**Review Gate**: Analyze voiceover and regenerate up to **2** times if it fails:

```bash
npx -y -p @mrgoonie/multix@0.2.0 multix gemini analyze \
  --files "assets/videos/{date}-{slug}/voiceover-scene-01.wav" \
  --prompt "Review this voiceover for video narration. Check:
    1. Speech clarity (1-10) - words clearly pronounced?
    2. Pacing (1-10) - appropriate speed for video duration?
    3. Tone match (1-10) - matches requested style?
    4. Audio quality (1-10) - no artifacts, distortion, clipping?
    5. Timing - approximate duration in seconds?
    Return JSON: {passed: bool, scores: {...}, issues: [...], suggestions: [...]}"
```

Pass criteria: All scores >= 7, no critical issues.

Reference: `${CLAUDE_PLUGIN_ROOT}/skills/ak-video/references/audio-directive-guide.md`

#### 4b: Generate Background Music (Lyria)

Generate background music matching video mood and duration:

```bash
npx -y -p @mrgoonie/multix@0.2.0 multix minimax generate-music \
  --lyrics "Instrumental underscore for {video title}" \
  --prompt "{mood} background music for video; non-distracting underscore; target duration {total_video_seconds}s" \
  --model music-2.5 \
  --output-format wav \
  --output "assets/videos/{date}-{slug}/music.wav"
```

Mood presets from storyboard:
- **Corporate/Product Demo**: `bpm: 100, brightness: 0.6, density: 0.4`
- **Social Media/TikTok**: `bpm: 128, brightness: 0.7, density: 0.7`
- **Testimonial/Emotional**: `bpm: 70, brightness: 0.4, density: 0.3`

**Review Gate**: Analyze music and regenerate up to **2** times if it fails:

```bash
npx -y -p @mrgoonie/multix@0.2.0 multix gemini analyze \
  --files "assets/videos/{date}-{slug}/music.wav" \
  --prompt "Review this background music for video. Check:
    1. Mood match (1-10) - matches requested style/mood?
    2. Energy level (1-10) - appropriate for video type?
    3. Production quality (1-10) - clean, no artifacts?
    4. Loop-ability (1-10) - smooth transitions, no jarring endings?
    5. Background suitability (1-10) - non-distracting, supports content?
    6. Duration - matches expected video length?
    Return JSON: {passed: bool, scores: {...}, issues: [...], suggestions: [...]}"
```

Pass criteria: All scores >= 7, duration within 10% of target.

Reference: `${CLAUDE_PLUGIN_ROOT}/skills/ak-ai-multimodal/references/music-generation.md`

### Step 5: Generate Veo clips (image-to-video) + Review Gate

For each scene:

1. Generate a Veo clip using the sceneâ€™s motion/camera directive and reference frames:
   - `assets/videos/{date}-{slug}/scene-{NN}.mp4`
2. Review the clip using Gemini video understanding and regenerate up to **2** times if it fails:
   - Motion smoothness
   - Temporal consistency (no object drift/morphing)
   - Start/end frames match

Recommended CLI pattern (repeat per scene):

```bash
npx -y -p @mrgoonie/multix@0.2.0 multix gemini generate-video \
  --model veo-3.1-generate-preview \
  --aspect-ratio "{16:9|9:16|1:1}" \
  --resolution "1080p" \
  --reference-images \
    "assets/storyboards/{date}-{slug}/scene-01-start.png" \
    "assets/storyboards/{date}-{slug}/scene-01-end.png" \
  --prompt "{veo prompt: style + camera + motion + constraints}" \
  --output "assets/videos/{date}-{slug}/scene-01.mp4"
```

Optional quality review (recommended):

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/ak-video/scripts/analyze-video.cjs \
  --video "assets/videos/{date}-{slug}/scene-01.mp4" \
  --format markdown \
  --output "assets/videos/{date}-{slug}/scene-01.quality.md"
```

### Step 6: Assemble master video with audio (FFmpeg)

1. Create a concat file at `assets/videos/{date}-{slug}/concat.txt`:
   - `file 'scene-01.mp4'`
   - `file 'scene-02.mp4'`
   - ...

2. Concatenate video clips (silent):

```bash
ffmpeg -y -f concat -safe 0 -i "assets/videos/{date}-{slug}/concat.txt" -c copy "assets/videos/{date}-{slug}/video-only.mp4"
```

3. Concatenate voiceovers (if multiple):

```bash
ffmpeg -y -i "concat:voiceover-scene-01.wav|voiceover-scene-02.wav|..." -c copy "assets/videos/{date}-{slug}/voiceover-full.wav"
```

4. Mix audio layers (voiceover + music + Veo SFX):

```bash
ffmpeg -y \
  -i "assets/videos/{date}-{slug}/video-only.mp4" \
  -i "assets/videos/{date}-{slug}/voiceover-full.wav" \
  -i "assets/videos/{date}-{slug}/music.wav" \
  -filter_complex "
    [1:a]volume=1.0[vo];
    [2:a]volume=0.3[music];
    [vo][music]amix=inputs=2:duration=first[aout]
  " \
  -map 0:v -map "[aout]" -c:v copy -c:a aac \
  "assets/videos/{date}-{slug}/master.mp4"
```

Volume guidelines:
- **Voiceover**: 1.0 (primary, always audible)
- **Music**: 0.2-0.4 (background, atmosphere)
- **SFX**: 0.7-0.8 (supporting, impactful)

Optional: Add ducking (auto-lower music under voice):

```bash
ffmpeg -y \
  -i "assets/videos/{date}-{slug}/video-only.mp4" \
  -i "assets/videos/{date}-{slug}/voiceover-full.wav" \
  -i "assets/videos/{date}-{slug}/music.wav" \
  -filter_complex "
    [2:a]sidechaincompress=threshold=0.01:ratio=4:attack=10:release=100[ducked];
    [1:a][ducked]amix=inputs=2[aout]
  " \
  -map 0:v -map "[aout]" -c:v copy -c:a aac \
  "assets/videos/{date}-{slug}/master.mp4"
```

Reference: `${CLAUDE_PLUGIN_ROOT}/skills/ak-video/references/audio-directive-guide.md`

### Step 7: Export platform versions (optional)

If the user wants multiple platforms, create optimized exports:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/ak-video/scripts/optimize-for-platform.cjs \
  --video "assets/videos/{date}-{slug}/master.mp4" \
  --all
```

### Step 8: Captions (optional)

Generate captions/subtitles:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/ak-video/scripts/extract-captions.cjs \
  --video "assets/videos/{date}-{slug}/master.mp4" \
  --format srt \
  --output "assets/videos/{date}-{slug}/captions.srt"
```

### Step 9: Final Quality + Marketing Review (recommended)

Save publish readiness checks:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/ak-video/scripts/analyze-video.cjs \
  --video "assets/videos/{date}-{slug}/master.mp4" \
  --format markdown \
  --output "assets/videos/{date}-{slug}/analysis-marketing.md"
```

## Output Structure

- Video:
  - `assets/videos/{date}-{slug}/master.mp4`
  - `assets/videos/{date}-{slug}/scene-01.mp4` (and other scenes)
  - `assets/videos/{date}-{slug}/captions.srt` (optional)
  - `assets/videos/{date}-{slug}/analysis-marketing.md` (recommended)
- Audio:
  - `assets/videos/{date}-{slug}/voiceover-scene-01.wav` (per scene, if narration)
  - `assets/videos/{date}-{slug}/voiceover-full.wav` (concatenated)
  - `assets/videos/{date}-{slug}/music.wav` (background track)
- Storyboard:
  - `assets/storyboards/{date}-{slug}/storyboard.md`
  - `assets/storyboards/{date}-{slug}/storyboard.json`
  - `assets/storyboards/{date}-{slug}/scene-01-start.png`
  - `assets/storyboards/{date}-{slug}/scene-01-end.png`
- Script (if created):
  - `content/video/{type}/{date}-{slug}/script.md`

## Examples

```text
/video:create "30-second TikTok ad for AgentKit showing: problem -> workflow -> aha moment -> CTA"
/video:create content/video/reel/claudekit-workflow/script.md
/video:create assets/storyboards/claudekit-workflow/storyboard.json
```
