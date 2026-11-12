import type { MotionPreset, SceneTransition } from "@studix/video-ir";

/** Font families the HyperFrames renderer bundles with Vietnamese subsets; a profile sets type in these only. */
export const MOTION_FONTS = [
  "Be Vietnam Pro",
  "Inter",
  "JetBrains Mono",
  "Oswald",
  "Playfair Display",
  "Plus Jakarta Sans",
  "Space Grotesk",
] as const;
export type MotionFont = (typeof MOTION_FONTS)[number];

/**
 * Motion style profiles, ported from the pinned agentkit motion-video style library: its aesthetic, house and
 * brand-inspired families (ids and looks only; aliases naming real brands are not ported). A profile is a
 * preset that locks the look of a graphic:
 * - palette: the three roles the template maps onto the brand-free fallback palette;
 * - type: the bundled font families of headlines and body text (a brand kit's own fonts still win);
 * - pacing: the energy level (1 calm .. 5 frantic) and the tempo range (bpm) the cuts and entrances follow;
 * - juice: the entrances a card may use (the first is the default), the exit and the cut transition.
 * Data generated from `packages/skills/defaults/ak-motion-video/references/styles/profiles/*.yaml`.
 */
export interface MotionStyleProfile {
  id: string;
  name: string;
  family: "aesthetic" | "brand-inspired" | "house";
  energy: 1 | 2 | 3 | 4 | 5;
  bestFor: readonly string[];
  summary: string;
  /** Tempo range (beats per minute) the cut rhythm follows. */
  bpm: readonly [number, number];
  palette: { background: string; foreground: string; accent: string };
  type: { heading: MotionFont; body: MotionFont };
  juice: {
    enter: readonly [Exclude<MotionPreset, "none">, ...Exclude<MotionPreset, "none">[]];
    exit: MotionPreset;
    transition: SceneTransition;
  };
}

export const MOTION_STYLE_PROFILES: readonly MotionStyleProfile[] = [
  {
    id: "accelerated-compute",
    name: "Accelerated Compute",
    family: "brand-inspired",
    energy: 4,
    bestFor: ["ai-infrastructure", "benchmark-reveal", "chip-launch", "developer-platform"],
    summary:
      "GPU-keynote energy; black stage, acid-green circuitry, particle data streams and benchmark bars that surge.",
    bpm: [120, 135],
    palette: { background: "#050505", foreground: "#ffffff", accent: "#4cc41c" },
    type: { heading: "Space Grotesk", body: "Space Grotesk" },
    juice: {
      enter: ["pop", "slide-up", "scale", "slide-left"],
      exit: "scale",
      transition: { kind: "zoom", durationMs: 250 },
    },
  },
  {
    id: "ambient-intelligence",
    name: "Ambient Intelligence",
    family: "brand-inspired",
    energy: 2,
    bestFor: ["ai-model-launch", "research-announcement", "assistant-demo", "product-explainer"],
    summary:
      "Calm AI-lab minimalism; soft blurred colour fields, streaming text, generous white space and slow breathing motion.",
    bpm: [70, 95],
    palette: { background: "#ffffff", foreground: "#0d0d0d", accent: "#1f9e98" },
    type: { heading: "Inter", body: "Inter" },
    juice: {
      enter: ["fade", "slide-up", "scale"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 500 },
    },
  },
  {
    id: "art-deco-luxury",
    name: "Art Deco Luxury",
    family: "aesthetic",
    energy: 2,
    bestFor: ["luxury-product", "perfume-watch-promo", "heritage-brand", "gala-event"],
    summary:
      "1920s art-deco advertisement; champagne gold on charcoal and cream, didone serifs, fan and sunray geometry, slow glints.",
    bpm: [84, 104],
    palette: { background: "#1c1b19", foreground: "#f3ead6", accent: "#c9a45c" },
    type: { heading: "Playfair Display", body: "Inter" },
    juice: {
      enter: ["fade", "slide-up", "scale"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 500 },
    },
  },
  {
    id: "athletic-impact",
    name: "Athletic Impact",
    family: "brand-inspired",
    energy: 5,
    bestFor: ["hype-launch", "finale", "sports-promo", "motivational"],
    summary:
      "Raw athletic hype; frame-filling condensed type, hard beat cuts, stutter frames, speed ramps and a high-vis accent.",
    bpm: [120, 150],
    palette: { background: "#000000", foreground: "#ffffff", accent: "#d4ff00" },
    type: { heading: "Oswald", body: "Be Vietnam Pro" },
    juice: {
      enter: ["pop", "scale", "slide-left", "slide-right"],
      exit: "scale",
      transition: { kind: "zoom", durationMs: 200 },
    },
  },
  {
    id: "bauhaus-geometry",
    name: "Bauhaus Geometry",
    family: "aesthetic",
    energy: 3,
    bestFor: ["explainer", "brand-promo", "concept-intro", "education"],
    summary:
      "Primary-colour circles, squares and triangles that roll, rotate and assemble into type and diagrams.",
    bpm: [96, 116],
    palette: { background: "#efe8d8", foreground: "#1a1a1a", accent: "#d62828" },
    type: { heading: "Inter", body: "Inter" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "fade", durationMs: 350 },
    },
  },
  {
    id: "blueprint-engineering",
    name: "Blueprint Engineering",
    family: "aesthetic",
    energy: 2,
    bestFor: ["architecture-explainer", "hardware-spec", "technical-deep-dive", "how-it-works"],
    summary:
      "Cyanotype blueprint sheet; white linework drawn stroke by stroke, dimension lines, callouts and exploded views.",
    bpm: [84, 104],
    palette: { background: "#0d3b6e", foreground: "#e8f1ff", accent: "#ffd166" },
    type: { heading: "Space Grotesk", body: "Inter" },
    juice: {
      enter: ["fade", "slide-up", "scale"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 500 },
    },
  },
  {
    id: "calm-workspace",
    name: "Calm Workspace",
    family: "brand-inspired",
    energy: 1,
    bestFor: ["productivity-app", "docs-tool", "knowledge-base", "thoughtful-explainer"],
    summary:
      "Quiet document workspace; off-white page, serif headings, monoline doodles, blocks that type, drag and settle.",
    bpm: [70, 95],
    palette: { background: "#fbfbfa", foreground: "#191919", accent: "#3a6fe0" },
    type: { heading: "Playfair Display", body: "Inter" },
    juice: { enter: ["fade", "slide-up"], exit: "fade", transition: { kind: "slide", durationMs: 600 } },
  },
  {
    id: "character-comedy",
    name: "Character Comedy",
    family: "brand-inspired",
    energy: 5,
    bestFor: ["app-promo", "habit-product", "social-cut", "gamified-feature"],
    summary:
      "Mascot-led comedy; a chunky rounded character with big expressions, streak counters, bouncy UI and deadpan gags.",
    bpm: [120, 140],
    palette: { background: "#ffffff", foreground: "#3a3a40", accent: "#45c21f" },
    type: { heading: "Plus Jakarta Sans", body: "Plus Jakarta Sans" },
    juice: {
      enter: ["pop", "scale", "slide-left", "slide-right"],
      exit: "scale",
      transition: { kind: "wipe", durationMs: 200 },
    },
  },
  {
    id: "cinematic-product-launch",
    name: "Cinematic Product Launch",
    family: "brand-inspired",
    energy: 2,
    bestFor: ["flagship-launch", "premium-feature", "brand-promo", "product-reveal"],
    summary:
      "Restrained premium product film; one centred hero, lots of air, continuous eased motion, quiet music.",
    bpm: [90, 110],
    palette: { background: "#000000", foreground: "#f2f1ee", accent: "#4a86ff" },
    type: { heading: "Inter", body: "Inter" },
    juice: {
      enter: ["slide-up", "fade", "scale"],
      exit: "fade",
      transition: { kind: "fade", durationMs: 500 },
    },
  },
  {
    id: "cinematic-streaming",
    name: "Cinematic Streaming",
    family: "brand-inspired",
    energy: 4,
    bestFor: ["content-trailer", "series-launch", "catalogue-promo", "teaser"],
    summary:
      "Dark trailer grammar; letterboxed hero frames, red light sweeps, poster rows sliding in, a booming title hit.",
    bpm: [80, 100],
    palette: { background: "#0b0b0b", foreground: "#f4f4f4", accent: "#dc3a22" },
    type: { heading: "Oswald", body: "Inter" },
    juice: {
      enter: ["slide-up", "pop", "scale", "slide-left"],
      exit: "scale",
      transition: { kind: "wipe", durationMs: 250 },
    },
  },
  {
    id: "cinematic-technology",
    name: "Cinematic Technology",
    family: "brand-inspired",
    energy: 3,
    bestFor: ["imaging-product", "audio-product", "creator-tools", "premium-brand-film"],
    summary:
      "Filmmaker-grade tech film; anamorphic light, rack-focus reveals, deep blacks and elegant thin type over imagery.",
    bpm: [85, 110],
    palette: { background: "#050608", foreground: "#f0f0f0", accent: "#4da3ff" },
    type: { heading: "Inter", body: "Inter" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 350 },
    },
  },
  {
    id: "comic-multiverse",
    name: "Comic Multiverse",
    family: "house",
    energy: 5,
    bestFor: ["hype-launch", "social-cut", "youth-brand", "playful-promo"],
    summary:
      "Loud hand-made comic energy; halftone, ink outlines, CMY misregistration, glitch cuts, motion on twos.",
    bpm: [105, 115],
    palette: { background: "#1a0b3d", foreground: "#fff6e5", accent: "#ff2e9a" },
    type: { heading: "Oswald", body: "Be Vietnam Pro" },
    juice: {
      enter: ["pop", "scale", "slide-left", "slide-right"],
      exit: "scale",
      transition: { kind: "zoom", durationMs: 200 },
    },
  },
  {
    id: "community-chaos",
    name: "Community Chaos",
    family: "brand-inspired",
    energy: 5,
    bestFor: ["community-launch", "gaming", "social-feature", "youth-promo"],
    summary:
      "Loud online community; dark UI, electric blurple, voice rings, sticker slaps, meme zooms and chat floods.",
    bpm: [120, 150],
    palette: { background: "#1c1d24", foreground: "#f1f1ee", accent: "#7358ee" },
    type: { heading: "Space Grotesk", body: "Space Grotesk" },
    juice: {
      enter: ["pop", "scale", "slide-left", "slide-right"],
      exit: "scale",
      transition: { kind: "zoom", durationMs: 200 },
    },
  },
  {
    id: "constructivist-poster",
    name: "Constructivist Poster",
    family: "aesthetic",
    energy: 4,
    bestFor: ["manifesto", "industry-story", "revolution-history", "launch-announcement"],
    summary:
      "Constructivist photomontage; red, black and cream, bold diagonals, condensed type, wedges driving into frame.",
    bpm: [112, 132],
    palette: { background: "#efe6d2", foreground: "#141414", accent: "#c8102e" },
    type: { heading: "Oswald", body: "Be Vietnam Pro" },
    juice: {
      enter: ["pop", "slide-up", "scale", "slide-left"],
      exit: "scale",
      transition: { kind: "fade", durationMs: 250 },
    },
  },
  {
    id: "creative-canvas",
    name: "Creative Canvas",
    family: "brand-inspired",
    energy: 3,
    bestFor: ["design-tool", "collaboration", "product-process", "creative-workflow"],
    summary:
      "Collaborative design canvas; infinite board, labelled multiplayer cursors, selection handles, frames that zoom and snap.",
    bpm: [100, 120],
    palette: { background: "#f5f5f5", foreground: "#1e1e1e", accent: "#2f7df6" },
    type: { heading: "Inter", body: "Inter" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 350 },
    },
  },
  {
    id: "creative-suite",
    name: "Creative Suite",
    family: "brand-inspired",
    energy: 3,
    bestFor: ["creative-tool", "ai-generation", "editing-workflow", "portfolio"],
    summary:
      "Pro creative tooling; dark workspace panels, layer stacks, brush-mask and before/after reveals, spectral colour.",
    bpm: [100, 122],
    palette: { background: "#1b1b1b", foreground: "#f0f0f0", accent: "#3f8cff" },
    type: { heading: "Inter", body: "Inter" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 350 },
    },
  },
  {
    id: "data-editorial",
    name: "Data Editorial",
    family: "aesthetic",
    energy: 2,
    bestFor: ["data-story", "report-launch", "research-explainer", "benchmarks"],
    summary:
      "Newsroom data story; charts build on narration, annotations point at the story and numbers carry the headline.",
    bpm: [84, 104],
    palette: { background: "#fbf9f4", foreground: "#1b1b1b", accent: "#d1495b" },
    type: { heading: "Playfair Display", body: "Inter" },
    juice: {
      enter: ["fade", "slide-up", "scale"],
      exit: "fade",
      transition: { kind: "fade", durationMs: 500 },
    },
  },
  {
    id: "developer-workflow",
    name: "Developer Workflow",
    family: "brand-inspired",
    energy: 3,
    bestFor: ["dev-tool", "open-source", "ci-cd", "collaboration"],
    summary:
      "Code-collaboration story; dark editor, diffs, branching commit graphs, checks turning green and activity grids.",
    bpm: [100, 120],
    palette: { background: "#10131a", foreground: "#e8ecef", accent: "#4a74f0" },
    type: { heading: "Inter", body: "Inter" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 350 },
    },
  },
  {
    id: "documentary-purpose",
    name: "Documentary Purpose",
    family: "brand-inspired",
    energy: 2,
    bestFor: ["mission-film", "impact-report", "sustainability-story", "founder-story"],
    summary:
      "Purpose-led outdoor documentary; natural imagery, earthy palette, typewriter facts and patient handheld pacing.",
    bpm: [70, 95],
    palette: { background: "#1f1d1a", foreground: "#f3ede2", accent: "#d9632b" },
    type: { heading: "Playfair Display", body: "Be Vietnam Pro" },
    juice: {
      enter: ["fade", "slide-up", "scale"],
      exit: "fade",
      transition: { kind: "fade", durationMs: 500 },
    },
  },
  {
    id: "editorial-collage-explainer",
    name: "Editorial Collage Explainer",
    family: "brand-inspired",
    energy: 3,
    bestFor: ["explainer", "history-story", "data-story", "brand-story"],
    summary:
      "Explainer collage; torn-paper posters, halftone cut-outs, one bold flat colour per scene, pieces fly in and assemble.",
    bpm: [96, 118],
    palette: { background: "#f1e7d3", foreground: "#1d1a17", accent: "#e2412b" },
    type: { heading: "Oswald", body: "Be Vietnam Pro" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 350 },
    },
  },
  {
    id: "editorial-intelligence",
    name: "Editorial Intelligence",
    family: "brand-inspired",
    energy: 2,
    bestFor: ["ai-research", "safety-explainer", "thought-leadership", "product-announcement"],
    summary:
      "Thoughtful AI editorial; warm paper tones, serif headlines, hand-drawn line illustrations and measured reveals.",
    bpm: [75, 95],
    palette: { background: "#f5f0e8", foreground: "#191919", accent: "#d0804e" },
    type: { heading: "Playfair Display", body: "Inter" },
    juice: {
      enter: ["slide-up", "fade", "scale"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 500 },
    },
  },
  {
    id: "expressive-material",
    name: "Expressive Material",
    family: "brand-inspired",
    energy: 3,
    bestFor: ["mobile-app", "personalization", "feature-tour", "consumer-launch"],
    summary:
      "Tonal, personal UI motion; seed-colour tonal palettes, morphing rounded shapes, container transforms, bold springs.",
    bpm: [100, 124],
    palette: { background: "#fcf7fc", foreground: "#201c22", accent: "#7a4fa8" },
    type: { heading: "Inter", body: "Inter" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 350 },
    },
  },
  {
    id: "extreme-energy",
    name: "Extreme Energy",
    family: "brand-inspired",
    energy: 5,
    bestFor: ["event-hype", "action-edit", "sponsorship-reel", "social-cut"],
    summary:
      "Adrenaline action edit; speed ramps, whip pans, impact freeze-frames and huge condensed type slamming on drops.",
    bpm: [130, 160],
    palette: { background: "#0a0c1f", foreground: "#ffffff", accent: "#e22a36" },
    type: { heading: "Oswald", body: "Inter" },
    juice: {
      enter: ["pop", "scale", "slide-left", "slide-right"],
      exit: "scale",
      transition: { kind: "slide", durationMs: 200 },
    },
  },
  {
    id: "fluent-productivity",
    name: "Fluent Productivity",
    family: "brand-inspired",
    energy: 2,
    bestFor: ["productivity-app", "enterprise-feature", "workflow-demo", "ai-assistant"],
    summary:
      "Calm layered productivity UI; soft translucent layers, depth shadows, connected element moves and decelerated entrances.",
    bpm: [90, 110],
    palette: { background: "#eef1f6", foreground: "#242424", accent: "#2a5fc4" },
    type: { heading: "Inter", body: "Inter" },
    juice: {
      enter: ["fade", "slide-up", "scale"],
      exit: "fade",
      transition: { kind: "fade", durationMs: 500 },
    },
  },
  {
    id: "friendly-system-motion",
    name: "Friendly System Motion",
    family: "brand-inspired",
    energy: 3,
    bestFor: ["explainer", "product-feature", "how-it-works", "consumer-app"],
    summary:
      "Bright, helpful and simple; white space, cheerful primaries, bouncing dots that form shapes, rounded cards.",
    bpm: [100, 120],
    palette: { background: "#ffffff", foreground: "#22252b", accent: "#5566e8" },
    type: { heading: "Space Grotesk", body: "Space Grotesk" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 350 },
    },
  },
  {
    id: "functional-playful",
    name: "Functional Playful",
    family: "brand-inspired",
    energy: 3,
    bestFor: ["how-it-works", "home-product", "value-promo", "onboarding"],
    summary:
      "Practical home-design wit; flat-pack diagrams, room sets that rearrange, blue and yellow blocks and dry humour.",
    bpm: [100, 118],
    palette: { background: "#ffffff", foreground: "#111111", accent: "#1f4fb0" },
    type: { heading: "Be Vietnam Pro", body: "Be Vietnam Pro" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 350 },
    },
  },
  {
    id: "glass-keynote",
    name: "Glass Keynote",
    family: "house",
    energy: 3,
    bestFor: ["product-launch", "changelog", "explainer", "feature-tour"],
    summary:
      "Calm premium tech keynote; indigo space, drifting colour orbs, frosted glass cards, gradient type.",
    bpm: [118, 128],
    palette: { background: "#070817", foreground: "#f5f3ff", accent: "#60a5fa" },
    type: { heading: "Plus Jakarta Sans", body: "Plus Jakarta Sans" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 350 },
    },
  },
  {
    id: "gradient-fintech",
    name: "Gradient Fintech",
    family: "brand-inspired",
    energy: 3,
    bestFor: ["fintech", "api-product", "developer-platform", "growth-story"],
    summary:
      "Polished developer fintech; flowing mesh gradients, slanted section edges, crisp floating cards and code.",
    bpm: [100, 120],
    palette: { background: "#f4f6fa", foreground: "#14213d", accent: "#7050e8" },
    type: { heading: "Space Grotesk", body: "Space Grotesk" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "wipe", durationMs: 350 },
    },
  },
  {
    id: "groovy-seventies",
    name: "Groovy Seventies",
    family: "aesthetic",
    energy: 3,
    bestFor: ["culture-story", "food-promo", "lifestyle-promo", "nostalgia-campaign"],
    summary:
      "1970s groovy print; mustard, rust and avocado, bulbous display serifs, wavy stripes, warm riso grain.",
    bpm: [96, 116],
    palette: { background: "#f5e6c8", foreground: "#3b2416", accent: "#d35f1f" },
    type: { heading: "Playfair Display", body: "Be Vietnam Pro" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "wipe", durationMs: 350 },
    },
  },
  {
    id: "holographic-hud",
    name: "Holographic HUD",
    family: "aesthetic",
    energy: 3,
    bestFor: ["ai-product", "security-tool", "tech-launch", "analytics-promo"],
    summary:
      "Translucent cyan heads-up display; targeting rings, scanning sweeps, data readouts locking onto the subject.",
    bpm: [100, 122],
    palette: { background: "#030b17", foreground: "#d9f6ff", accent: "#35e0ff" },
    type: { heading: "Space Grotesk", body: "Be Vietnam Pro" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 350 },
    },
  },
  {
    id: "human-storytelling",
    name: "Human Storytelling",
    family: "brand-inspired",
    energy: 2,
    bestFor: ["community-story", "marketplace-promo", "testimonial-film", "brand-story"],
    summary:
      "Warm, human travel story; rounded photo cards, soft coral accent, gentle parallax and handwritten-feeling pacing.",
    bpm: [80, 100],
    palette: { background: "#fffaf6", foreground: "#222222", accent: "#ef6f58" },
    type: { heading: "Plus Jakarta Sans", body: "Plus Jakarta Sans" },
    juice: {
      enter: ["slide-up", "fade", "scale"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 500 },
    },
  },
  {
    id: "immersive-console",
    name: "Immersive Console",
    family: "brand-inspired",
    energy: 4,
    bestFor: ["game-launch", "console-ui", "entertainment-hub", "immersive-reveal"],
    summary:
      "Console reveal drama; deep blue void, floating light particles, UI tiles gliding in 3D and a heavy bass reveal.",
    bpm: [90, 120],
    palette: { background: "#00091a", foreground: "#ffffff", accent: "#2a62e0" },
    type: { heading: "Space Grotesk", body: "Space Grotesk" },
    juice: {
      enter: ["pop", "slide-up", "scale", "slide-left"],
      exit: "scale",
      transition: { kind: "zoom", durationMs: 250 },
    },
  },
  {
    id: "ink-woodblock",
    name: "Ink Woodblock",
    family: "aesthetic",
    energy: 2,
    bestFor: ["culture-history", "heritage-brand", "philosophy-explainer", "calm-promo"],
    summary:
      "East Asian ink and woodblock; brush strokes on rice paper, vermilion seals, misty layered mountains, slow unfurling.",
    bpm: [64, 88],
    palette: { background: "#efe6d4", foreground: "#151311", accent: "#c0301f" },
    type: { heading: "Playfair Display", body: "Be Vietnam Pro" },
    juice: {
      enter: ["fade", "slide-up", "scale"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 500 },
    },
  },
  {
    id: "isometric-systems",
    name: "Isometric Systems",
    family: "aesthetic",
    energy: 2,
    bestFor: ["architecture-explainer", "platform-overview", "infra-product", "onboarding"],
    summary:
      "Clean isometric world; systems as blocks and tiles, data flowing along iso paths, calm builds and axis pans.",
    bpm: [88, 104],
    palette: { background: "#eef2f8", foreground: "#1e2a3b", accent: "#3b6cff" },
    type: { heading: "Space Grotesk", body: "Space Grotesk" },
    juice: {
      enter: ["slide-up", "fade", "scale"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 500 },
    },
  },
  {
    id: "joyful-pop",
    name: "Joyful Pop",
    family: "brand-inspired",
    energy: 4,
    bestFor: ["seasonal-campaign", "celebration-promo", "community-moment", "brand-anthem"],
    summary:
      "Joyful red-and-white celebration; fizzy bubbles, bubble-burst transitions, confetti and warm shared moments.",
    bpm: [105, 125],
    palette: { background: "#e8503a", foreground: "#ffffff", accent: "#ffffff" },
    type: { heading: "Playfair Display", body: "Plus Jakarta Sans" },
    juice: {
      enter: ["pop", "slide-up", "scale", "slide-left"],
      exit: "scale",
      transition: { kind: "zoom", durationMs: 250 },
    },
  },
  {
    id: "keynote-stage",
    name: "Keynote Stage",
    family: "brand-inspired",
    energy: 2,
    bestFor: ["product-launch", "announcement", "stats-reveal", "event-recap"],
    summary:
      "Live-stage presentation feel; black stage, one giant word or number per slide, builds and shared-element morphs.",
    bpm: [80, 100],
    palette: { background: "#000000", foreground: "#ffffff", accent: "#f5821f" },
    type: { heading: "Inter", body: "Inter" },
    juice: {
      enter: ["fade", "slide-up", "scale"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 500 },
    },
  },
  {
    id: "kinetic-typography",
    name: "Kinetic Typography",
    family: "aesthetic",
    energy: 4,
    bestFor: ["manifesto", "announcement", "social-cut", "launch-teaser"],
    summary:
      "Words are the visuals; giant type synced to every spoken word, masks, fills, stacks and rhythmic cuts.",
    bpm: [100, 128],
    palette: { background: "#0e0e0e", foreground: "#f4f1ea", accent: "#ff4d00" },
    type: { heading: "Oswald", body: "Inter" },
    juice: {
      enter: ["pop", "slide-up", "scale", "slide-left"],
      exit: "scale",
      transition: { kind: "zoom", durationMs: 250 },
    },
  },
  {
    id: "manga-ink",
    name: "Manga Ink",
    family: "aesthetic",
    energy: 5,
    bestFor: ["hype-launch", "story-promo", "youth-brand", "social-cut"],
    summary:
      "Black-and-white manga pages; brush ink, screentone, speed lines, diagonal panels and impact frames.",
    bpm: [128, 150],
    palette: { background: "#f7f4ec", foreground: "#0a0a0a", accent: "#e8132b" },
    type: { heading: "Be Vietnam Pro", body: "Be Vietnam Pro" },
    juice: {
      enter: ["pop", "scale", "slide-left", "slide-right"],
      exit: "scale",
      transition: { kind: "zoom", durationMs: 200 },
    },
  },
  {
    id: "mid-century-retro",
    name: "Mid-Century Retro",
    family: "aesthetic",
    energy: 4,
    bestFor: ["product-promo", "business-explainer", "sports-promo", "science-story"],
    summary:
      "1950s ad and atomic-age print; wood-type slabs, starbursts, teal-orange-cream halftone, optimistic bounce.",
    bpm: [110, 128],
    palette: { background: "#f4ead2", foreground: "#1f1b16", accent: "#d93a2b" },
    type: { heading: "Oswald", body: "Be Vietnam Pro" },
    juice: {
      enter: ["pop", "slide-up", "scale", "slide-left"],
      exit: "scale",
      transition: { kind: "wipe", durationMs: 250 },
    },
  },
  {
    id: "minimal-future-product",
    name: "Minimal Future Product",
    family: "brand-inspired",
    energy: 2,
    bestFor: ["hardware-launch", "vehicle-reveal", "spec-sheet", "future-product"],
    summary:
      "Stark futurist product film; white or graphite void, wide-tracked caps, slow orbit reveals and silent spec reads.",
    bpm: [70, 95],
    palette: { background: "#1b1d24", foreground: "#ffffff", accent: "#e5502e" },
    type: { heading: "Space Grotesk", body: "Space Grotesk" },
    juice: {
      enter: ["fade", "slide-up", "scale"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 500 },
    },
  },
  {
    id: "mission-control",
    name: "Mission Control",
    family: "brand-inspired",
    energy: 4,
    bestFor: ["launch-event", "milestone-reveal", "deep-tech", "roadmap-story"],
    summary:
      "Live launch-broadcast feel; telemetry readouts, T-minus countdowns, trajectory arcs and stark white-on-black type.",
    bpm: [100, 120],
    palette: { background: "#000000", foreground: "#ffffff", accent: "#ffffff" },
    type: { heading: "Space Grotesk", body: "Space Grotesk" },
    juice: {
      enter: ["pop", "slide-up", "scale", "slide-left"],
      exit: "scale",
      transition: { kind: "zoom", durationMs: 250 },
    },
  },
  {
    id: "modular-build",
    name: "Modular Build",
    family: "brand-inspired",
    energy: 4,
    bestFor: ["product-assembly", "onboarding-steps", "platform-building-blocks", "kids-promo"],
    summary:
      "Build-it-yourself play; plain stackable blocks snapping together step by step, stop-motion stepping and bold primaries.",
    bpm: [110, 128],
    palette: { background: "#fef9e7", foreground: "#1b1b1b", accent: "#d8462c" },
    type: { heading: "Oswald", body: "Inter" },
    juice: {
      enter: ["pop", "slide-up", "scale", "slide-left"],
      exit: "scale",
      transition: { kind: "zoom", durationMs: 250 },
    },
  },
  {
    id: "monochrome-developer",
    name: "Monochrome Developer",
    family: "brand-inspired",
    energy: 3,
    bestFor: ["developer-platform", "deploy-flow", "infrastructure", "launch-week"],
    summary:
      "Stark black-and-white developer platform; plus-marked grid lines, deploy logs, spotlight beams and edge-network globes.",
    bpm: [110, 128],
    palette: { background: "#000000", foreground: "#ededed", accent: "#ffffff" },
    type: { heading: "Inter", body: "Inter" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "fade", durationMs: 350 },
    },
  },
  {
    id: "monochrome-luxury",
    name: "Monochrome Luxury",
    family: "aesthetic",
    energy: 1,
    bestFor: ["luxury-brand", "premium-launch", "lookbook", "brand-manifesto"],
    summary:
      "Black and ivory fashion-house film; high-contrast serif type, slow reveals, light sweeps and long holds.",
    bpm: [60, 84],
    palette: { background: "#0a0a0a", foreground: "#f4efe6", accent: "#c8b79a" },
    type: { heading: "Playfair Display", body: "Be Vietnam Pro" },
    juice: { enter: ["fade", "slide-up"], exit: "fade", transition: { kind: "fade", durationMs: 600 } },
  },
  {
    id: "music-editorial",
    name: "Music Editorial",
    family: "brand-inspired",
    energy: 4,
    bestFor: ["year-in-review", "music-app", "personalized-stats", "culture-campaign"],
    summary:
      "Bold music culture; duotone portraits, saturated colour blocks, huge type, stat cards and beat-locked cuts.",
    bpm: [110, 130],
    palette: { background: "#141416", foreground: "#ffffff", accent: "#2ad19a" },
    type: { heading: "Inter", body: "Inter" },
    juice: {
      enter: ["pop", "slide-up", "scale", "slide-left"],
      exit: "scale",
      transition: { kind: "wipe", durationMs: 250 },
    },
  },
  {
    id: "neo-brutalist-web",
    name: "Neo Brutalist Web",
    family: "aesthetic",
    energy: 4,
    bestFor: ["indie-launch", "startup-promo", "social-cut", "changelog"],
    summary:
      "Loud flat blocks, thick black borders, hard offset shadows, raw system type and snappy stamp-in motion.",
    bpm: [120, 140],
    palette: { background: "#fffdf5", foreground: "#000000", accent: "#ff5c00" },
    type: { heading: "Oswald", body: "Space Grotesk" },
    juice: {
      enter: ["pop", "slide-up", "scale", "slide-left"],
      exit: "scale",
      transition: { kind: "zoom", durationMs: 250 },
    },
  },
  {
    id: "neon-cyberpunk",
    name: "Neon Cyberpunk",
    family: "aesthetic",
    energy: 5,
    bestFor: ["gaming-launch", "hype-promo", "web3-launch", "music-promo"],
    summary:
      "Rain-slick neon night; magenta and cyan glow signs, chromatic glitch cuts and bass-driven pulses.",
    bpm: [128, 150],
    palette: { background: "#07040f", foreground: "#f2eaff", accent: "#ff2bd6" },
    type: { heading: "Space Grotesk", body: "Be Vietnam Pro" },
    juice: {
      enter: ["pop", "scale", "slide-left", "slide-right"],
      exit: "scale",
      transition: { kind: "zoom", durationMs: 200 },
    },
  },
  {
    id: "newsprint-editorial",
    name: "Newsprint Editorial",
    family: "aesthetic",
    energy: 4,
    bestFor: ["news-explainer", "ai-tech-explainer", "announcement", "editorial-feature"],
    summary:
      "Mid-century front-page feature; condensed headlines, heavy halftone, deep red and mustard on cream, stamp slams.",
    bpm: [108, 128],
    palette: { background: "#f1e8d4", foreground: "#1b1916", accent: "#b3201c" },
    type: { heading: "Oswald", body: "Be Vietnam Pro" },
    juice: {
      enter: ["pop", "slide-up", "scale", "slide-left"],
      exit: "scale",
      transition: { kind: "zoom", durationMs: 250 },
    },
  },
  {
    id: "organic-biomorphic",
    name: "Organic Biomorphic",
    family: "aesthetic",
    energy: 2,
    bestFor: ["wellness-brand", "sustainability", "ai-assistant", "brand-story"],
    summary:
      "Living fluid forms; morphing blobs, soft gradients, growing tendrils, breathing motion and natural calm.",
    bpm: [70, 92],
    palette: { background: "#f4f1ea", foreground: "#1f2a24", accent: "#2f8f6b" },
    type: { heading: "Playfair Display", body: "Space Grotesk" },
    juice: {
      enter: ["fade", "slide-up", "scale"],
      exit: "fade",
      transition: { kind: "fade", durationMs: 500 },
    },
  },
  {
    id: "paper-cut-collage",
    name: "Paper Cut Collage",
    family: "aesthetic",
    energy: 3,
    bestFor: ["brand-story", "community-promo", "explainer", "creative-promo"],
    summary:
      "Handmade collage; torn paper, cut-out photos, tape and stickers, layered shadows, stop-motion jitter.",
    bpm: [92, 110],
    palette: { background: "#f3ead8", foreground: "#231f1a", accent: "#e4572e" },
    type: { heading: "Oswald", body: "Be Vietnam Pro" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 350 },
    },
  },
  {
    id: "pixel-arcade",
    name: "Pixel Arcade",
    family: "aesthetic",
    energy: 4,
    bestFor: ["game-launch", "gamified-feature", "dev-community", "social-cut"],
    summary:
      "8/16-bit game screens; chunky pixels, stepped motion, score counters, level-clear irises and power-up pops.",
    bpm: [120, 140],
    palette: { background: "#1a1c2c", foreground: "#f4f4f4", accent: "#ffcd75" },
    type: { heading: "Be Vietnam Pro", body: "Be Vietnam Pro" },
    juice: {
      enter: ["pop", "slide-up", "scale", "slide-left"],
      exit: "scale",
      transition: { kind: "fade", durationMs: 250 },
    },
  },
  {
    id: "playful-game-system",
    name: "Playful Game System",
    family: "brand-inspired",
    energy: 4,
    bestFor: ["game-promo", "family-product", "playful-feature", "social-cut"],
    summary:
      "Bright family-game joy; white stage, primary colour pops, bouncy springy UI, click sounds and characters that hop.",
    bpm: [120, 140],
    palette: { background: "#ffffff", foreground: "#1a1a1a", accent: "#e8402a" },
    type: { heading: "Plus Jakarta Sans", body: "Plus Jakarta Sans" },
    juice: {
      enter: ["pop", "slide-up", "scale", "slide-left"],
      exit: "scale",
      transition: { kind: "zoom", durationMs: 250 },
    },
  },
  {
    id: "playful-productivity",
    name: "Playful Productivity",
    family: "brand-inspired",
    energy: 4,
    bestFor: ["team-app", "collaboration", "integrations", "workplace-culture"],
    summary:
      "Cheerful team chat; plum and bright accents, bouncy message pops, emoji bursts, threads that unfold.",
    bpm: [110, 128],
    palette: { background: "#ffffff", foreground: "#1e1d22", accent: "#2458b0" },
    type: { heading: "Plus Jakarta Sans", body: "Plus Jakarta Sans" },
    juice: {
      enter: ["pop", "slide-up", "scale", "slide-left"],
      exit: "scale",
      transition: { kind: "zoom", durationMs: 250 },
    },
  },
  {
    id: "precision-dark-product",
    name: "Precision Dark Product",
    family: "brand-inspired",
    energy: 3,
    bestFor: ["saas-product", "dev-tool", "feature-launch", "changelog"],
    summary:
      "Crisp dark product UI; near-black, hairline borders, soft top glows, snappy keyboard-driven list and command moves.",
    bpm: [110, 128],
    palette: { background: "#0a0a0d", foreground: "#f5f5f3", accent: "#6d5fd0" },
    type: { heading: "Inter", body: "Inter" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 350 },
    },
  },
  {
    id: "precision-hardware",
    name: "Precision Hardware",
    family: "brand-inspired",
    energy: 3,
    bestFor: ["gadget-launch", "camera-gear", "exploded-view", "spec-reveal"],
    summary:
      "Aerial-gear precision; sweeping fly-through camera, exploded component views and crisp spec callouts on graphite.",
    bpm: [105, 125],
    palette: { background: "#0d0f12", foreground: "#f2f4f7", accent: "#3aa0ff" },
    type: { heading: "Inter", body: "Inter" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 350 },
    },
  },
  {
    id: "premium-ui-demo",
    name: "Premium UI Demo",
    family: "brand-inspired",
    energy: 2,
    bestFor: ["app-demo", "feature-walkthrough", "onboarding", "ui-reveal"],
    summary:
      "Light, spring-driven interface demo; floating rounded panels, soft depth, taps that zoom and sheets that rise.",
    bpm: [90, 110],
    palette: { background: "#f2f1ee", foreground: "#1a1b1f", accent: "#3b74f2" },
    type: { heading: "Inter", body: "Inter" },
    juice: {
      enter: ["slide-up", "fade", "scale"],
      exit: "fade",
      transition: { kind: "fade", durationMs: 500 },
    },
  },
  {
    id: "product-spec-film",
    name: "Product Spec Film",
    family: "brand-inspired",
    energy: 2,
    bestFor: ["hardware-spec", "architecture-reveal", "engineering-story", "feature-deep-dive"],
    summary:
      "Engineering showcase; exploded layers, x-ray linework, leader-line callouts and precise spec numbers on graphite.",
    bpm: [70, 95],
    palette: { background: "#0b0c0e", foreground: "#e6e6e2", accent: "#74b0f7" },
    type: { heading: "Inter", body: "Inter" },
    juice: {
      enter: ["fade", "slide-up", "scale"],
      exit: "fade",
      transition: { kind: "fade", durationMs: 500 },
    },
  },
  {
    id: "punk-zine",
    name: "Punk Zine",
    family: "aesthetic",
    energy: 5,
    bestFor: ["counterculture-story", "music-promo", "manifesto", "community-promo"],
    summary:
      "Photocopied DIY zine; ransom-note letters, black and white plus one fluorescent, staples, hard jump cuts.",
    bpm: [150, 180],
    palette: { background: "#f2f0ea", foreground: "#0d0d0d", accent: "#ff2e88" },
    type: { heading: "Oswald", body: "Be Vietnam Pro" },
    juice: {
      enter: ["pop", "scale", "slide-left", "slide-right"],
      exit: "scale",
      transition: { kind: "zoom", durationMs: 200 },
    },
  },
  {
    id: "quirky-editorial",
    name: "Quirky Editorial",
    family: "brand-inspired",
    energy: 3,
    bestFor: ["small-business-promo", "marketing-tool", "brand-refresh", "explainer"],
    summary:
      "Offbeat editorial illustration; mustard fields, loose ink drawings, surreal cut-outs and witty serif headlines.",
    bpm: [95, 115],
    palette: { background: "#f2c230", foreground: "#1f1b17", accent: "#1a8072" },
    type: { heading: "Playfair Display", body: "Inter" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 350 },
    },
  },
  {
    id: "retro-crt-broadcast",
    name: "Retro CRT Broadcast",
    family: "aesthetic",
    energy: 3,
    bestFor: ["retro-promo", "nostalgia-campaign", "announcement", "explainer"],
    summary:
      "Late-night analogue TV; scanlines, phosphor glow, channel-change static, lower thirds and test cards.",
    bpm: [84, 100],
    palette: { background: "#0b0d0a", foreground: "#e8f5d0", accent: "#ffb000" },
    type: { heading: "Oswald", body: "Be Vietnam Pro" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "cut", durationMs: 0 },
    },
  },
  {
    id: "saas-bento",
    name: "SaaS Bento",
    family: "aesthetic",
    energy: 3,
    bestFor: ["feature-tour", "saas-launch", "changelog", "product-overview"],
    summary:
      "Rounded bento-grid feature tiles that expand, reflow and swap content; clean SaaS landing-page motion.",
    bpm: [104, 122],
    palette: { background: "#f5f6f8", foreground: "#0f172a", accent: "#6366f1" },
    type: { heading: "Inter", body: "Inter" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 350 },
    },
  },
  {
    id: "sensory-tech",
    name: "Sensory Tech",
    family: "brand-inspired",
    energy: 3,
    bestFor: ["device-launch", "feature-showcase", "display-tech", "consumer-promo"],
    summary:
      "Vivid consumer-tech showcase; fluid colour gradients, device morphs, sensory close-ups and bright rhythmic UI.",
    bpm: [110, 124],
    palette: { background: "#0a0a14", foreground: "#ffffff", accent: "#3a2fb5" },
    type: { heading: "Space Grotesk", body: "Space Grotesk" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 350 },
    },
  },
  {
    id: "soft-clay-3d",
    name: "Soft Clay 3D",
    family: "aesthetic",
    energy: 3,
    bestFor: ["app-onboarding", "friendly-feature", "kids-edu", "explainer"],
    summary:
      "Squishy pastel 3D; rounded clay objects, soft shadows, bouncy squash-and-stretch, friendly toy-like scenes.",
    bpm: [96, 116],
    palette: { background: "#fdf1e7", foreground: "#3a2e39", accent: "#ff8a5b" },
    type: { heading: "Plus Jakarta Sans", body: "Plus Jakarta Sans" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 350 },
    },
  },
  {
    id: "sport-editorial",
    name: "Sport Editorial",
    family: "brand-inspired",
    energy: 4,
    bestFor: ["campaign", "lifestyle-launch", "collection-drop", "culture-story"],
    summary:
      "Street-sport magazine; off-white editorial grid, split panels, cut-out collage, bold grotesk and rhythmic panel wipes.",
    bpm: [100, 125],
    palette: { background: "#efece6", foreground: "#111111", accent: "#0047ff" },
    type: { heading: "Inter", body: "Inter" },
    juice: {
      enter: ["pop", "slide-up", "scale", "slide-left"],
      exit: "scale",
      transition: { kind: "wipe", durationMs: 250 },
    },
  },
  {
    id: "swiss-kinetic-editorial",
    name: "Swiss Kinetic Editorial",
    family: "aesthetic",
    energy: 3,
    bestFor: ["explainer", "editorial-promo", "brand-manifesto", "event-announcement"],
    summary:
      "Strict modular grid, huge flush-left grotesk type, red accent bars and hard-snapping horizontal wipes.",
    bpm: [110, 124],
    palette: { background: "#f2f0eb", foreground: "#111111", accent: "#e30613" },
    type: { heading: "Inter", body: "Inter" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "wipe", durationMs: 350 },
    },
  },
  {
    id: "systematic-enterprise",
    name: "Systematic Enterprise",
    family: "brand-inspired",
    energy: 2,
    bestFor: ["enterprise-solution", "data-platform", "b2b-explainer", "research-story"],
    summary:
      "Rigorous design-system motion; strict 2x grid, square corners, blue on grey, productive curves and column mask reveals.",
    bpm: [90, 112],
    palette: { background: "#15171a", foreground: "#f3f2ef", accent: "#3a4fe0" },
    type: { heading: "Inter", body: "Inter" },
    juice: {
      enter: ["fade", "slide-up", "scale"],
      exit: "fade",
      transition: { kind: "fade", durationMs: 500 },
    },
  },
  {
    id: "terminal-ops",
    name: "Terminal Ops",
    family: "aesthetic",
    energy: 3,
    bestFor: ["cli-launch", "developer-tool", "devops-explainer", "changelog"],
    summary:
      "Full-frame terminal session; typed commands, streaming logs, status glyphs and cursor-driven cuts.",
    bpm: [100, 120],
    palette: { background: "#0c0f0a", foreground: "#d7e0d0", accent: "#39ff88" },
    type: { heading: "JetBrains Mono", body: "Be Vietnam Pro" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "wipe", durationMs: 350 },
    },
  },
  {
    id: "vaporwave-memphis",
    name: "Vaporwave Memphis",
    family: "aesthetic",
    energy: 3,
    bestFor: ["creative-promo", "music-promo", "brand-promo", "social-cut"],
    summary:
      "Pastel dreamscape; neon grid horizon, sliced sun, retro OS windows, Memphis squiggles and floating shapes.",
    bpm: [80, 100],
    palette: { background: "#2b1055", foreground: "#fff4fb", accent: "#ff71ce" },
    type: { heading: "Plus Jakarta Sans", body: "Plus Jakarta Sans" },
    juice: {
      enter: ["slide-up", "fade", "scale", "slide-left"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 350 },
    },
  },
  {
    id: "wpa-screenprint",
    name: "WPA Screenprint",
    family: "aesthetic",
    energy: 2,
    bestFor: ["history-story", "public-service", "travel-promo", "civic-explainer"],
    summary:
      "1930s silkscreen poster; muted 3-colour flat layers, stencil caps, slow layered parallax landscapes.",
    bpm: [76, 96],
    palette: { background: "#eadfc6", foreground: "#2b2a28", accent: "#c4572f" },
    type: { heading: "Be Vietnam Pro", body: "Be Vietnam Pro" },
    juice: {
      enter: ["fade", "slide-up", "scale"],
      exit: "fade",
      transition: { kind: "fade", durationMs: 500 },
    },
  },
  {
    id: "y2k-liquid-chrome",
    name: "Y2K Liquid Chrome",
    family: "aesthetic",
    energy: 4,
    bestFor: ["fashion-drop", "music-promo", "youth-brand", "social-cut"],
    summary:
      "Turn-of-millennium chrome; liquid metal type, iridescent bubbles, lens flares, glossy swooshes on bright skies.",
    bpm: [112, 128],
    palette: { background: "#dfe8ff", foreground: "#101422", accent: "#ff5cd6" },
    type: { heading: "Space Grotesk", body: "Space Grotesk" },
    juice: {
      enter: ["pop", "slide-up", "scale", "slide-left"],
      exit: "scale",
      transition: { kind: "fade", durationMs: 250 },
    },
  },
] as const satisfies readonly MotionStyleProfile[];
