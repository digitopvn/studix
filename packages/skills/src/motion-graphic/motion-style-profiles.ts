/**
 * Aesthetic motion style profiles, ported from the pinned agentkit motion-video style library (its
 * "aesthetic" family only; brand-inspired and house profiles are not ported). Each profile is a look
 * description, an energy level (1 calm .. 5 frantic), the tempo range its cuts follow and the three
 * palette roles the motion-graphic template maps onto the brand-free fallback palette.
 */
export interface MotionStyleProfile {
  id: string;
  name: string;
  energy: 1 | 2 | 3 | 4 | 5;
  bestFor: readonly string[];
  summary: string;
  /** Tempo range (beats per minute) the cut rhythm follows. */
  bpm: readonly [number, number];
  palette: { background: string; foreground: string; accent: string };
}

export const MOTION_STYLE_PROFILES: readonly MotionStyleProfile[] = [
  {
    id: "art-deco-luxury",
    name: "Art Deco Luxury",
    energy: 2,
    bestFor: ["luxury-product", "perfume-watch-promo", "heritage-brand", "gala-event"],
    summary:
      "1920s art-deco advertisement; champagne gold on charcoal and cream, didone serifs, fan and sunray geometry, slow glints.",
    bpm: [84, 104],
    palette: { background: "#1c1b19", foreground: "#f3ead6", accent: "#c9a45c" },
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
  },
] as const satisfies readonly MotionStyleProfile[];
