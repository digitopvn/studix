import type { MotionPreset, SceneTransition } from "@studix/video-ir";

/**
 * Motion style profiles: presets that lock the palette, type, pacing and juice of a motion graphic. Ported from
 * the pinned agentkit motion-video style library: its "aesthetic" family, a curated set of the neutral
 * signature profiles (see the signature-motion-styles knowledge pack; brand aliases are never ported) and the
 * glass-keynote house profile. Each profile is a look description, an energy level (1 calm .. 5 frantic), the
 * tempo range its cuts follow, the three palette roles the template maps onto the brand-free fallback palette,
 * the bundled font pair it sets type in (every family has a Vietnamese subset), its pacing (the entrances a
 * card may use, the exit and the cut between cards) and its juice (an accent-filled call to action, a whoosh
 * on each cut). A brief's own brand kit still wins over the palette and fonts.
 */
export type MotionStyleFamily = "aesthetic" | "signature" | "house";

/** A card entrance (`none` is never a style's choice). */
export type MotionEnter = Exclude<MotionPreset, "none">;

export interface MotionStylePacing {
  /** Entrances a card may use; the first is the default, and any other choice is replaced by it. */
  enters: readonly [MotionEnter, ...MotionEnter[]];
  exit: MotionPreset;
  /** The cut between cards. */
  transition: SceneTransition;
}

export interface MotionStyleJuice {
  /** The call-to-action card is filled with the accent instead of the shared background. */
  ctaFill: boolean;
  /** A soft whoosh on each cut (the CTA accent is laid either way). */
  whoosh: boolean;
}

export interface MotionStyleProfile {
  id: string;
  name: string;
  family: MotionStyleFamily;
  energy: 1 | 2 | 3 | 4 | 5;
  bestFor: readonly string[];
  summary: string;
  /** Tempo range (beats per minute) the cut rhythm follows. */
  bpm: readonly [number, number];
  palette: { background: string; foreground: string; accent: string };
  /** Bundled families (renderer `@fontsource` packages) the headings and body are set in. */
  fonts: { heading: string; body: string };
  pacing: MotionStylePacing;
  juice: MotionStyleJuice;
}

/** A profile as written below: pacing and juice default from its energy, family defaults to aesthetic. */
type Seed = Omit<MotionStyleProfile, "family" | "pacing" | "juice"> & {
  family?: MotionStyleFamily;
  pacing?: MotionStylePacing;
  juice?: Partial<MotionStyleJuice>;
};

const VN = "Be Vietnam Pro";
const INTER = "Inter";
const SERIF = "Playfair Display";
const CONDENSED = "Oswald";
const GROTESK = "Space Grotesk";
const JAKARTA = "Plus Jakarta Sans";
const MONO = "JetBrains Mono";
const fonts = (heading: string, body: string) => ({ heading, body });

/** Pacing an energy level calls for when a profile sets none: calm fades .. hard pops. */
function pacingFor(energy: number): MotionStylePacing {
  if (energy <= 2)
    return { enters: ["fade", "slide-up"], exit: "fade", transition: { kind: "fade", durationMs: 500 } };
  if (energy === 3)
    return {
      enters: ["slide-up", "fade", "slide-left", "slide-right", "scale"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 350 },
    };
  return {
    enters: ["pop", "scale", "slide-up", "slide-down", "slide-left", "slide-right"],
    exit: "scale",
    transition: { kind: "zoom", durationMs: 250 },
  };
}

const preset = (seed: Seed): MotionStyleProfile => ({
  ...seed,
  family: seed.family ?? "aesthetic",
  pacing: seed.pacing ?? pacingFor(seed.energy),
  juice: { ctaFill: seed.energy >= 4, whoosh: seed.energy >= 2, ...seed.juice },
});

const SEEDS: readonly Seed[] = [
  {
    id: "art-deco-luxury",
    name: "Art Deco Luxury",
    energy: 2,
    bestFor: ["luxury-product", "perfume-watch-promo", "heritage-brand", "gala-event"],
    summary:
      "1920s art-deco advertisement; champagne gold on charcoal and cream, didone serifs, fan and sunray geometry, slow glints.",
    bpm: [84, 104],
    palette: { background: "#1c1b19", foreground: "#f3ead6", accent: "#c9a45c" },
    fonts: fonts(SERIF, INTER),
  },
  {
    id: "bauhaus-geometry",
    name: "Bauhaus Geometry",
    energy: 3,
    bestFor: ["explainer", "brand-promo", "concept-intro", "education"],
    summary:
      "Primary-colour circles, squares and triangles that roll, rotate and assemble into type and diagrams.",
    bpm: [96, 116],
    palette: { background: "#efe8d8", foreground: "#1a1a1a", accent: "#d62828" },
    fonts: fonts(GROTESK, INTER),
  },
  {
    id: "blueprint-engineering",
    name: "Blueprint Engineering",
    energy: 2,
    bestFor: ["architecture-explainer", "hardware-spec", "technical-deep-dive", "how-it-works"],
    summary:
      "Cyanotype blueprint sheet; white linework drawn stroke by stroke, dimension lines, callouts and exploded views.",
    bpm: [84, 104],
    palette: { background: "#0d3b6e", foreground: "#e8f1ff", accent: "#ffd166" },
    fonts: fonts(GROTESK, INTER),
  },
  {
    id: "constructivist-poster",
    name: "Constructivist Poster",
    energy: 4,
    bestFor: ["manifesto", "industry-story", "revolution-history", "launch-announcement"],
    summary:
      "Constructivist photomontage; red, black and cream, bold diagonals, condensed type, wedges driving into frame.",
    bpm: [112, 132],
    palette: { background: "#efe6d2", foreground: "#141414", accent: "#c8102e" },
    fonts: fonts(CONDENSED, INTER),
  },
  {
    id: "data-editorial",
    name: "Data Editorial",
    energy: 2,
    bestFor: ["data-story", "report-launch", "research-explainer", "benchmarks"],
    summary:
      "Newsroom data story; charts build on narration, annotations point at the story and numbers carry the headline.",
    bpm: [84, 104],
    palette: { background: "#fbf9f4", foreground: "#1b1b1b", accent: "#d1495b" },
    fonts: fonts(SERIF, INTER),
  },
  {
    id: "groovy-seventies",
    name: "Groovy Seventies",
    energy: 3,
    bestFor: ["culture-story", "food-promo", "lifestyle-promo", "nostalgia-campaign"],
    summary:
      "1970s groovy print; mustard, rust and avocado, bulbous display serifs, wavy stripes, warm riso grain.",
    bpm: [96, 116],
    palette: { background: "#f5e6c8", foreground: "#3b2416", accent: "#d35f1f" },
    fonts: fonts(SERIF, VN),
  },
  {
    id: "holographic-hud",
    name: "Holographic HUD",
    energy: 3,
    bestFor: ["ai-product", "security-tool", "tech-launch", "analytics-promo"],
    summary:
      "Translucent cyan heads-up display; targeting rings, scanning sweeps, data readouts locking onto the subject.",
    bpm: [100, 122],
    palette: { background: "#030b17", foreground: "#d9f6ff", accent: "#35e0ff" },
    fonts: fonts(GROTESK, INTER),
  },
  {
    id: "ink-woodblock",
    name: "Ink Woodblock",
    energy: 2,
    bestFor: ["culture-history", "heritage-brand", "philosophy-explainer", "calm-promo"],
    summary:
      "East Asian ink and woodblock; brush strokes on rice paper, vermilion seals, misty layered mountains, slow unfurling.",
    bpm: [64, 88],
    palette: { background: "#efe6d4", foreground: "#151311", accent: "#c0301f" },
    fonts: fonts(SERIF, VN),
  },
  {
    id: "isometric-systems",
    name: "Isometric Systems",
    energy: 2,
    bestFor: ["architecture-explainer", "platform-overview", "infra-product", "onboarding"],
    summary:
      "Clean isometric world; systems as blocks and tiles, data flowing along iso paths, calm builds and axis pans.",
    bpm: [88, 104],
    palette: { background: "#eef2f8", foreground: "#1e2a3b", accent: "#3b6cff" },
    fonts: fonts(JAKARTA, INTER),
  },
  {
    id: "kinetic-typography",
    name: "Kinetic Typography",
    energy: 4,
    bestFor: ["manifesto", "announcement", "social-cut", "launch-teaser"],
    summary:
      "Words are the visuals; giant type synced to every spoken word, masks, fills, stacks and rhythmic cuts.",
    bpm: [100, 128],
    palette: { background: "#0e0e0e", foreground: "#f4f1ea", accent: "#ff4d00" },
    fonts: fonts(VN, VN),
  },
  {
    id: "manga-ink",
    name: "Manga Ink",
    energy: 5,
    bestFor: ["hype-launch", "story-promo", "youth-brand", "social-cut"],
    summary:
      "Black-and-white manga pages; brush ink, screentone, speed lines, diagonal panels and impact frames.",
    bpm: [128, 150],
    palette: { background: "#f7f4ec", foreground: "#0a0a0a", accent: "#e8132b" },
    fonts: fonts(CONDENSED, VN),
  },
  {
    id: "mid-century-retro",
    name: "Mid-Century Retro",
    energy: 4,
    bestFor: ["product-promo", "business-explainer", "sports-promo", "science-story"],
    summary:
      "1950s ad and atomic-age print; wood-type slabs, starbursts, teal-orange-cream halftone, optimistic bounce.",
    bpm: [110, 128],
    palette: { background: "#f4ead2", foreground: "#1f1b16", accent: "#d93a2b" },
    fonts: fonts(CONDENSED, VN),
  },
  {
    id: "monochrome-luxury",
    name: "Monochrome Luxury",
    energy: 1,
    bestFor: ["luxury-brand", "premium-launch", "lookbook", "brand-manifesto"],
    summary:
      "Black and ivory fashion-house film; high-contrast serif type, slow reveals, light sweeps and long holds.",
    bpm: [60, 84],
    palette: { background: "#0a0a0a", foreground: "#f4efe6", accent: "#c8b79a" },
    fonts: fonts(SERIF, INTER),
  },
  {
    id: "neo-brutalist-web",
    name: "Neo Brutalist Web",
    energy: 4,
    bestFor: ["indie-launch", "startup-promo", "social-cut", "changelog"],
    summary:
      "Loud flat blocks, thick black borders, hard offset shadows, raw system type and snappy stamp-in motion.",
    bpm: [120, 140],
    palette: { background: "#fffdf5", foreground: "#000000", accent: "#ff5c00" },
    fonts: fonts(GROTESK, GROTESK),
  },
  {
    id: "neon-cyberpunk",
    name: "Neon Cyberpunk",
    energy: 5,
    bestFor: ["gaming-launch", "hype-promo", "web3-launch", "music-promo"],
    summary:
      "Rain-slick neon night; magenta and cyan glow signs, chromatic glitch cuts and bass-driven pulses.",
    bpm: [128, 150],
    palette: { background: "#07040f", foreground: "#f2eaff", accent: "#ff2bd6" },
    fonts: fonts(CONDENSED, GROTESK),
  },
  {
    id: "newsprint-editorial",
    name: "Newsprint Editorial",
    energy: 4,
    bestFor: ["news-explainer", "ai-tech-explainer", "announcement", "editorial-feature"],
    summary:
      "Mid-century front-page feature; condensed headlines, heavy halftone, deep red and mustard on cream, stamp slams.",
    bpm: [108, 128],
    palette: { background: "#f1e8d4", foreground: "#1b1916", accent: "#b3201c" },
    fonts: fonts(SERIF, INTER),
  },
  {
    id: "organic-biomorphic",
    name: "Organic Biomorphic",
    energy: 2,
    bestFor: ["wellness-brand", "sustainability", "ai-assistant", "brand-story"],
    summary:
      "Living fluid forms; morphing blobs, soft gradients, growing tendrils, breathing motion and natural calm.",
    bpm: [70, 92],
    palette: { background: "#f4f1ea", foreground: "#1f2a24", accent: "#2f8f6b" },
    fonts: fonts(JAKARTA, JAKARTA),
  },
  {
    id: "paper-cut-collage",
    name: "Paper Cut Collage",
    energy: 3,
    bestFor: ["brand-story", "community-promo", "explainer", "creative-promo"],
    summary:
      "Handmade collage; torn paper, cut-out photos, tape and stickers, layered shadows, stop-motion jitter.",
    bpm: [92, 110],
    palette: { background: "#f3ead8", foreground: "#231f1a", accent: "#e4572e" },
    fonts: fonts(JAKARTA, VN),
  },
  {
    id: "pixel-arcade",
    name: "Pixel Arcade",
    energy: 4,
    bestFor: ["game-launch", "gamified-feature", "dev-community", "social-cut"],
    summary:
      "8/16-bit game screens; chunky pixels, stepped motion, score counters, level-clear irises and power-up pops.",
    bpm: [120, 140],
    palette: { background: "#1a1c2c", foreground: "#f4f4f4", accent: "#ffcd75" },
    fonts: fonts(MONO, GROTESK),
  },
  {
    id: "punk-zine",
    name: "Punk Zine",
    energy: 5,
    bestFor: ["counterculture-story", "music-promo", "manifesto", "community-promo"],
    summary:
      "Photocopied DIY zine; ransom-note letters, black and white plus one fluorescent, staples, hard jump cuts.",
    bpm: [150, 180],
    palette: { background: "#f2f0ea", foreground: "#0d0d0d", accent: "#ff2e88" },
    fonts: fonts(CONDENSED, GROTESK),
  },
  {
    id: "retro-crt-broadcast",
    name: "Retro CRT Broadcast",
    energy: 3,
    bestFor: ["retro-promo", "nostalgia-campaign", "announcement", "explainer"],
    summary:
      "Late-night analogue TV; scanlines, phosphor glow, channel-change static, lower thirds and test cards.",
    bpm: [84, 100],
    palette: { background: "#0b0d0a", foreground: "#e8f5d0", accent: "#ffb000" },
    fonts: fonts(MONO, GROTESK),
  },
  {
    id: "saas-bento",
    name: "SaaS Bento",
    energy: 3,
    bestFor: ["feature-tour", "saas-launch", "changelog", "product-overview"],
    summary:
      "Rounded bento-grid feature tiles that expand, reflow and swap content; clean SaaS landing-page motion.",
    bpm: [104, 122],
    palette: { background: "#f5f6f8", foreground: "#0f172a", accent: "#6366f1" },
    fonts: fonts(JAKARTA, INTER),
  },
  {
    id: "soft-clay-3d",
    name: "Soft Clay 3D",
    energy: 3,
    bestFor: ["app-onboarding", "friendly-feature", "kids-edu", "explainer"],
    summary:
      "Squishy pastel 3D; rounded clay objects, soft shadows, bouncy squash-and-stretch, friendly toy-like scenes.",
    bpm: [96, 116],
    palette: { background: "#fdf1e7", foreground: "#3a2e39", accent: "#ff8a5b" },
    fonts: fonts(JAKARTA, JAKARTA),
  },
  {
    id: "swiss-kinetic-editorial",
    name: "Swiss Kinetic Editorial",
    energy: 3,
    bestFor: ["explainer", "editorial-promo", "brand-manifesto", "event-announcement"],
    summary:
      "Strict modular grid, huge flush-left grotesk type, red accent bars and hard-snapping horizontal wipes.",
    bpm: [110, 124],
    palette: { background: "#f2f0eb", foreground: "#111111", accent: "#e30613" },
    fonts: fonts(INTER, INTER),
  },
  {
    id: "terminal-ops",
    name: "Terminal Ops",
    energy: 3,
    bestFor: ["cli-launch", "developer-tool", "devops-explainer", "changelog"],
    summary:
      "Full-frame terminal session; typed commands, streaming logs, status glyphs and cursor-driven cuts.",
    bpm: [100, 120],
    palette: { background: "#0c0f0a", foreground: "#d7e0d0", accent: "#39ff88" },
    fonts: fonts(MONO, MONO),
  },
  {
    id: "vaporwave-memphis",
    name: "Vaporwave Memphis",
    energy: 3,
    bestFor: ["creative-promo", "music-promo", "brand-promo", "social-cut"],
    summary:
      "Pastel dreamscape; neon grid horizon, sliced sun, retro OS windows, Memphis squiggles and floating shapes.",
    bpm: [80, 100],
    palette: { background: "#2b1055", foreground: "#fff4fb", accent: "#ff71ce" },
    fonts: fonts(GROTESK, VN),
  },
  {
    id: "wpa-screenprint",
    name: "WPA Screenprint",
    energy: 2,
    bestFor: ["history-story", "public-service", "travel-promo", "civic-explainer"],
    summary:
      "1930s silkscreen poster; muted 3-colour flat layers, stencil caps, slow layered parallax landscapes.",
    bpm: [76, 96],
    palette: { background: "#eadfc6", foreground: "#2b2a28", accent: "#c4572f" },
    fonts: fonts(CONDENSED, INTER),
  },
  {
    id: "y2k-liquid-chrome",
    name: "Y2K Liquid Chrome",
    energy: 4,
    bestFor: ["fashion-drop", "music-promo", "youth-brand", "social-cut"],
    summary:
      "Turn-of-millennium chrome; liquid metal type, iridescent bubbles, lens flares, glossy swooshes on bright skies.",
    bpm: [112, 128],
    palette: { background: "#dfe8ff", foreground: "#101422", accent: "#ff5cd6" },
    fonts: fonts(GROTESK, VN),
  },
  // Signature and house profiles: product and tech films, each with its own pacing and juice.
  {
    id: "cinematic-product-launch",
    name: "Cinematic Product Launch",
    family: "signature",
    energy: 2,
    bestFor: ["flagship-launch", "premium-feature", "brand-promo", "product-reveal"],
    summary:
      "Restrained premium product film; one centred hero, lots of air, continuous eased motion, quiet music.",
    bpm: [90, 110],
    palette: { background: "#000000", foreground: "#f2f1ee", accent: "#4a86ff" },
    fonts: fonts(INTER, INTER),
    pacing: {
      enters: ["fade", "slide-up", "scale"],
      exit: "fade",
      transition: { kind: "fade", durationMs: 600 },
    },
    juice: { whoosh: false },
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
    palette: { background: "#070817", foreground: "#f5f3ff", accent: "#a78bfa" },
    fonts: fonts(JAKARTA, VN),
    pacing: {
      enters: ["slide-up", "scale", "fade"],
      exit: "fade",
      transition: { kind: "zoom", durationMs: 400 },
    },
  },
  {
    id: "keynote-stage",
    name: "Keynote Stage",
    family: "signature",
    energy: 2,
    bestFor: ["product-launch", "announcement", "stats-reveal", "event-recap"],
    summary:
      "Live-stage presentation feel; black stage, one giant word or number per slide, builds and shared-element morphs.",
    bpm: [80, 100],
    palette: { background: "#000000", foreground: "#ffffff", accent: "#f5821f" },
    fonts: fonts(INTER, INTER),
    pacing: {
      enters: ["fade", "scale", "slide-up"],
      exit: "fade",
      transition: { kind: "fade", durationMs: 500 },
    },
    juice: { whoosh: false },
  },
  {
    id: "minimal-future-product",
    name: "Minimal Future Product",
    family: "signature",
    energy: 2,
    bestFor: ["hardware-launch", "vehicle-reveal", "spec-sheet", "future-product"],
    summary:
      "Stark futurist product film; graphite void, wide-tracked caps, slow orbit reveals and silent spec reads.",
    bpm: [70, 95],
    palette: { background: "#1b1d24", foreground: "#ffffff", accent: "#e5502e" },
    fonts: fonts(GROTESK, INTER),
    pacing: { enters: ["fade", "slide-up"], exit: "fade", transition: { kind: "wipe", durationMs: 600 } },
    juice: { whoosh: false },
  },
  {
    id: "premium-ui-demo",
    name: "Premium UI Demo",
    family: "signature",
    energy: 2,
    bestFor: ["app-demo", "feature-walkthrough", "onboarding", "ui-reveal"],
    summary:
      "Light, spring-driven interface demo; floating rounded panels, soft depth, taps that zoom and sheets that rise.",
    bpm: [90, 110],
    palette: { background: "#f2f1ee", foreground: "#1a1b1f", accent: "#3b74f2" },
    fonts: fonts(INTER, INTER),
    pacing: {
      enters: ["slide-up", "scale", "fade"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 450 },
    },
  },
  {
    id: "precision-dark-product",
    name: "Precision Dark Product",
    family: "signature",
    energy: 3,
    bestFor: ["saas-product", "dev-tool", "feature-launch", "changelog"],
    summary:
      "Crisp dark product UI; near-black, hairline borders, soft top glows, snappy keyboard-driven list and command moves.",
    bpm: [110, 128],
    palette: { background: "#0a0a0d", foreground: "#f5f5f3", accent: "#6d5fd0" },
    fonts: fonts(INTER, INTER),
    pacing: { enters: ["slide-up", "fade"], exit: "fade", transition: { kind: "fade", durationMs: 300 } },
  },
  {
    id: "product-spec-film",
    name: "Product Spec Film",
    family: "signature",
    energy: 2,
    bestFor: ["hardware-spec", "architecture-reveal", "engineering-story", "feature-deep-dive"],
    summary:
      "Engineering showcase; exploded layers, x-ray linework, leader-line callouts and precise spec numbers on graphite.",
    bpm: [70, 95],
    palette: { background: "#0b0c0e", foreground: "#e6e6e2", accent: "#74b0f7" },
    fonts: fonts(GROTESK, INTER),
    pacing: { enters: ["fade", "scale"], exit: "fade", transition: { kind: "fade", durationMs: 700 } },
    juice: { whoosh: false },
  },
  {
    id: "gradient-fintech",
    name: "Gradient Fintech",
    family: "signature",
    energy: 3,
    bestFor: ["fintech", "api-product", "developer-platform", "growth-story"],
    summary:
      "Polished developer fintech; flowing mesh gradients, slanted section edges, crisp floating cards and code.",
    bpm: [100, 120],
    palette: { background: "#f4f6fa", foreground: "#14213d", accent: "#7050e8" },
    fonts: fonts(JAKARTA, INTER),
    pacing: {
      enters: ["slide-left", "slide-up", "scale"],
      exit: "fade",
      transition: { kind: "wipe", durationMs: 600 },
    },
  },
  {
    id: "developer-workflow",
    name: "Developer Workflow",
    family: "signature",
    energy: 3,
    bestFor: ["dev-tool", "open-source", "ci-cd", "collaboration"],
    summary:
      "Code-collaboration story; dark editor, diffs, branching commit graphs, checks turning green and activity grids.",
    bpm: [100, 120],
    palette: { background: "#10131a", foreground: "#e8ecef", accent: "#4a74f0" },
    fonts: fonts(INTER, INTER),
    pacing: {
      enters: ["slide-up", "fade", "slide-left"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 350 },
    },
  },
  {
    id: "editorial-intelligence",
    name: "Editorial Intelligence",
    family: "signature",
    energy: 2,
    bestFor: ["ai-research", "safety-explainer", "thought-leadership", "product-announcement"],
    summary:
      "Thoughtful AI editorial; warm paper tones, serif headlines, hand-drawn line illustrations and measured reveals.",
    bpm: [75, 95],
    palette: { background: "#f5f0e8", foreground: "#191919", accent: "#b8683c" },
    fonts: fonts(SERIF, INTER),
    pacing: { enters: ["fade", "slide-up"], exit: "fade", transition: { kind: "fade", durationMs: 500 } },
    juice: { whoosh: false },
  },
  {
    id: "calm-workspace",
    name: "Calm Workspace",
    family: "signature",
    energy: 1,
    bestFor: ["productivity-app", "docs-tool", "knowledge-base", "thoughtful-explainer"],
    summary:
      "Quiet document workspace; off-white page, serif headings, monoline doodles, blocks that type, drag and settle.",
    bpm: [70, 95],
    palette: { background: "#fbfbfa", foreground: "#191919", accent: "#3a6fe0" },
    fonts: fonts(SERIF, INTER),
    pacing: { enters: ["fade", "slide-up"], exit: "fade", transition: { kind: "slide", durationMs: 600 } },
  },
  {
    id: "friendly-system-motion",
    name: "Friendly System Motion",
    family: "signature",
    energy: 3,
    bestFor: ["explainer", "product-feature", "how-it-works", "consumer-app"],
    summary:
      "Bright, helpful and simple; white space, cheerful primaries, bouncing dots that form shapes, rounded cards.",
    bpm: [100, 120],
    palette: { background: "#ffffff", foreground: "#22252b", accent: "#5566e8" },
    fonts: fonts(JAKARTA, JAKARTA),
    pacing: {
      enters: ["scale", "slide-up", "pop"],
      exit: "fade",
      transition: { kind: "slide", durationMs: 400 },
    },
  },
  {
    id: "joyful-pop",
    name: "Joyful Pop",
    family: "signature",
    energy: 4,
    bestFor: ["seasonal-campaign", "celebration-promo", "community-moment", "brand-anthem"],
    summary:
      "Joyful red-and-white celebration; fizzy bubbles, bubble-burst transitions, confetti and warm shared moments.",
    bpm: [105, 125],
    palette: { background: "#e8503a", foreground: "#ffffff", accent: "#f5c242" },
    fonts: fonts(SERIF, VN),
    pacing: {
      enters: ["pop", "scale", "slide-up"],
      exit: "scale",
      transition: { kind: "zoom", durationMs: 300 },
    },
  },
  {
    id: "athletic-impact",
    name: "Athletic Impact",
    family: "signature",
    energy: 5,
    bestFor: ["hype-launch", "finale", "sports-promo", "motivational"],
    summary:
      "Raw athletic hype; frame-filling condensed type, hard beat cuts, stutter frames, speed ramps and a high-vis accent.",
    bpm: [120, 150],
    palette: { background: "#000000", foreground: "#ffffff", accent: "#d4ff00" },
    fonts: fonts(CONDENSED, VN),
    pacing: {
      enters: ["pop", "scale", "slide-left", "slide-right"],
      exit: "scale",
      transition: { kind: "cut", durationMs: 0 },
    },
  },
];

export const MOTION_STYLE_PROFILES: readonly MotionStyleProfile[] = SEEDS.map(preset);
