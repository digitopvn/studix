# Motion-skills packs — trigger phrases and use cases

_Verified: 2026-08-07 — 15/15 pack repos live via `git ls-remote`._

Every pack in the [iart-ai/motion-skills](https://github.com/iart-ai/motion-skills)
family is its own MIT-licensed GitHub repo, independently versioned. Skills
inside a pack auto-discover in Claude Code, Cursor, Codex, and 40+ agents once
the pack is installed.

Install a pack **only after the user confirms**:

```bash
npx skills add iart-ai/<pack>
# or, for Claude Code plugin delivery:
/plugin marketplace add iart-ai/<pack>
```

Skill counts below reflect upstream at the verification date and may drift.

## Video packs

### tiktok-video-skills (4 skills)

- **Audience:** TikTok, Instagram Reels, YouTube Shorts creators.
- **Format:** vertical 1080×1920, ~15–60s, hook-forward beat.
- **Triggers:** "tiktok", "reel", "short", "vertical video", "9:16",
  "hook then payoff", "beat-synced cuts", "for-you-page".
- **Compose with:** `ak-copywriting` (hook line), `ak-video script-create`
  (extended script), `ak-elevenlabs` (voice-over).

### text-message-video-skills (1 skill)

- **Audience:** creators telling stories as fake iMessage / SMS threads.
- **Format:** vertical, chat-bubble animation with typing indicators.
- **Triggers:** "text-message story", "imessage story", "chat-thread video".

### youtube-video-skills (2 skills)

- **Audience:** podcasters, long-form YouTubers.
- **Format:** horizontal 1920×1080, chapter markers, thumbnail-friendly title
  cards.
- **Triggers:** "youtube video", "podcast clip", "16:9 episode",
  "chapter card", "youtube intro".
- **Compose with:** `ak-youtube-thumbnail-design` (thumbnail),
  `ak-video script-create`.

### ecommerce-video-skills (3 skills)

- **Audience:** e-commerce sellers, DTC brands.
- **Format:** product demo loops, unboxing, before/after reveals.
- **Triggers:** "product video", "unboxing", "before-and-after",
  "shop loop", "amazon a+", "listing video".

### ad-video-skills (3 skills)

- **Audience:** brand advertisers, paid-media buyers.
- **Format:** ad creative variants for Meta / TikTok / YouTube / Google.
- **Triggers:** "meta ad", "facebook ad", "tiktok ad", "google ad",
  "ad variant", "creative test", "hook/body/cta".
- **Compose with:** `ak-paid-ads`, `ak-ads-management`, `ak-copywriting`.

### explainer-video-skills (5 skills)

- **Audience:** educators, courseware creators, product-marketing.
- **Format:** how-it-works, feature walk-throughs, tutorial voice-overs.
- **Triggers:** "explainer", "how-it-works", "walkthrough", "tutorial",
  "onboarding video".

### data-animation-skills (3 skills)

- **Audience:** analysts, PMs, editorial data-journalists.
- **Format:** frame-accurate charts, KPI reveals, dashboard motion.
- **Triggers:** "chart animation", "data video", "kpi reveal",
  "bar-chart race", "dashboard motion", "financial explainer".
- **Compose with:** `ak-analytics`, `ak-marketing-dashboard`.
- **Prefer in-repo first:** `ak-remotion` covers custom data-driven video in
  React; use this pack when the user wants an off-the-shelf chart template
  rather than authoring from scratch.

### map-animation-skills (1 skill)

- **Audience:** editorial / journalism outfits wanting Vox-style maps.
- **Format:** country / region reveals, route animations, choropleth motion.
- **Triggers:** "map animation", "editorial map", "vox-style map",
  "country reveal", "route on map".

## Web / design packs

### web-animation-skills (9 skills)

- **Audience:** frontend developers.
- **Format:** GSAP, SVG, Lottie, on-scroll motion; deliverable is HTML/JS.
- **Triggers:** "gsap", "svg animation", "lottie", "on-scroll",
  "scroll-triggered", "hero animation", "loading state", "micro-interaction".
- **Compose with:** `ak-frontend-design`, `ak-frontend-development`,
  `ak-ui-styling`, `ak-ui-ux-pro-max`.

### motion-design-skills (9 skills)

- **Audience:** motion designers, brand teams.
- **Format:** brand sizzles, logo motion, transition packs, title systems.
- **Triggers:** "brand sizzle", "logo animation", "logo reveal",
  "transition pack", "title system", "motion identity".
- **Compose with:** `ak-brand`, `ak-logo-design`, `ak-design-system`.

### kinetic-typography-skills (1 skill)

- **Audience:** motion designers, brand teams focused on type.
- **Format:** animated text, title cards, quote reveals.
- **Triggers:** "kinetic typography", "text animation", "title card",
  "quote reveal", "type-driven ad".

## Specialist packs

### freelance-motion-skills (5 skills)

- **Audience:** freelance motion designers and studios.
- **Format:** client-facing deliverables — pitch reels, revision briefs,
  handoff packages, showreels.
- **Triggers:** "client reel", "handoff", "pitch reel", "revision brief",
  "showreel".

### webgl-animation-skills (3 skills)

- **Audience:** 3D / WebGL / shader developers.
- **Format:** Three.js template scenes, custom shaders, generative 3D.
- **Triggers:** "three.js template", "webgl template", "shader template",
  "3d scene template", "particle system template".
- **Prefer in-repo first:** `ak-threejs` and `ak-shader` cover building from
  scratch; use this pack when the user wants a proven template.

### manim-skills (1 skill)

- **Audience:** math / educational animators (3Blue1Brown style).
- **Format:** Python-driven Manim scenes for math or CS concepts.
- **Triggers:** "manim", "3blue1brown", "math animation",
  "equation reveal", "geometric proof".

### generative-illustration-skills (1 skill)

- **Audience:** creative coders, generative artists, illustrators.
- **Format:** procedural illustration in code (p5.js, canvas, SVG).
- **Triggers:** "generative illustration", "creative coding",
  "procedural art", "p5.js", "canvas art".

## Choosing between overlapping options

- **"tiktok ad"** — start with `tiktok-video-skills` (format wins); fall back
  to `ad-video-skills` only when the hook/body/CTA harness is what's needed.
- **"explainer for a chart"** — start with `data-animation-skills` (correct
  numbers first), then use `explainer-video-skills` templates for framing.
- **"logo animation on the web"** — `motion-design-skills` for the logo motion,
  `web-animation-skills` for the GSAP embedding — or in-repo
  `ak-frontend-development` if the page is already yours.
- **"brand sizzle for youtube"** — `motion-design-skills` for the sizzle,
  `youtube-video-skills` for the format container.
- **"custom Three.js scene"** — prefer in-repo `ak-threejs` +
  `ak-shader`; use `webgl-animation-skills` only for a proven template.
