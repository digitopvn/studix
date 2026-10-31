// Ported from agentkit@9fe46997:kits/marketing/skills/ak-motion-video/references/styles/profiles/ (the 40
// brand-inspired profiles). Brand aliases are replaced by neutral style descriptions, company-named typefaces
// by open equivalents, and two names taken from design-system products by a description of the look.

/** One motion style profile: a look described along a closed set of motion-design dimensions. */
export interface SignatureMotionStyle {
  /** Kebab-case id describing the look; never a brand. */
  id: string;
  name: string;
  /** Neutral descriptions a request may use to name the style. */
  aliases: readonly string[];
  summary: string;
  /** 1 calm .. 5 frantic. */
  energy: 1 | 2 | 3 | 4 | 5;
  bestFor: readonly string[];
  character: string;
  palette: { mode: string; colors: Readonly<Record<string, string>>; rule: string };
  typography: readonly string[];
  layout: readonly string[];
  material: readonly string[];
  texture: readonly string[];
  camera: readonly string[];
  transitions: readonly string[];
  /** Tempo range (beats per minute) the cut rhythm follows. */
  bpm: readonly [number, number];
  rhythm: string;
  beatResponse: readonly string[];
  uiChoreography: readonly string[];
  diagrams: readonly string[];
  characterMotion: readonly string[];
  captions: readonly string[];
  sound: readonly string[];
  preferScenes: readonly string[];
  avoidScenes: readonly string[];
  signatureMoves: readonly string[];
  strengths: readonly string[];
  constraints: readonly string[];
  avoid: readonly string[];
  /** Ids of profiles in this pack or in the motion-graphic aesthetic library. */
  pairsWellWith: readonly string[];
}

export const SIGNATURE_MOTION_STYLES: readonly SignatureMotionStyle[] = [
  {
    id: "accelerated-compute",
    name: "Accelerated Compute",
    aliases: ["gpu keynote", "compute keynote", "acid-green circuitry", "benchmark surge"],
    summary:
      "GPU-keynote energy; black stage, acid-green circuitry, particle data streams and benchmark bars that surge.",
    energy: 4,
    bestFor: ["ai-infrastructure", "benchmark-reveal", "chip-launch", "developer-platform"],
    character:
      "Raw computational power: acid-green light races along circuit traces on a black stage, particle streams pour through the frame and benchmark bars surge past the competition. Choose it for performance claims and AI scale.",
    palette: {
      mode: "dark",
      colors: {
        bg: "#050505",
        ink: "#ffffff",
        accent: "#4cc41c",
        lime: "#a4e22b",
        steel: "#1a1a1a",
        mute: "#8c8c8c",
        cyan: "#00c2ff",
      },
      rule: "Green is the energy colour: traces, bars, highlights; cyan only for secondary data series; no other hues.",
    },
    typography: [
      "Sora 700 headlines 76 px, -0.02em; Sora 800 for 220 px benchmark numbers",
      "Roboto Mono 500 for labels, units and model names",
      "Be Vietnam Pro 600 for captions",
    ],
    layout: [
      "Headline top-left at 120/100 with green 6 px bar; hero chip or chart centre-right",
      "Benchmark charts full width, bars horizontal, value labels at bar ends",
    ],
    material: [
      "Dark steel panels #1a1a1a with 1 px green edge at 40% and inner glow",
      "Chip die render with green emissive traces",
    ],
    texture: [
      "Baked PNG circuit-trace pattern at 8% opacity",
      "Particle field from seeded rng (max 120 dots)",
      "Green bloom via one blurred duplicate layer, not per-element filters",
    ],
    camera: [
      "Push-in through the chip die (scale 1 -> 3 over 2 s, expo.in) into the next scene",
      "Low-angle tilt on hardware (rotateX 12 deg -> 0)",
    ],
    transitions: [
      "trace-through (green light runs along a circuit path, scene reveals behind it, 0.5 s)",
      "die zoom (push into the chip core)",
      "grid build (tiles light up in a seeded order over 0.4 s)",
      "hard cut on kicks",
    ],
    bpm: [120, 135],
    rhythm:
      "Keynote build: steady 4-beat scenes, accelerating to 2-beat benchmark hits, one big drop at the flagship reveal.",
    beatResponse: [
      "Circuit traces flash green along one random seeded path per kick",
      "Particle stream speed x1.6 on kick beats",
      "#pulse 1% on kick downbeats",
    ],
    uiChoreography: [
      "Benchmark bars grow from 0 with power4.out 0.9 s; ours overshoots the rival by a visible margin then label pops",
      "Terminal/log lines stream at 0.03 s per line in Roboto Mono",
      "Rack tiles multiply (1 -> 8 -> 64) in a grid on beats",
    ],
    diagrams: [
      "Node graphs with green data packets travelling along edges",
      "Layered architecture stacks that separate on z (translateZ spread 40 px each)",
    ],
    characterMotion: ["No mascot; hardware and particles are the characters"],
    captions: [
      "Dark pill rgba(5,5,5,0.78), 1 px green border, 44 px Be Vietnam Pro 600 ink; current word #a4e22b",
    ],
    sound: [
      "Driving electronic / synthwave 125-130 BPM",
      "SFX: electric surges on traces, data-chirps on counters, sub hit on drop",
    ],
    preferScenes: ["product-hero", "stats", "chart", "diagram", "terminal", "spec"],
    avoidScenes: ["testimonial", "quote"],
    signatureMoves: [
      "Green trace-through transition along a circuit path",
      "Push through the chip die into the next scene",
      "Benchmark bar surge that clears the rival",
      "Tile multiplication grid on beats (1 -> 8 -> 64)",
    ],
    strengths: ["Performance claims", "AI and infrastructure scale", "High-energy technical keynotes"],
    constraints: [
      "Green is the only energy colour",
      "Bloom via one shared blurred layer; keep filtered elements under 20",
      "Every benchmark shows units and a baseline",
    ],
    avoid: ["Pastel or warm palettes", "Soft organic shapes", "Slow lifestyle footage"],
    pairsWellWith: ["terminal-ops", "data-editorial", "holographic-hud", "precision-dark-product"],
  },
  {
    id: "ambient-intelligence",
    name: "Ambient Intelligence",
    aliases: ["ai lab minimal", "soft colour-field minimal", "calm ai interface"],
    summary:
      "Calm AI-lab minimalism; soft blurred colour fields, streaming text, generous white space and slow breathing motion.",
    energy: 2,
    bestFor: ["ai-model-launch", "research-announcement", "assistant-demo", "product-explainer"],
    character:
      "Quiet and intelligent: soft painterly colour fields breathe behind plain type, answers stream in token by token, and everything moves slowly with generous space. It feels like thinking made visible, never like a gadget.",
    palette: {
      mode: "mixed",
      colors: {
        bg: "#ffffff",
        ink: "#0d0d0d",
        accent: "#1f9e98",
        dusk: "#0b0b0f",
        peach: "#f7c8a8",
        lilac: "#c9c2f0",
        sky: "#a8d8f0",
        mute: "#8a8a96",
      },
      rule: "Near-monochrome type on white or dusk; colour only in soft blurred fields (two pastels per scene); green accent for a single cursor or state.",
    },
    typography: [
      "Inter 500 headlines 64 px, -0.02em, sentence case, left aligned",
      "Inter 400 body 30 px; Roboto Mono 400 for prompts and model output",
      "Be Vietnam Pro 500 for captions",
    ],
    layout: [
      "Left-aligned text column at x 200, max width 1100 px; colour field fills the right or background",
      "Chat surface centred, 960 px wide, rounded input bar at the bottom above the caption band",
    ],
    material: [
      "Flat white surfaces, radius 24 input bars with 1 px #e5e5e5 border",
      "No shadows except one soft 0 20 60 rgba(0,0,0,0.06) on the chat surface",
    ],
    texture: [
      "Soft painterly gradient fields baked to PNG (blurred pastel blobs), slowly translated and scaled",
      "No grain",
    ],
    camera: ["Almost static; background fields drift 40 px and scale 1.0 -> 1.08 over 10 s sine.inOut"],
    transitions: [
      "field bloom (a pastel field expands softly to fill, next scene fades up through it, 1.0 s)",
      "text dissolve (outgoing text fades per word, incoming streams in)",
      "slow cross-fade 0.8 s",
      "cut to white on section turns",
    ],
    bpm: [70, 95],
    rhythm:
      "Unhurried: long 8-beat holds while text streams, gentle 4-beat feature scenes, quiet resolution.",
    beatResponse: [
      "None visible; colour fields breathe with slow sine.inOut tweens (finite repeats sized to the hold), not on beats",
    ],
    uiChoreography: [
      "Prompt types into the input bar with typeIn() at 0.035 s per char, cursor blink via stepped opacity, finite repeats sized to the hold",
      "Response streams word by word (0.06 s per word, opacity 0 -> 1, no movement)",
      "Thinking indicator: a soft pulsing dot (scale 1 -> 1.3 -> 1, sine.inOut 0.8 s, finite repeats sized to the hold; the main timeline is paused and seeked, so never repeat -1)",
    ],
    diagrams: [
      "Minimal: thin grey lines and small rounded nodes, one path highlighted in accent, drawn with draw() 1.2 s",
      "Charts as simple monochrome bars with one coloured series",
    ],
    characterMotion: ["No mascot"],
    captions: [
      "No pill; 42 px Be Vietnam Pro 500 ink (white on dusk scenes), bottom band; current word ink, unread mute",
    ],
    sound: [
      "Ambient piano, soft synth pads, gentle textures",
      "Almost no SFX: a faint key tick while typing",
    ],
    preferScenes: ["title", "ui-demo", "feature", "quote", "diagram", "cta"],
    avoidScenes: ["montage", "terminal"],
    signatureMoves: [
      "Token-by-token streaming response",
      "Painterly colour field bloom between scenes",
      "Prompt typed into a rounded input bar",
      "Soft thinking-dot pulse before the answer",
    ],
    strengths: ["AI and research announcements", "Calm credibility", "Clear assistant demos"],
    constraints: [
      "Colour only in baked soft fields, never on type",
      "No flashes, shake or bouncy eases",
      "No logos, knot marks or product names of any AI lab",
    ],
    avoid: ["Neon sci-fi AI clichés (brains, circuits, robots)", "Dense dashboards", "Hard fast cuts"],
    pairsWellWith: ["editorial-intelligence", "calm-workspace", "premium-ui-demo", "swiss-kinetic-editorial"],
  },
  {
    id: "athletic-impact",
    name: "Athletic Impact",
    aliases: ["athletic hype", "sport hype edit", "condensed-type beat cuts"],
    summary:
      "Raw athletic hype; frame-filling condensed type, hard beat cuts, stutter frames, speed ramps and a high-vis accent.",
    energy: 5,
    bestFor: ["hype-launch", "finale", "sports-promo", "motivational"],
    character:
      "Loud, physical and certain: huge stacked uppercase words fill the frame and slam in on kicks, cuts land exactly on the beat, motion speed-ramps and stutters like sprint footage. Stark black and white with one high-vis accent.",
    palette: {
      mode: "dark",
      colors: {
        bg: "#000000",
        ink: "#ffffff",
        accent: "#d4ff00",
        red: "#ff3b1f",
        mute: "rgba(255,255,255,0.4)",
      },
      rule: "Black/white only, accent on one word or block per scene; red only for a single finale flash. Inverse white-bg scenes allowed as punches.",
    },
    typography: [
      "Anton uppercase 220-420 px, tracking -0.01em, line-height 0.85, stacked to fill width",
      "Archivo Black 40 px uppercase for small labels and numbers",
      "Words set edge to edge; one word may bleed off-frame",
    ],
    layout: [
      "Type fills 80-100% of frame width; image or product cut behind or between lines",
      "Hard off-centre crops; diagonal compositions",
      "Stats as one giant number, no chart chrome",
    ],
    material: ["Flat, high-contrast; product/athlete as cut-out PNG with no shadow"],
    texture: ["Heavy film grain baked PNG at 0.18", "Motion-blur streaks baked PNG on fast moves"],
    camera: [
      "Speed ramp: fast push (power4.in) into a freeze, then slow drift (sine.out)",
      "Shake 1.2-1.6 on slams; whip-pans of 1200 px with streak overlay",
    ],
    transitions: [
      "hard-cut on every kick",
      "slam (word scale 1.6 -> 1, power4.in 0.18 s + shake + white flash)",
      "stutter (3 frames repeated forward/back, 0.12 s)",
      "invert flash (1 frame white-on-black inverse)",
      "whip-pan with streaks",
    ],
    bpm: [120, 150],
    rhythm:
      "Builds from sparse 2-beat cuts to 1-beat and half-beat cuts; drop freezes for 4 beats of silence before the finale word.",
    beatResponse: [
      "Every kick = cut or slam",
      "Accent block flashes on snares",
      "#pulse 2% on kick downbeats during the build",
    ],
    uiChoreography: [
      "UI shown as a cut-out screen slammed in with a word; updates as hard state swaps, no easing",
    ],
    diagrams: ["Avoid; replace with a single giant number and a one-word label"],
    characterMotion: ["No mascot; cut-out figures move via speed ramps and stutters"],
    captions: [
      "Black block with 4 px accent left bar, 44 px Be Vietnam Pro 800 uppercase white; current word accent",
    ],
    sound: [
      "Hard trap, drill or drum-and-bass 120-150 BPM",
      "Dense impacts: slams, whooshes, sub drops, crowd breath; a hard stop before the finale",
    ],
    preferScenes: ["hook", "title", "montage", "stats", "product-hero", "cta", "outro"],
    avoidScenes: ["ui-demo", "diagram", "code", "terminal"],
    signatureMoves: [
      "Frame-filling stacked word slam on the kick",
      "Speed ramp into a freeze frame",
      "Three-frame stutter cut",
      "Silence drop, then one giant accent word",
    ],
    strengths: ["Maximum momentum", "Great finales and social hooks"],
    constraints: [
      "Cuts only on beats or half-beats",
      "One accent colour per scene",
      "Flashes max 1 per 2 beats",
    ],
    avoid: ["Soft pastel palettes", "Gentle cross-fades", "Dense explanatory UI"],
    pairsWellWith: ["kinetic-typography", "sport-editorial", "extreme-energy", "cinematic-product-launch"],
  },
  {
    id: "calm-workspace",
    name: "Calm Workspace",
    aliases: ["quiet document workspace", "doc workspace", "serif page with doodles"],
    summary:
      "Quiet document workspace; off-white page, serif headings, monoline doodles, blocks that type, drag and settle.",
    energy: 1,
    bestFor: ["productivity-app", "docs-tool", "knowledge-base", "thoughtful-explainer"],
    character:
      "Calm and thoughtful: a clean page on warm off-white, black ink, blocks of text that type themselves and slide into order, and simple monoline doodles that draw alongside. It feels like organised thinking.",
    palette: {
      mode: "light",
      colors: {
        bg: "#fbfbfa",
        ink: "#191919",
        mute: "#7c7a73",
        hair: "#e8e6e1",
        accent: "#3a6fe0",
        highlight: "#fbeed0",
        red: "#d4553a",
        green: "#177e5f",
      },
      rule: "Black on off-white; colour only as soft block highlights and one link blue.",
    },
    typography: [
      "Fraunces 600 headings 72 px (opsz 72), -0.01em",
      "Inter 400 body 30 px, line-height 1.5",
      "Headings left-aligned on the page column like a document",
    ],
    layout: [
      "Single page column 1100 px wide, left-aligned, generous top margin",
      "Doodle illustration to the right of the column",
      "Block handles appear in the left gutter on hover",
    ],
    material: [
      "Flat page; callout blocks with highlight fill radius 4",
      "Cards as 1 px hair-bordered rectangles radius 4",
    ],
    texture: ["None"],
    camera: ["Locked-off; page scrolls gently (translateY, sine.inOut) between sections"],
    transitions: [
      "page-scroll (page scrolls up to the next section)",
      "block-type (new block's text types in as the scene)",
      "doodle-draw (monoline doodle draws, then the page settles around it)",
      "soft fade 0.5 s",
    ],
    bpm: [70, 95],
    rhythm: "Unhurried: 8-12 beat scenes; each block action gets 2 beats; long holds on key sentences.",
    beatResponse: ["None"],
    uiChoreography: [
      "Slash menu opens under the caret (fade + 8 px drop 0.2 s), item highlighted, block converts",
      "Drag handle grabs a block, it lifts with a light shadow and slides to a new position (power2.inOut 0.5 s)",
      "Checkboxes tick with draw(); toggles unfold children with height tween",
    ],
    diagrams: [
      "Hand-drawn feeling monoline sketches: 3 px ink strokes with round caps drawn with draw()",
      "Kanban or table views assemble card by card",
    ],
    characterMotion: ["Monoline doodle figures with minimal poses; limbs change pose on twos"],
    captions: [
      "No pill; 40 px Be Vietnam Pro 500 ink on a highlight-coloured underline band, bottom band left-aligned to the page column",
    ],
    sound: ["Soft lo-fi or solo piano 70-95 BPM", "Gentle key taps and paper-soft clicks, very low density"],
    preferScenes: ["ui-demo", "feature", "quote", "title", "timeline", "outro"],
    avoidScenes: ["hook", "montage", "stats"],
    signatureMoves: [
      "Slash menu converting a block",
      "Block dragged by its handle and reordered",
      "Monoline doodle drawing beside the text",
      "Heading typing onto a blank page",
    ],
    strengths: ["Calm, trustworthy tone", "Great for writing, docs and planning tools"],
    constraints: [
      "No beat-driven motion",
      "Max 1 colour highlight per scene",
      "Doodles are original monoline art, no character likenesses",
    ],
    avoid: ["Neon or dark themes", "Fast cutting", "Heavy shadows"],
    pairsWellWith: ["premium-ui-demo", "layered-productivity", "creative-canvas", "quirky-editorial"],
  },
  {
    id: "character-comedy",
    name: "Character Comedy",
    aliases: ["mascot comedy", "gamified mascot", "streak and reward comedy"],
    summary:
      "Mascot-led comedy; a chunky rounded character with big expressions, streak counters, bouncy UI and deadpan gags.",
    energy: 5,
    bestFor: ["app-promo", "habit-product", "social-cut", "gamified-feature"],
    character:
      "A character carries the show: a chunky rounded mascot with huge eyes reacts, pleads, celebrates and stares deadpan, while bright green UI bounces and streak counters flame up. Chaotic-friendly social humour with game rewards.",
    palette: {
      mode: "light",
      colors: {
        bg: "#ffffff",
        ink: "#3a3a40",
        accent: "#45c21f",
        leaf: "#a6dd2a",
        sky: "#3a8ff0",
        flame: "#ff7f24",
        red: "#f0506a",
        gold: "#f4b93a",
        mute: "#b2b0ab",
      },
      rule: "Green is the hero colour; flame orange for streaks, gold for rewards, red only for mistakes; flat fills, no gradients.",
    },
    typography: [
      "Nunito 900 headlines 84 px, rounded, sentence case",
      "Nunito 700 UI labels 30 px uppercase for buttons",
      "Be Vietnam Pro 800 for captions",
    ],
    layout: [
      "Mascot fills 40-60% of frame, reacting beside a UI card",
      "Phone-frame UI centred for lesson demos",
    ],
    material: [
      "Chunky rounded buttons radius 16 with 0 5 0 darker bottom edge",
      "Flat vector character with no outline, 2-tone shading",
    ],
    texture: ["None; flat colour"],
    camera: [
      "Comedic snap zoom onto the mascot's face (scale 1 -> 2.2, power4.out 0.2 s) and hold",
      "Dutch tilt 6 deg for 'suspicious' beats",
    ],
    transitions: [
      "mascot wipe (character runs or slides across and reveals next scene)",
      "snap zoom cut (zoom to face, cut, zoom out on new scene)",
      "bouncy pop-swap (back.out 2)",
      "green panel slam",
    ],
    bpm: [120, 140],
    rhythm:
      "Sketch-comedy timing: fast 1-2 beat setups, a full beat of dead silence before punchlines, celebratory reward bursts.",
    beatResponse: [
      "Mascot bounces with squash 1.2/0.8 on beats during upbeat sections",
      "Reward bursts (stars, gems) on kicks",
      "Deliberate stillness on punchline beats",
    ],
    uiChoreography: [
      "Answer buttons press down 5 px and spring back; correct = green fill + ding, wrong = red shake 8 px x3",
      "Streak counter flames up (scale 1 -> 1.3 -> 1, flame sprite) and odo() increments",
      "XP and progress bars fill with an overshoot then settle",
    ],
    diagrams: ["Rare; progress paths as a winding road of round lesson nodes that light up in sequence"],
    characterMotion: [
      "Original chunky blob character, not a bird (egg-shaped body, huge eyes) with poses held on twos",
      "Expressions swapped per beat: happy, pleading, deadpan stare; eyes via .m-pupils, mouth via envKeys",
    ],
    captions: [
      "White pill with 3 px #e6e4df border and 0 4 0 bottom edge, 44 px Be Vietnam Pro 800 ink; current word green",
    ],
    sound: [
      "Bouncy upbeat pop with marimba 125-135 BPM",
      "Frequent game SFX: dings, boops, fanfare stings, record-scratch before punchlines",
    ],
    preferScenes: ["hook", "ui-demo", "feature", "stats", "cta", "outro"],
    avoidScenes: ["spec", "terminal", "code"],
    signatureMoves: [
      "Snap zoom onto the mascot's deadpan face",
      "Beat of silence before the punchline",
      "Streak counter flaming up",
      "Correct/wrong button feedback with ding or shake",
    ],
    strengths: ["Personality-driven social content", "Gamified feature demos", "Memorable humour"],
    constraints: [
      "Mascot is original and resembles no existing brand mascot",
      "Poses held on twos; expressions change on beats",
      "Flat colours only",
    ],
    avoid: ["Serious corporate tone", "Dark palettes", "Long holds without the character"],
    pairsWellWith: ["playful-game-system", "joyful-pop", "community-chaos", "playful-productivity"],
  },
  {
    id: "cinematic-product-launch",
    name: "Cinematic Product Launch",
    aliases: ["premium product film", "restrained launch film", "centred hero product film"],
    summary:
      "Restrained premium product film; one centred hero, lots of air, continuous eased motion, quiet music.",
    energy: 2,
    bestFor: ["flagship-launch", "premium-feature", "brand-promo", "product-reveal"],
    character:
      "Subtractive and exclusive: every shot carries one idea, the hero sits on the centre axis, and motion flows across scene boundaries instead of cutting. Choose it when the viewer should feel the product is special rather than just learn its features.",
    palette: {
      mode: "dark",
      colors: {
        bg: "#000000",
        ink: "#f2f1ee",
        accent: "#4a86ff",
        mute: "rgba(242,241,238,0.56)",
        hair: "rgba(242,241,238,0.12)",
      },
      rule: "3 colours max (bg, ink, accent); greys only as ink alpha steps. Light variant bg #f2f1ee, ink #1a1b1f, accent #1f5fd6.",
    },
    typography: [
      "Inter variable: 600-700 headlines at -0.03em tracking, 400 body",
      "Centred text only, one text block on stage with the hero",
      "Be Vietnam Pro 600 for captions",
    ],
    layout: [
      "Hero on the centre axis; text centred above or below, never in corners",
      "At least ~40% of the frame empty",
      "Kickers and HUD chrome off by default",
    ],
    material: [
      "Flat stage or one soft vignette; product rendered clean with soft contact shadow; no glass cards",
    ],
    texture: ["None; one background treatment for every scene, no orbs, grids or patterns"],
    camera: [
      "Slow push-ins (scale 1.00 -> 1.04 over the hold)",
      "Small travel 40-120 px, scale changes 0.92-1.08",
      "No motion behind a headline being read",
    ],
    transitions: [
      "match-move (hero moves/shrinks into next scene's slot)",
      "push along one axis",
      "scale-through (current grows past camera, next settles from 1.04)",
      "soft cross-dissolve with slight blur",
      "hard cut only at story turns, max 2 per video",
    ],
    bpm: [90, 110],
    rhythm:
      "Adaptive: intro and brand moments hold 8+ beats, feature run changes every 2-4 beats, outro decelerates into a held end card. Bands: 60-80 regal, 90-110 smooth (default), 115-123 elite.",
    beatResponse: ["Minimal: no flashes, no pulse wrapper; beats only time scene changes and reveals"],
    uiChoreography: [
      "One UI surface at a time, centred, entering with a short rise + fade (power3.out 0.6 s)",
      "Position leads, opacity/blur follow ~0.1 s later; children stagger 0.04-0.08 s with overlap",
      "Hold still at least one beat or until WE(word) after each reveal",
    ],
    diagrams: [
      "Thin hairline strokes in ink alpha, drawn with draw() on eased timing; one highlighted path in accent",
    ],
    characterMotion: ["No mascot"],
    captions: [
      "No pill; 44 px Be Vietnam Pro 600 ink with soft text shadow, centred bottom band; unread words at mute, current word ink",
    ],
    sound: [
      "One music family per series in the chosen BPM band; minimal SFX, about one soft cue (vol 0.25-0.4) per scene or fewer, with an SFX subtraction audit",
    ],
    preferScenes: ["product-hero", "feature", "ui-demo", "spec", "title", "outro"],
    avoidScenes: ["terminal", "montage"],
    signatureMoves: [
      "Match-move: the hero shrinks into its slot in the next scene",
      "Scale-through transition into a product close-up",
      "Held reveal: key element lands, then one full beat of stillness",
      "Decelerating end card on a single word",
    ],
    strengths: ["Premium perception", "Clarity of a single message", "Timeless look"],
    constraints: [
      "Max 3 palette colours plus ink alpha steps",
      "Max 2 hard cuts per video",
      "No wipe bands, kick flashes, screen pulse or mascot",
      "Every tween eased; no linear motion except opacity holds",
    ],
    avoid: ["Busy backgrounds", "Corner-placed text", "Dense feature lists in one shot"],
    pairsWellWith: ["premium-ui-demo", "product-spec-film", "precision-dark-product", "keynote-stage"],
  },
  {
    id: "cinematic-streaming",
    name: "Cinematic Streaming",
    aliases: ["streaming trailer", "dark trailer", "poster-row trailer"],
    summary:
      "Dark trailer grammar; letterboxed hero frames, red light sweeps, poster rows sliding in, a booming title hit.",
    energy: 4,
    bestFor: ["content-trailer", "series-launch", "catalogue-promo", "teaser"],
    character:
      "A binge-trailer voice: near-black frames, cinematic letterbox, slow push-ins and a single warm red accent that sweeps like projector light. Rows of poster tiles glide sideways and one title lands on a deep bass hit.",
    palette: {
      mode: "dark",
      colors: {
        bg: "#0b0b0b",
        ink: "#f4f4f4",
        accent: "#dc3a22",
        ember: "#9e2a17",
        mute: "rgba(244,244,244,0.6)",
        scrim: "rgba(0,0,0,0.72)",
      },
      rule: "Red only for the light sweep, progress bars and one title word; everything else black and ink alpha steps.",
    },
    typography: [
      "Bebas Neue display titles, 180-240 px, +0.02em tracking, uppercase",
      "Inter 500 body and metadata rows at 28 px, mute colour",
      "Be Vietnam Pro 600 for captions",
    ],
    layout: [
      "2.39:1 letterbox bars (ink-black, 138 px top/bottom) open and close per act",
      "Title lower-left third over a bottom scrim gradient; poster rows full-bleed at 16:9 tiles with 16 px gaps",
    ],
    material: [
      "Flat poster tiles, radius 6, no border; hovered tile scales 1.12 with soft black shadow 0 30 60",
    ],
    texture: ["Baked PNG film grain at 6% opacity", "Bottom-up black scrim gradient on every hero frame"],
    camera: [
      "Continuous slow push (scale 1.00 -> 1.06 over the scene, sine.inOut)",
      "Lateral dolly on poster rows (x -240 px over 3 s, power1.inOut)",
    ],
    transitions: [
      "red light sweep (skewed 30 deg red band crosses frame 0.45 s, reveals next scene)",
      "dip to black (0.3 s out, 0.2 s hold, 0.4 s in)",
      "letterbox close/open (bars meet then part)",
      "hard cut on bass hits only",
    ],
    bpm: [80, 100],
    rhythm:
      "Trailer arc: slow atmospheric build with long holds, accelerating montage cuts every 1-2 beats before the title, then silence and the title hit.",
    beatResponse: [
      "Quiet until the build; montage cuts land on kicks",
      "Title hit = one ember flash (0.25) plus scale 1.08 -> 1 expo.out and 0.3 shake",
      "No pulse wrapper",
    ],
    uiChoreography: [
      "Poster rows slide in from right with 0.06 s stagger, power3.out 0.8 s",
      "Focus tile grows 1.12 and reveals a metadata card beneath (rise 0.4 s)",
      "Red progress bar fills under the focused tile on its spoken word",
    ],
    diagrams: [
      "Rarely; if needed, thin ink lines on black with red highlighted node, drawn with draw() 1.2 s",
    ],
    characterMotion: ["No mascot"],
    captions: [
      "No pill; 44 px Be Vietnam Pro 600 ink with 0 2 12 black shadow, bottom band; current word ink, unread mute",
    ],
    sound: [
      "Cinematic trailer: low drones, risers, braams and a single low boom on the title",
      "SFX sparse: whoosh on sweeps, sub boom on hits",
    ],
    preferScenes: ["hook", "montage", "title", "product-hero", "cta", "outro"],
    avoidScenes: ["terminal", "code", "spec"],
    signatureMoves: [
      "Red light sweep transition",
      "Letterbox bars that close to black and reopen on the next act",
      "Poster row glide with a focus tile that grows and reveals metadata",
      "Title slam on one low boom after a beat of silence",
    ],
    strengths: ["Anticipation and drama", "Showing a catalogue of content", "Strong teaser openings"],
    constraints: [
      "Red used on at most one element per frame",
      "Hard cuts only on bass hits or montage kicks",
      "Every hero frame keeps the bottom scrim for title legibility",
      "No multi-note sonic signature or any studio's sound logo; one generic boom or riser",
    ],
    avoid: ["Bright or light backgrounds", "Bouncy UI easing", "Dense feature explanations"],
    pairsWellWith: [
      "cinematic-technology",
      "music-editorial",
      "cinematic-product-launch",
      "kinetic-typography",
    ],
  },
  {
    id: "cinematic-technology",
    name: "Cinematic Technology",
    aliases: ["imaging tech film", "filmmaker tech film", "anamorphic tech film"],
    summary:
      "Filmmaker-grade tech film; anamorphic light, rack-focus reveals, deep blacks and elegant thin type over imagery.",
    energy: 3,
    bestFor: ["imaging-product", "audio-product", "creator-tools", "premium-brand-film"],
    character:
      "Made by and for image-makers: deep contrasty blacks, anamorphic streaks, rack-focus pulls from foreground to product and elegant thin type that sits on top of imagery like a film credit. Crafted, sensory and cinematic.",
    palette: {
      mode: "dark",
      colors: {
        bg: "#050608",
        ink: "#f0f0f0",
        accent: "#4da3ff",
        warm: "#f2a65a",
        steel: "#2a2e35",
        mute: "rgba(240,240,240,0.55)",
      },
      rule: "Imagery carries colour, graded teal-orange; accent blue only for anamorphic streaks and a single UI highlight.",
    },
    typography: [
      "Manrope 300 headlines 64 px, +0.04em tracking, credit-like",
      "Manrope 600 for short labels; Roboto Mono 400 for camera settings (f/1.4, 1/250, ISO)",
      "Be Vietnam Pro 500 for captions",
    ],
    layout: [
      "Full-bleed imagery (stills with slow scale/pan; footage only with supplied clips and a verified HyperFrames video path); text lower-left like an end credit",
      "Letterbox 2.0:1 on film shots, full 16:9 on UI",
    ],
    material: ["Matte black product with fine specular rims", "No cards; UI shown in a thin 1 px frame"],
    texture: [
      "Baked PNG anamorphic streak sprites",
      "Fine grain 4%",
      "Bokeh plates from seeded rng circles baked to PNG",
    ],
    camera: [
      "Rack focus: foreground layer blur 0 -> 12 px while product layer 12 -> 0 over 1 s (only two filtered layers)",
      "Slow dolly-in 1.0 -> 1.05 and gentle parallax on layered plates",
    ],
    transitions: [
      "rack-focus handoff (outgoing blurs while incoming sharpens, 0.8 s)",
      "anamorphic streak wipe (horizontal blue flare crosses frame 0.35 s)",
      "shutter close (two black bars close vertically 0.25 s, open on next)",
      "dip to black",
    ],
    bpm: [85, 110],
    rhythm: "Measured film rhythm: 6-8 beat shots, a crescendo sequence of 2-beat cuts, calm held ending.",
    beatResponse: ["Minimal: streak flares on downbeats of the crescendo only", "No pulse wrapper"],
    uiChoreography: [
      "Camera/audio settings dials rotate to values with power2.out 0.8 s",
      "Settings readouts tick through values with odo()",
      "Focus-tracking box snaps onto a subject (scale 1.3 -> 1, 0.3 s) and follows it",
    ],
    diagrams: ["Sensor or signal paths as thin glowing lines", "Frequency curves drawn from envKeys"],
    characterMotion: ["No mascot"],
    captions: [
      "No pill; 42 px Be Vietnam Pro 500 ink with soft shadow, bottom band; current word ink, unread mute",
    ],
    sound: [
      "Cinematic ambient with piano and strings, or refined electronic",
      "SFX: shutter clicks, lens focus ticks, soft whooshes on streaks",
    ],
    preferScenes: ["product-hero", "montage", "feature", "quote", "title"],
    avoidScenes: ["terminal", "code", "chart"],
    signatureMoves: [
      "Rack-focus handoff between scenes",
      "Anamorphic streak wipe",
      "Focus-tracking box locking onto the subject",
      "Shutter-close cut",
    ],
    strengths: ["Imaging and audio products", "Creator credibility", "Emotional cinematic tone"],
    constraints: [
      "Max two blurred layers on screen at once",
      "Type small and elegant; no headline above 80 px",
      "Streaks and grain baked to PNG",
    ],
    avoid: ["Flat vector illustration", "Bouncy UI", "Neon palettes"],
    pairsWellWith: ["cinematic-streaming", "precision-hardware", "music-editorial", "sensory-tech"],
  },
  {
    id: "community-chaos",
    name: "Community Chaos",
    aliases: ["gamer community", "online community chaos", "sticker and meme chaos"],
    summary:
      "Loud online community; dark UI, electric blue-violet, voice rings, sticker slaps, meme zooms and chat floods.",
    energy: 5,
    bestFor: ["community-launch", "gaming", "social-feature", "youth-promo"],
    character:
      "Chaotic, funny and alive: chat floods scroll too fast to read, stickers slap onto the screen, speaking avatars glow with voice rings, and meme-style zoom punches land on the jokes. Loud but friendly, like a group call at 2 a.m.",
    palette: {
      mode: "dark",
      colors: {
        bg: "#1c1d24",
        ink: "#f1f1ee",
        mute: "#9a9aa6",
        surface: "#2a2b33",
        surface_hi: "#32333d",
        accent: "#7358ee",
        voice: "#2bb38a",
        pink: "#f0508a",
        yellow: "#e8ec5a",
        red: "#e8533a",
      },
      rule: "Dark greys with electric blue-violet lead; voice green only for speaking rings; pink and yellow for stickers and chaos.",
    },
    typography: [
      "Unbounded 800 headlines 90-140 px, tight -0.02em, may tilt -4 to 4 deg",
      "Rubik 500 body 28 px; Rubik 700 usernames coloured",
      "Meme captions: Anton uppercase white with 6 px black stroke",
    ],
    layout: [
      "Server rail left (circles), channel list, chat column; or voice grid of avatar tiles",
      "Chaos scenes: overlapping stickers, tilted cards, headline over everything",
    ],
    material: [
      "Rounded surfaces radius 8-16, flat",
      "Stickers: cut-out shapes with 6 px white outline and drop shadow",
    ],
    texture: ["Subtle noise 3% baked PNG", "Sparkle and star sprites baked PNG"],
    camera: [
      "Zoom punch 1 -> 1.35 on a face or word in 0.12 s power4.out, hold, snap back",
      "Shake 1.0-1.3 on slaps; small tilt wobble on chaos scenes",
    ],
    transitions: [
      "sticker-slap (big sticker slaps on with rotation and shake, covers, scene swaps behind)",
      "zoom-punch (punch into an element that becomes the next scene)",
      "chat-flood (messages scroll so fast they fill the frame, then clear to next)",
      "glitch-lite pixel shift 0.1 s",
    ],
    bpm: [120, 150],
    rhythm:
      "Hyper: 1-2 beat cuts in chaos sections, 4-beat breathers for feature explanation, drops on memes.",
    beatResponse: ["Voice rings pulse on beats", "Stickers wobble on kicks", "#pulse 2% on kick downbeats"],
    uiChoreography: [
      "Chat messages stream with 0.06 s stagger; mentions highlight yellow at 15%",
      "Voice tiles: speaking avatar gets 3 px voice ring pulsing via envKeys",
      "Reactions and stickers pile up with pop and random rotation from seeded rng",
    ],
    diagrams: ["Rarely; server/role trees as rounded nodes with neon accent lines"],
    characterMotion: ["Blob avatars and stickers squash and bounce; faces (dots) blink"],
    captions: [
      "Surface pill radius 12 with 2 px accent border, 42 px Be Vietnam Pro 800 ink; current word yellow",
    ],
    sound: [
      "Hyperpop, phonk or chiptune-EDM 120-150 BPM",
      "Dense: pings, join sounds (generic), slaps, deep boom hits; meme drops",
    ],
    preferScenes: ["hook", "montage", "feature", "ui-demo", "testimonial", "cta"],
    avoidScenes: ["spec", "chart", "diagram"],
    signatureMoves: [
      "Sticker slap transition",
      "Zoom punch onto a reaction",
      "Chat flood that wipes the frame",
      "Voice rings pulsing with speech",
    ],
    strengths: ["Youthful and memetic", "Great for community and gaming"],
    constraints: [
      "Chaos uses seeded rng only; same render every time",
      "Keep captions legible above chaos (captions layer on top, band clear)",
      "No brand mascot, logo or proprietary sounds",
    ],
    avoid: ["Premium restraint", "Long static holds", "Corporate greys"],
    pairsWellWith: ["playful-productivity", "pixel-arcade", "neon-cyberpunk"],
  },
  {
    id: "creative-canvas",
    name: "Creative Canvas",
    aliases: ["collaborative design canvas", "multiplayer cursors", "infinite board"],
    summary:
      "Collaborative design canvas; infinite board, labelled multiplayer cursors, selection handles, frames that zoom and snap.",
    energy: 3,
    bestFor: ["design-tool", "collaboration", "product-process", "creative-workflow"],
    character:
      "The story happens on a shared canvas: coloured cursors with name tags move in, selection boxes grab elements, frames snap to layouts and the camera zooms between artboards. It feels collaborative, crafted and a little playful.",
    palette: {
      mode: "light",
      colors: {
        bg: "#f5f5f5",
        ink: "#1e1e1e",
        mute: "#8c8c8c",
        frame: "#ffffff",
        accent: "#2f7df6",
        c1: "#d6457a",
        c2: "#e39b2d",
        c3: "#2a9d8f",
        c4: "#5b5fc7",
      },
      rule: "Neutral canvas, white frames, selection accent blue; cursor colours c1-c4 one per collaborator.",
    },
    typography: [
      "Inter 700 headlines 72 px inside frames, 400 body 28 px",
      "Inter 500 11-14 px (scaled 2x = 24 px) for frame labels and cursor tags",
      "Headlines may be edited live: caret blinks, text retyped with typeIn",
    ],
    layout: [
      "Canvas with several frames (artboards) at different positions; camera frames one at a time",
      "Frame names small above top-left of each frame",
      "Side panel strips optional at left/right edges, simplified",
    ],
    material: [
      "White frames with 1 px #e6e6e6 border, no radius",
      "Selection: 1.5 px accent outline + 8 px white square handles with accent stroke",
      "Sticky notes: flat c2 squares with slight shadow",
    ],
    texture: ["Canvas dot grid 24 px at 8% baked PNG, visible when zoomed out"],
    camera: [
      "Canvas pans and zooms between frames (power3.inOut 0.8 s), zoom range 0.4-2.0",
      "Zoom-out reveal of the whole board as a finale",
    ],
    transitions: [
      "canvas-pan (camera slides across board to the next frame)",
      "zoom-to-frame (zoom out to board then into next frame)",
      "frame-snap (elements snap into an auto-layout, back.out(1.2) 0.4 s)",
      "selection-marquee (drag box grows over scene, then scene is replaced)",
    ],
    bpm: [100, 120],
    rhythm:
      "Working rhythm: cursor actions on beats, 4-8 beats per frame, faster multi-cursor montage in the middle.",
    beatResponse: ["Cursors nudge 6 px on beats while idle", "Sticky notes drop on kicks in the montage"],
    uiChoreography: [
      "Cursors move on eased curved paths (power2.inOut), click = 0.9 scale dip",
      "Selection box draws, handles pop, element drags then snaps with a guide line flash in c1",
      "Components swap variants with a quick cross-fade; layers reorder in auto-layout",
    ],
    diagrams: ["Flow arrows as connectors between frames, drawn with draw(); whiteboard stickies and shapes"],
    characterMotion: [
      "Collaborator cursors act as characters: arrow + name-tag pill in their colour, playful chases",
    ],
    captions: ["White pill with 1 px border, radius 8, 40 px Be Vietnam Pro 600 ink; current word accent"],
    sound: ["Upbeat indie-electronic 100-120 BPM", "Soft clicks, snaps and plops; moderate density"],
    preferScenes: ["ui-demo", "feature", "diagram", "montage", "cover", "outro"],
    avoidScenes: ["terminal", "spec"],
    signatureMoves: [
      "Multiple named cursors arriving together",
      "Marquee select, drag and snap with guide flash",
      "Pan across the board between frames",
      "Zoom-out reveal of the whole canvas",
    ],
    strengths: [
      "Shows process and collaboration",
      "Playful but crafted",
      "Great for design and product tools",
    ],
    constraints: [
      "Camera moves only as canvas pan/zoom, never rotates",
      "Cursor names are fictional first names",
      "No replicas of real app toolbars or icons",
    ],
    avoid: ["Dark neon looks", "Heavy textures", "Hard beat cuts"],
    pairsWellWith: ["creative-suite", "saas-bento", "calm-workspace", "playful-productivity"],
  },
  {
    id: "creative-suite",
    name: "Creative Suite",
    aliases: ["pro creative tooling", "layer-panel workspace", "before-after creative tool"],
    summary:
      "Pro creative tooling; dark workspace panels, layer stacks, brush-mask and before/after reveals, spectral colour.",
    energy: 3,
    bestFor: ["creative-tool", "ai-generation", "editing-workflow", "portfolio"],
    character:
      "A professional studio in motion: dark panelled workspaces, layers that stack and toggle, masks painted on with a brush, before/after sliders and bursts of spectral colour when the creative result lands.",
    palette: {
      mode: "dark",
      colors: {
        bg: "#1b1b1b",
        ink: "#f0f0f0",
        mute: "#9a9a9a",
        panel: "#252525",
        panel_edge: "#323232",
        accent: "#3f8cff",
        spec_a: "#ff4d6d",
        spec_b: "#ffb000",
        spec_c: "#2ee6a6",
        spec_d: "#7a5cff",
      },
      rule: "Dark neutral UI with one blue accent; spectral colours only in artwork and result reveals.",
    },
    typography: [
      "Source Sans 3 700 headlines 72 px, 400 body 28 px",
      "Source Sans 3 600 13-16 px (scaled 24 px) panel labels",
      "Result titles may use Syne 800 for creative flair",
    ],
    layout: [
      "Workspace: artwork centre, layers panel right, tools strip left, simplified and generic",
      "Full-bleed artwork scenes between workspace scenes",
    ],
    material: [
      "Panels panel fill, 1 px panel_edge, radius 6",
      "Artwork as full-colour images with no chrome in result scenes",
    ],
    texture: [
      "Transparency checkerboard baked PNG behind isolated subjects",
      "Soft spectral gradient mesh baked PNG for result backgrounds",
    ],
    camera: [
      "Push into the artwork 1 -> 1.15 during edits",
      "Pull back to reveal the workspace around a finished piece",
    ],
    transitions: [
      "brush-mask (next scene painted on through a soft round brush path, mask baked PNG strokes, 0.8 s)",
      "before-after (vertical divider sweeps across, power2.inOut 0.9 s)",
      "layer-peel (top layer slides off to reveal next scene underneath)",
      "spectral-burst (colour gradient flash expands from centre, 0.3 s)",
    ],
    bpm: [100, 122],
    rhythm:
      "Build-then-reveal: edit steps 2-4 beats each, then a result reveal held 6-8 beats on a downbeat.",
    beatResponse: [
      "Spectral glow behind results brightens on kicks",
      "Layer thumbnails tick on beats while stacking",
    ],
    uiChoreography: [
      "Layers stack in the panel with 0.05 s stagger; visibility eye toggles hide/show artwork parts",
      "Sliders drag and the artwork updates in sync (filter or colour shifts on baked frames)",
      "Prompt field types with typeIn, then variations appear in a 2x2 grid with pop",
    ],
    diagrams: ["Node-graph style: rounded rectangles with ports, curved connectors drawn with draw()"],
    characterMotion: ["No mascot; a brush cursor circle leads mask paints"],
    captions: [
      "Dark panel pill with panel_edge border, radius 8, 40 px Be Vietnam Pro 600 ink; current word accent",
    ],
    sound: [
      "Cinematic electronic 100-122 BPM",
      "Brush swishes, soft clicks, a shimmer on reveals; moderate density",
    ],
    preferScenes: ["ui-demo", "feature", "comparison", "montage", "product-hero", "cta"],
    avoidScenes: ["terminal", "code", "spec"],
    signatureMoves: [
      "Before/after divider sweep",
      "Mask painted on with a brush stroke",
      "Layers stacking then toggling",
      "Spectral burst behind the finished artwork",
    ],
    strengths: [
      "Shows transformation clearly",
      "Pro and aspirational",
      "Great for AI image or editing tools",
    ],
    constraints: [
      "Brush masks and meshes baked to PNG",
      "Spectral colours never used on UI chrome",
      "No replicas of real app icons or panel layouts",
    ],
    avoid: ["Flat corporate pastel", "Retro pixel looks", "Hard stutter cuts"],
    pairsWellWith: ["creative-canvas", "cinematic-product-launch", "music-editorial", "organic-biomorphic"],
  },
  {
    id: "developer-workflow",
    name: "Developer Workflow",
    aliases: ["code collaboration story", "diff and commit graph", "checks turning green"],
    summary:
      "Code-collaboration story; dark editor, diffs, branching commit graphs, checks turning green and activity grids.",
    energy: 3,
    bestFor: ["dev-tool", "open-source", "ci-cd", "collaboration"],
    character:
      "The developer's day as a narrative: a branch grows off the main line, diffs add and remove lines, reviewers comment, checks tick to green and the merge lands. Warm community energy on a dark code-first stage.",
    palette: {
      mode: "dark",
      colors: {
        bg: "#10131a",
        ink: "#e8ecef",
        mute: "#808891",
        surface: "#171b24",
        border: "#2f3540",
        accent: "#4a74f0",
        add: "#3ab86e",
        del: "#ec6040",
        merge: "#b46ee8",
        warn: "#c98126",
      },
      rule: "Dark editor neutrals; green/red only for diff lines and checks, purple for merge moments, blue for links and focus.",
    },
    typography: [
      "Inter 700 headlines 72 px, 400 body 28 px",
      "Roboto Mono 400 22 px code and diffs, line numbers mute",
      "Hero headline may glow softly in merge purple on finale",
    ],
    layout: [
      "Editor or PR panel centred-left, commit graph or checks list right",
      "Activity grid as a full-width band behind stats",
    ],
    material: [
      "Surface panels radius 6, 1 px border; flat, minimal shadow",
      "Status badges as rounded pills",
    ],
    texture: ["Faint starfield or dot grid at 5% baked PNG for hero scenes"],
    camera: [
      "Scroll through code (translateY on the panel, power2.inOut)",
      "Push along the commit graph as it grows (x travel 200-400 px)",
    ],
    transitions: [
      "branch-off (a line forks from the graph and leads into the next scene)",
      "diff-scroll (panel scrolls up and next panel follows beneath)",
      "merge-join (two lines converge with a purple pulse and the scene resolves)",
      "fade 0.3 s",
    ],
    bpm: [100, 120],
    rhythm:
      "Narrative arc: setup 6-8 beat scenes, review/CI section steps every 2 beats, merge moment holds 8 beats.",
    beatResponse: [
      "Activity grid cells light on beats in a seeded pattern",
      "Checks tick on successive beats",
    ],
    uiChoreography: [
      "Diff lines slide in: additions with add background at 15%, deletions strike and collapse (height to 0)",
      "Review comments pop in as threaded cards with avatar circles",
      "CI checks list: spinner -> check drawn with draw(), staggered one per beat",
    ],
    diagrams: [
      "Commit graph: coloured branch lines with commit dots drawn with draw(), merges as curves",
      "Activity grid: 7xN squares in 5 green steps filling with seeded rng",
    ],
    characterMotion: ["No mascot; contributors shown as coloured circles with initials"],
    captions: ["Surface pill with 1 px border, radius 8, 40 px Be Vietnam Pro 600 ink; current word accent"],
    sound: [
      "Lo-fi or synthwave-lite 100-120 BPM",
      "Key taps, soft ticks per check, a warm swell on merge; moderate density",
    ],
    preferScenes: ["code", "terminal", "timeline", "stats", "feature", "outro"],
    avoidScenes: ["product-hero", "spec"],
    signatureMoves: [
      "Branch forking off and merging back with a purple pulse",
      "Checks turning green one per beat",
      "Diff lines adding and collapsing",
      "Activity grid lighting up behind a stat",
    ],
    strengths: ["Tells developer stories as narrative", "Community warmth", "Clear CI/CD visuals"],
    constraints: [
      "Diff colours only for code changes",
      "No brand mascot, logos or wordmarks",
      "Code shown must be legible at 22 px minimum",
    ],
    avoid: ["Light pastel themes", "Heavy textures", "Hype stutter cuts"],
    pairsWellWith: ["monochrome-developer", "terminal-ops", "precision-dark-product", "isometric-systems"],
  },
  {
    id: "documentary-purpose",
    name: "Documentary Purpose",
    aliases: ["outdoor documentary", "purpose-led documentary", "earthy field documentary"],
    summary:
      "Purpose-led outdoor documentary; natural imagery, earthy palette, typewriter facts and patient handheld pacing.",
    energy: 2,
    bestFor: ["mission-film", "impact-report", "sustainability-story", "founder-story"],
    character:
      "Honest and patient: long takes of landscape and people, earthy colours, facts typed out like field notes and a slightly handheld camera. It argues for a cause with evidence and restraint rather than hype.",
    palette: {
      mode: "mixed",
      colors: {
        bg: "#1f1d1a",
        ink: "#f3ede2",
        accent: "#d9632b",
        moss: "#5a6b3c",
        slate: "#43505a",
        sand: "#c9b38c",
        paper: "#efe8da",
      },
      rule: "Imagery carries colour, graded warm and muted; rust accent only for the key fact or call to act.",
    },
    typography: [
      "Fraunces 600 headlines 68 px, soft serif, sentence case",
      "Space Mono 400 for facts, dates and coordinates, typed in",
      "Be Vietnam Pro 500 for captions",
    ],
    layout: [
      "Full-bleed imagery; text lower-left or on a paper card inset. Footage needs supplied clips and a verified HyperFrames video path; otherwise use stills with slow scale/pan",
      "Field-note cards (paper, mono text) for facts, max 3 lines",
    ],
    material: ["Recycled-paper cards with torn edge mask (baked PNG)", "No gloss or glass"],
    texture: [
      "Baked PNG film grain 7%",
      "Paper fibre texture on cards",
      "Topographic contour line PNG for map scenes",
    ],
    camera: [
      "Handheld drift: seeded rng low-frequency offset 3-6 px and rotate 0.3 deg, sine-interpolated",
      "Slow push on landscapes 1.00 -> 1.04 over 6+ s",
    ],
    transitions: [
      "long cross-dissolve 1.0-1.2 s",
      "fade to paper (frame whites into a field-note card)",
      "match cut on horizon or shape",
      "cut to black before a hard fact",
    ],
    bpm: [70, 95],
    rhythm: "Patient: 8-12 beat shots, facts held long enough to read twice, a quiet resolute close.",
    beatResponse: ["None visible; music is felt, not shown"],
    uiChoreography: [
      "Facts typeIn() at 0.04 s per character on field-note cards",
      "Numbers counted with odo() slowly (2 s, power1.out)",
      "Maps reveal routes and protected areas with draw() over topo texture",
    ],
    diagrams: [
      "Hand-drawn style arrows and circles (baked stroke PNG or rough SVG paths) around subjects",
      "Simple bar charts in moss and rust on paper",
    ],
    characterMotion: ["Real people only; no mascot"],
    captions: [
      "No pill; 42 px Be Vietnam Pro 500 ink with soft black shadow, bottom band; current word #f3ede2, unread 55%",
    ],
    sound: [
      "Acoustic, ambient field recordings, sparse piano or strings",
      "SFX natural: wind, water, footsteps; no whooshes",
    ],
    preferScenes: ["hook", "montage", "stats", "quote", "testimonial", "timeline", "cta"],
    avoidScenes: ["ui-demo", "terminal", "code"],
    signatureMoves: [
      "Typewriter field-note fact card over imagery",
      "Handheld seeded drift on landscapes",
      "Cut to black before the hardest fact",
      "Route drawn over a topographic map",
    ],
    strengths: ["Mission and impact storytelling", "Credibility and sincerity", "Emotional resonance"],
    constraints: [
      "Every claim backed by a sourced fact card",
      "No whooshes, flashes or fast cuts",
      "Handheld motion only from seeded rng",
    ],
    avoid: ["Glossy tech UI", "Neon or saturated palettes", "Hype copy"],
    pairsWellWith: ["human-storytelling", "data-editorial", "paper-cut-collage", "organic-biomorphic"],
  },
  {
    id: "editorial-collage-explainer",
    name: "Editorial Collage Explainer",
    aliases: ["collage explainer", "motion collage", "editorial collage", "torn-paper explainer"],
    summary:
      "Explainer collage; torn-paper posters, halftone cut-outs, one bold flat colour per scene, pieces fly in and assemble.",
    energy: 3,
    bestFor: ["explainer", "history-story", "data-story", "brand-story"],
    character:
      "A narrated explainer built from editorial paper collage: printed photo and woodblock cut-outs with torn or scissor-cut edges, tape corners, newspaper strips and halftone dots on one bold flat colour per scene. Each scene assembles piece by piece like a poster being pasted up, then lives on as a layered page that drifts in parallax under the narration.",
    palette: {
      mode: "light",
      colors: {
        bg: "#f1e7d3",
        ink: "#1d1a17",
        accent: "#e2412b",
        mustard: "#f0b429",
        teal: "#1f7a7a",
        cobalt: "#2547a8",
        clay: "#c8875a",
        paper: "#fbf6ea",
      },
      rule: "Each scene sits on ONE bold flat colour taken from the palette; the colour travels across scenes to carry the story's mood (aged clay → bold pop → payoff gold). Cut-outs keep their printed colours; accent red is for the seal, the key number and the active word.",
    },
    typography: [
      "Archivo Black 140-220 px all-caps headlines set on torn-paper banner strips, rotated -3 to 3 deg",
      "Libre Franklin 600 subheads 52 px; Special Elite 28 px typewriter labels and dates on paper tags",
      "Headlines stay live HTML over the art, never baked into generated images",
    ],
    layout: [
      "Poster composition per scene: hero cut-out off-centre, headline banner in a clear third, 2-4 supporting scraps",
      "Foreground, midground and background paper layers with shadows growing by depth",
      "Labels and arrows taped near the subject, above the caption band",
    ],
    material: [
      "Printed cut-outs with torn or scissor-cut white borders (baked PNG)",
      "Drop shadow 0 8px 14px rgba(29,26,23,0.28) per layer, deeper layers larger",
      "Masking-tape strips and a red circular seal",
    ],
    texture: [
      "Baked halftone dots on photo cut-outs and in background corners only",
      "Newsprint strips and paper fibre grain as PNG tiles",
      "Generated art per generated-art.md with one shared style block",
    ],
    camera: [
      "One move per scene from story-and-shots.md, never the same as the neighbour",
      "Layer parallax 0.3 : 1 : 1.6 during holds",
      "Stage overscanned 1.2x for pans and whips",
    ],
    transitions: [
      "collage-assembly (pieces fly to their home positions, 0.5-0.8 s staggered, expo.out with spin resolving)",
      "paper-wipe (a torn coloured sheet slides across on a beat and the next scene is under it)",
      "whip (0.22 s expo.in out / expo.out in on the overscanned stage)",
      "cut-in (hard cut to a CLOSE of the key piece on the spoken keyword)",
    ],
    bpm: [96, 118],
    rhythm:
      "Explainer pace: each scene assembles in its first 1-1.5 s, holds while the narration explains, cuts in to a detail mid-sentence on long scenes; a calm static scene for the payoff.",
    beatResponse: [
      "Tape and seal stamps land on kick beats",
      "Confetti scraps drift continuously, denser burst on drops",
      "Halftone accent pulses 1.00-1.04 on downbeats in title scenes only",
    ],
    uiChoreography: [
      "Product UI printed on a paper card, taped onto the collage, with cut-out arrows pointing at the feature",
      "Cards slap in (scale 1.4 → 1.0, 5 frames) and settle with a 1 deg sway",
    ],
    diagrams: [
      "Paper-strip bars cut to length and pasted in order",
      "Flows as cut-out arrows and string lines drawn with draw()",
      "Maps and timelines as torn newsprint strips with stamped dates",
    ],
    characterMotion: [
      "Cut-out figures pivot on paper joints, animated on twos",
      "Hero props (a paper plane, a coin, an arrow) cross the frame on one key scene only",
    ],
    captions: [
      "Cream torn-paper strip, 42 px Be Vietnam Pro 700 ink, 0-1 deg tilt, current word accent red; bottom band",
    ],
    sound: [
      "Light hip-hop, documentary pop or plucked strings 96-118 BPM",
      "SFX: paper slide, tape pull, stamp thud, page flip; medium density",
    ],
    preferScenes: ["hook", "title", "timeline", "stats", "feature", "comparison", "quote", "outro"],
    avoidScenes: ["terminal", "code"],
    signatureMoves: [
      "Poster assembles piece by piece onto a bold flat colour",
      "Torn banner headline slapped in on the spoken keyword",
      "Mid-sentence cut-in to a detail of the collage",
      "Scene colour travels across the story",
    ],
    strengths: [
      "Turns abstract topics into tactile stories",
      "Strong scene identity with one colour each",
      "Works for history, explainers and ads",
    ],
    constraints: [
      "Flat 2D paper only: pieces move as rigid cut-outs, no 3D, no morphing",
      "Headline text is live HTML and never wobbles",
      "Halftone never on faces or product labels",
      "Jitter, confetti and sway use seeded rng",
    ],
    avoid: [
      "Glass, chrome, neon or glow",
      "Smooth CGI or photoreal renders",
      "The same camera move in two adjacent scenes",
    ],
    pairsWellWith: ["paper-cut-collage", "data-editorial", "newsprint-editorial", "documentary-purpose"],
  },
  {
    id: "editorial-intelligence",
    name: "Editorial Intelligence",
    aliases: ["thoughtful ai editorial", "warm paper editorial", "line-illustration editorial"],
    summary:
      "Thoughtful AI editorial; warm paper tones, serif headlines, hand-drawn line illustrations and measured reveals.",
    energy: 2,
    bestFor: ["ai-research", "safety-explainer", "thought-leadership", "product-announcement"],
    character:
      "Considered and humane: warm ivory paper, a literary serif headline, simple hand-drawn line illustrations that draw themselves and a clay-orange accent. It explains ideas like a well-edited essay, trusting the viewer to read.",
    palette: {
      mode: "light",
      colors: {
        bg: "#f5f0e8",
        ink: "#191919",
        accent: "#d0804e",
        clay: "#b8683c",
        oat: "#e8dfd0",
        slate: "#5f5c55",
        mute: "#8a8680",
        dark: "#23221e",
      },
      rule: "Ivory paper with near-black ink; clay orange for one highlight per scene; dark variant bg #23221e ink #f5f0e8.",
    },
    typography: [
      "Fraunces 500 headlines 72 px (soft serif, opsz 72), -0.015em, sentence case",
      "Manrope 400 body 30 px, line-height 1.45",
      "Roboto Mono 400 for code and model output; Be Vietnam Pro 500 for captions",
    ],
    layout: [
      "Essay column: headline and body left at x 180, max width 1000 px; illustration right third",
      "Pull quotes centred with generous margins",
    ],
    material: ["Paper surfaces, no glass; cards #fffdf8 radius 12 with 1 px oat border"],
    texture: [
      "Baked PNG fine paper fibre at 5%",
      "Hand-drawn line illustrations as SVG paths with slight stroke variance",
    ],
    camera: ["Locked-off; slow vertical scroll through long essays (y -300 px over a scene, power1.inOut)"],
    transitions: [
      "line draw-on (next scene's illustration draws itself, text fades up after, 0.9 s)",
      "page turn (scene slides up like scrolling a long page)",
      "ink fade (outgoing fades to paper, 0.5 s)",
      "section rule (a hairline draws across and the new section rises beneath)",
    ],
    bpm: [75, 95],
    rhythm:
      "Reading pace: holds sized to the words, 6-10 beats per idea, pull quotes held longest, calm close.",
    beatResponse: ["None visible; transitions land on downbeats only"],
    uiChoreography: [
      "Chat or product UI in a paper-toned frame; messages rise 20 px + fade (power2.out 0.5 s)",
      "Model output streams in Roboto Mono line by line, 0.08 s per line",
      "Highlights sweep behind key phrases in clay at 25% (scaleX 0 -> 1, 0.4 s)",
    ],
    diagrams: [
      "Hand-drawn line diagrams: nodes as imperfect circles, arrows drawn with draw() power1.inOut 1.2 s",
      "One clay-highlighted path; annotations in small serif italic",
    ],
    characterMotion: ["No mascot; simple line-drawn hands and objects may draw on"],
    captions: ["No pill; 42 px Be Vietnam Pro 500 ink, bottom band on paper; current word clay, unread mute"],
    sound: [
      "Warm acoustic or chamber strings, soft piano",
      "SFX nearly none: faint pencil scratch on draw-ons",
    ],
    preferScenes: ["title", "quote", "diagram", "feature", "ui-demo", "cta"],
    avoidScenes: ["montage", "stats"],
    signatureMoves: [
      "Hand-drawn illustration that draws itself before the text arrives",
      "Clay highlighter sweep behind a key phrase",
      "Essay-style scroll through a long argument",
      "Section rule transition",
    ],
    strengths: ["Explaining nuanced ideas", "Trust and thoughtfulness", "Research and policy communication"],
    constraints: [
      "One clay highlight per scene",
      "No flashes, shake, glow or sci-fi imagery",
      "No logos, marks or product names of any AI lab",
    ],
    avoid: ["Neon or dark cyber aesthetics", "Fast cutting", "Stock AI imagery (robots, brains)"],
    pairsWellWith: ["ambient-intelligence", "swiss-kinetic-editorial", "data-editorial", "calm-workspace"],
  },
  {
    id: "expressive-tonal-ui",
    name: "Expressive Tonal UI",
    aliases: ["tonal ui motion", "morphing rounded shapes", "seed-colour tonal palette"],
    summary:
      "Tonal, personal UI motion; seed-colour tonal palettes, morphing rounded shapes, container transforms, bold springs.",
    energy: 3,
    bestFor: ["mobile-app", "personalization", "feature-tour", "consumer-launch"],
    character:
      "Soft, bold and personal: every scene is tinted from one seed colour into tonal surfaces, big rounded shapes morph between squircle, pill and scalloped forms, and containers expand into full screens. Playful springs with emphasized easing.",
    palette: {
      mode: "mixed",
      colors: {
        bg: "#fcf7fc",
        ink: "#201c22",
        mute: "#4c4650",
        accent: "#7a4fa8",
        primary_container: "#f0dcfa",
        secondary_container: "#eedff5",
        tertiary: "#8a5058",
        tertiary_container: "#ffdad8",
        dark_bg: "#16131a",
      },
      rule: "Tonal system from one seed: bg, containers and accents are tones of the scene seed; reseed per chapter (e.g. teal #006a6a, orange #8b5000) with a smooth tone cross-fade.",
    },
    typography: [
      "Roboto Flex: display 96-140 px weight 700 width 125, headline 56 px weight 600",
      "Animate font-variation weight 400 -> 800 on the hero word",
      "Body 30 px weight 400; labels 22 px weight 500",
    ],
    layout: [
      "Large rounded containers filling 60-80% of the frame",
      "Phone-less UI: screens as tall rounded rectangles radius 48",
      "Decorative shapes (scallop, flower, pill) behind headlines",
    ],
    material: [
      "Flat tonal surfaces, no borders; elevation by tone step not shadow",
      "Radius 28-48 px; shapes as SVG paths for morphing",
    ],
    texture: ["None; tonal flat fills only"],
    camera: ["Locked-off; containers themselves grow toward the camera"],
    transitions: [
      "container-transform (a card expands to fill the frame and becomes the next scene, power3.inOut 0.6 s approximating emphasized easing)",
      "shape-morph (hero shape path morphs scallop -> pill -> circle, then wipes)",
      "tone-shift (background cross-fades to next seed tone 0.5 s)",
      "shared-axis z (scale 0.92 -> 1 with fade)",
    ],
    bpm: [100, 124],
    rhythm: "Bouncy but readable: 4-6 beat scenes, transforms take 1-2 beats, chapter reseed on bar starts.",
    beatResponse: [
      "Decorative shape rotates 15 deg and scales 1.04 on kicks",
      "Hero word weight bumps +100 on downbeats",
    ],
    uiChoreography: [
      "FAB-style button expands into a sheet (container transform)",
      "List rows enter with 0.04 s stagger, y 24 -> 0, back.out(1.3)",
      "Toggles and sliders use spring overshoot; selected chips fill with primary_container and accent text",
    ],
    diagrams: ["Rounded nodes as tonal pills linked by thick 6 px rounded lines, drawn with draw()"],
    characterMotion: ["Morphing blob shapes with squash on landing; no faces"],
    captions: ["Pill in primary_container, radius 28, 40 px Be Vietnam Pro 600 ink; current word accent"],
    sound: ["Warm electronic pop 100-124 BPM", "Soft plucks on morphs and bubbly taps, medium-low density"],
    preferScenes: ["ui-demo", "feature", "title", "product-hero", "cta"],
    avoidScenes: ["terminal", "code", "spec"],
    signatureMoves: [
      "Card expands into the next full scene",
      "Shape morph through scallop, pill and circle",
      "Variable font weight swelling on the hero word",
      "Chapter reseed that retints the whole scene",
    ],
    strengths: ["Warm and personal", "Great for mobile UI", "Colour system stays coherent"],
    constraints: [
      "All colours derived from the scene seed tones",
      "No hard shadows; elevation by tone",
      "Morphs need matching SVG point counts (pre-authored paths)",
    ],
    avoid: ["Neon glows", "Sharp corners", "Grainy textures"],
    pairsWellWith: ["friendly-system-motion", "premium-ui-demo", "soft-clay-3d", "joyful-pop"],
  },
  {
    id: "extreme-energy",
    name: "Extreme Energy",
    aliases: ["extreme sports edit", "adrenaline action edit", "speed-ramp action"],
    summary:
      "Adrenaline action edit; speed ramps, whip pans, impact freeze-frames and huge condensed type slamming on drops.",
    energy: 5,
    bestFor: ["event-hype", "action-edit", "sponsorship-reel", "social-cut"],
    character:
      "Pure adrenaline: speed ramps into slow-motion peaks, whip pans between shots, freeze-frames at the apex with stats stamped over them and condensed type that slams on every drop. Built for moments that defy gravity.",
    palette: {
      mode: "dark",
      colors: {
        bg: "#0a0c1f",
        ink: "#ffffff",
        accent: "#e22a36",
        gold: "#f5a623",
        navy: "#2a2352",
        mute: "rgba(255,255,255,0.6)",
      },
      rule: "Navy-black base; red for impact bars and stamps, gold for records and stats; imagery stays vivid.",
    },
    typography: [
      "Anton uppercase 200-280 px, tight -0.01em, often cropped by frame edges",
      "Archivo 700 italic for athlete/event labels",
      "Be Vietnam Pro 800 for captions",
    ],
    layout: [
      "Full-bleed action; giant type behind or in front of the subject (masked depth)",
      "Stat stamps anchored near the apex point of the action",
    ],
    material: [
      "Action imagery first (footage needs supplied clips and a verified HyperFrames video path; otherwise stills with scale/pan)",
      "Solid red and gold bars with 8 deg skew",
    ],
    texture: ["Baked PNG grain 6%", "Motion-blur streak sprites baked to PNG for whip pans"],
    camera: [
      "Speed ramp faked on stills: fast push (scale 1 -> 1.12, power4.in), near-hold at the apex, snap out (expo.out)",
      "Whip pan: x offset 0 -> -1920 px in 0.18 s expo.in with streak overlay",
      "Impact shake 1.4 decaying over 0.4 s",
    ],
    transitions: [
      "whip pan (0.18 s with streak sprite)",
      "freeze-frame punch (frame freezes, white flash 0.5, zoom 1.1)",
      "skewed red bar wipe (8 deg, 0.25 s)",
      "hard cut on every kick",
    ],
    bpm: [130, 160],
    rhythm:
      "Relentless: 1-2 beat cuts, slow-motion apex holds of 4 beats, repeated build-drop cycles, abrupt end on a final hit.",
    beatResponse: [
      "Hard cut on every kick in action runs",
      "Drops = flash 0.8 + shake 1.4 + type slam (scale 1.6 -> 1, power4.in)",
      "#pulse 1.5% on kick downbeats",
    ],
    uiChoreography: [
      "Stats stamp in (scale 2 -> 1, power4.in 0.15 s) with a red bar underneath",
      "Speed/height readouts count up rapidly during the ramp",
      "Minimal UI; any product screen appears as a quick 2-beat insert",
    ],
    diagrams: ["Trajectory lines traced over the action (draw() 0.4 s) with apex marker"],
    characterMotion: ["Real athletes only; freeze-frame cut-outs with white outline stroke"],
    captions: [
      "Red skewed bar behind text, 44 px Be Vietnam Pro 800 ink in sentence case; current word gold",
    ],
    sound: [
      "Hard electronic / drum and bass / trap 140-160 BPM",
      "Dense impact SFX: whooshes, bass hits, rewinds on speed ramps",
    ],
    preferScenes: ["hook", "montage", "stats", "title", "cta"],
    avoidScenes: ["spec", "code", "terminal", "testimonial"],
    signatureMoves: [
      "Speed ramp into a slow-motion apex",
      "Freeze-frame punch with a stamped stat",
      "Whip pan with baked streaks",
      "Giant cropped type with the subject masked in front",
    ],
    strengths: ["Hype and adrenaline", "Event and action reels", "Social attention grabs"],
    constraints: [
      "Shake and flash only on kicks and drops",
      "Streaks and grain baked to PNG",
      "Footage must be supplied or licensed and needs a verified HyperFrames video path; otherwise use stills with scale/pan",
      "No brand cans, logos or events",
    ],
    avoid: ["Slow explainers", "Pastel palettes", "Dense UI demos"],
    pairsWellWith: ["athletic-impact", "sport-editorial", "kinetic-typography"],
  },
  {
    id: "layered-productivity",
    name: "Layered Productivity",
    aliases: ["translucent layered ui", "calm productivity ui", "depth-layer productivity"],
    summary:
      "Calm layered productivity UI; soft translucent layers, depth shadows, connected element moves and decelerated entrances.",
    energy: 2,
    bestFor: ["productivity-app", "enterprise-feature", "workflow-demo", "ai-assistant"],
    character:
      "Quiet, layered and dependable: app windows float on soft tinted backdrops with translucent material, elements travel between views as connected animations, and every entrance decelerates into place. Built for clarity at work rather than spectacle.",
    palette: {
      mode: "light",
      colors: {
        bg: "#eef1f6",
        ink: "#242424",
        mute: "#616161",
        surface: "rgba(255,255,255,0.82)",
        accent: "#2a5fc4",
        accent_soft: "#d6e0fa",
        teal: "#13856f",
        purple: "#9a62b5",
        stroke: "rgba(0,0,0,0.06)",
      },
      rule: "Neutral tinted backdrop, white translucent layers, one accent; soft pastel wash gradient in the background only.",
    },
    typography: [
      "Noto Sans 600 headlines 64 px, 400 body 28 px",
      "Noto Sans 500 UI text 20-24 px; clear hierarchy, no tracking tricks",
      "Headline left, app window right",
    ],
    layout: [
      "App window 1200x760 right of centre; headline left third",
      "Up to 3 stacked layers (window, panel, flyout) with visible depth",
      "An assistant side panel may dock on the right of the window",
    ],
    material: [
      "Translucent layer: surface fill over baked blurred-colour PNG, 1 px stroke, radius 8-12",
      "Depth shadows 0 8px 16px rgba(0,0,0,0.14) for flyouts, 0 32px 64px rgba(0,0,0,0.18) for windows",
    ],
    texture: [
      "Soft pastel wash (accent_soft, purple, teal) baked PNG behind windows",
      "Subtle 2% noise baked into the translucent layer",
    ],
    camera: ["Locked-off; slight window scale 0.98 -> 1 on focus"],
    transitions: [
      "connected (element travels from its source view to its slot in the next scene, power3.out 0.5 s)",
      "entrance-slide (y 40 -> 0 + fade, power3.out 0.4 s, decelerate)",
      "drill-in (current view scales 1 -> 0.96 and fades while next scales 1.04 -> 1)",
      "fade 0.25 s for dismissals",
    ],
    bpm: [90, 110],
    rhythm: "Workmanlike: 4-8 beats per step; each UI action gets one beat of settle.",
    beatResponse: ["None; beats only time actions"],
    uiChoreography: [
      "Flyouts and menus drop 12 px from their anchor with fade, 0.2 s",
      "List rows enter with 0.03 s stagger; selection indicator pill slides between items",
      "Generated text streams in word by word with typeIn; a soft accent shimmer bar precedes it",
    ],
    diagrams: ["Rounded 8 px nodes on white layers with accent connectors, drawn with draw()"],
    characterMotion: ["No mascot"],
    captions: [
      "Translucent pill (surface + stroke), radius 12, 40 px Be Vietnam Pro 600 ink; current word accent",
    ],
    sound: ["Light corporate electronic 90-110 BPM", "Soft clicks and gentle chimes, vol 0.2, low density"],
    preferScenes: ["ui-demo", "feature", "diagram", "title", "cta"],
    avoidScenes: ["montage", "hook"],
    signatureMoves: [
      "Connected animation: an element flies from one view into the next",
      "Selection pill sliding between list items",
      "Streaming text with a shimmer lead",
      "Layered window, panel and flyout depth stack",
    ],
    strengths: ["Trustworthy enterprise tone", "Clear multi-step workflows"],
    constraints: [
      "No live backdrop blur; the translucent layer uses baked PNG",
      "Entrances decelerate, exits accelerate; nothing bounces",
      "Max 3 depth layers on screen",
    ],
    avoid: ["Hard cuts on beats", "Neon or dark hacker looks", "Brand logos or window chrome replicas"],
    pairsWellWith: ["systematic-enterprise", "calm-workspace", "premium-ui-demo", "ambient-intelligence"],
  },
  {
    id: "friendly-system-motion",
    name: "Friendly System Motion",
    aliases: ["friendly product video", "cheerful primaries", "bouncing-dot system motion"],
    summary:
      "Bright, helpful and simple; white space, cheerful primaries, bouncing dots that form shapes, rounded cards.",
    energy: 3,
    bestFor: ["explainer", "product-feature", "how-it-works", "consumer-app"],
    character:
      "Optimistic and plain-spoken: clean white backgrounds, cheerful primary colours, small dots that bounce, gather and morph into icons and charts, rounded cards that lift on interaction. Motion helps explain, never shows off.",
    palette: {
      mode: "light",
      colors: {
        bg: "#ffffff",
        ink: "#22252b",
        mute: "#62666e",
        accent: "#5566e8",
        red: "#ef5b6e",
        yellow: "#f79a2a",
        green: "#1fa88f",
        surface: "#f2f2f5",
      },
      rule: "White dominant; the primaries used together as dots and small accents, one primary leading per scene.",
    },
    typography: [
      "Outfit 600 headlines 72 px at -0.01em, 400 body 32 px",
      "Short, sentence-case headlines; one key word coloured with the scene primary",
      "Roboto Mono 22 px for small data labels",
    ],
    layout: [
      "Centred composition with lots of white; headline top, illustration centre",
      "Rounded cards in a loose 2-3 column row",
    ],
    material: [
      "Flat rounded cards radius 24, surface fill, shadow 0 2px 6px rgba(34,37,43,0.15) raising to 0 8px 24px on lift",
    ],
    texture: ["None"],
    camera: ["Locked-off; gentle scale 1 -> 1.05 on focus moments"],
    transitions: [
      "dot-morph (a mixed cluster of dots gathers centre, bounces, and expands into the next scene's shape)",
      "circle-reveal (primary-coloured circle grows from a dot to fill, next scene revealed inside)",
      "shared-axis slide (x 60 px + fade, power2.out 0.4 s)",
      "fade-through white 0.3 s",
    ],
    bpm: [100, 120],
    rhythm: "Friendly steady cadence: scenes 4-8 beats; illustrations assemble over 2 beats, then hold.",
    beatResponse: ["Dots hop 12 px on beats while idle", "No flashes or pulse"],
    uiChoreography: [
      "Cards lift (y -6, shadow grows) when focused; list items stagger in 0.05 s with power2.out",
      "Search-bar style input types text with typeIn, results fade in below",
      "Chips pop with back.out(1.6) in rotating primaries",
    ],
    diagrams: [
      "Dots travel along rounded paths between icon nodes",
      "Bar and donut charts in the primaries, grown with draw() and odo",
    ],
    characterMotion: [
      "Coloured dots of mixed sizes (not a fixed row of four) as characters: squash on landing (scaleY 0.8), bounce with power2.out/power2.in arcs",
    ],
    captions: ["White pill with light shadow, radius 24, 40 px Be Vietnam Pro 600 ink; current word accent"],
    sound: [
      "Bright acoustic-electronic pop 100-120 BPM, ukulele or marimba friendly",
      "Soft bloops on dot bounces, low density",
    ],
    preferScenes: ["feature", "diagram", "chart", "ui-demo", "title", "cta"],
    avoidScenes: ["terminal", "montage"],
    signatureMoves: [
      "A cluster of dots bounces, gathers and morphs into an icon",
      "Circle reveal growing from a single dot",
      "Search-style input typing, then result cards rising",
      "Chart built from dots that settle into bars",
    ],
    strengths: ["Approachable and clear", "Great for explainers", "Works for all audiences"],
    constraints: [
      "Use the primaries together somewhere per scene, never as full backgrounds except circle-reveal",
      "No dark mode, no gradients",
      "No product logos or brand wordmarks; no four-dot assistant mark",
    ],
    avoid: ["Edgy or aggressive cuts", "Heavy textures", "Serif display type"],
    pairsWellWith: ["expressive-tonal-ui", "premium-ui-demo", "isometric-systems", "playful-productivity"],
  },
  {
    id: "functional-playful",
    name: "Functional Playful",
    aliases: ["flat-pack explainer", "home-design wit", "room-set explainer"],
    summary:
      "Practical home-design wit; flat-pack diagrams, room sets that rearrange, blue and yellow blocks and dry humour.",
    energy: 3,
    bestFor: ["how-it-works", "home-product", "value-promo", "onboarding"],
    character:
      "Practical with a wink: pictogram-style assembly diagrams, rooms that rearrange themselves in quick top-down moves, price-tag style labels and a deadpan sense of humour. Democratic design explained without fuss.",
    palette: {
      mode: "light",
      colors: {
        bg: "#ffffff",
        ink: "#111111",
        accent: "#1f4fb0",
        yellow: "#f5b416",
        birch: "#e8d5b5",
        sage: "#b7c9a8",
        mute: "#767676",
      },
      rule: "Blue and yellow as solid blocks and tags; birch and sage for room surfaces; no gradients.",
    },
    typography: [
      "Be Vietnam Pro 800 headlines 76 px, tight -0.02em, plain and functional",
      "Be Vietnam Pro 400 body; product-name labels in 40 px 800 uppercase with price-tag style",
      "Be Vietnam Pro 700 for captions",
    ],
    layout: [
      "Room set centre as a 3/4 flat illustration; labels on yellow tags pinned to objects",
      "Instruction panels in a 2 x 2 grid with pictogram figures",
    ],
    material: [
      "Flat vector furniture with birch/sage fills and 2 px ink outline",
      "Yellow price-tag labels with a punched hole",
    ],
    texture: ["None; flat colour", "Optional baked PNG cardboard grain for flat-pack scenes"],
    camera: [
      "Top-down room plan that tilts into 3/4 view (rotateX 60 -> 20 deg, power2.inOut 1 s)",
      "Quick snap zoom to a detail (scale 1 -> 1.6, power3.out 0.4 s)",
    ],
    transitions: [
      "flat-pack fold (scene folds into a box, box slides out, next unfolds)",
      "room rearrange (objects slide to new positions to become the next scene)",
      "blue block wipe (solid blue panel sweeps left to right)",
      "tag flip (yellow tag flips to reveal next title)",
    ],
    bpm: [100, 118],
    rhythm:
      "Brisk and tidy: 3-4 beat explainer steps, short comedic pauses (1 beat of stillness) before punchlines.",
    beatResponse: [
      "Objects slide one grid cell on beats during rearranges",
      "Tag sway (rotate 4 -> -2 -> 0 deg) on kicks",
      "No flashes",
    ],
    uiChoreography: [
      "Steps appear as numbered pictogram panels: panel draws in, figure performs a single action",
      "Price or value tags drop in and swing to rest (rotate -12 -> 0, elastic.out 1, 0.5)",
      "Checklist items tick with a small yellow stamp",
    ],
    diagrams: [
      "Assembly-instruction pictograms with dashed arrows and a neutral figure",
      "Floor plans with measurement lines drawn via draw()",
    ],
    characterMotion: [
      "Neutral pictogram figure (round head, simple body) performing single actions; a small shrug for humour",
    ],
    captions: [
      "Yellow block rgba(245,180,22,0.95), radius 4, 42 px Be Vietnam Pro 700 ink; current word blue",
    ],
    sound: [
      "Light Scandinavian indie pop or whistling tune 100-115 BPM",
      "SFX: wooden knocks, hex-key clicks, box-tape rip on folds",
    ],
    preferScenes: ["hook", "feature", "diagram", "comparison", "timeline", "cta"],
    avoidScenes: ["terminal", "montage"],
    signatureMoves: [
      "Room rearranges itself into the next scene",
      "Flat-pack fold transition",
      "Assembly-pictogram steps with a neutral figure",
      "Swinging price-tag labels",
    ],
    strengths: ["How-it-works clarity", "Value and practicality", "Light humour"],
    constraints: [
      "Flat vector only, 2 px ink outlines",
      "Blue and yellow used as solid blocks, never tints",
      "No real product names, catalogue pages or logos",
    ],
    avoid: ["Luxury moodiness", "Glossy 3D", "Neon"],
    pairsWellWith: ["modular-build", "isometric-systems", "friendly-system-motion", "quirky-editorial"],
  },
  {
    id: "gradient-fintech",
    name: "Gradient Fintech",
    aliases: ["mesh-gradient fintech", "developer fintech", "slanted-section gradient"],
    summary:
      "Polished developer fintech; flowing mesh gradients, slanted section edges, crisp floating cards and code.",
    energy: 3,
    bestFor: ["fintech", "api-product", "developer-platform", "growth-story"],
    character:
      "Sophisticated and quietly energetic: a slow flowing colour mesh behind slanted section edges, crisp white cards with deep soft shadows floating in perspective, code snippets and transaction flows that animate with precision.",
    palette: {
      mode: "mixed",
      colors: {
        bg: "#f4f6fa",
        ink: "#14213d",
        mute: "#4a5468",
        navy: "#14213d",
        accent: "#7050e8",
        mesh_a: "#ff7ab8",
        mesh_b: "#ffb86b",
        mesh_c: "#9a6cf5",
        mesh_d: "#2bd9d0",
        card: "#ffffff",
      },
      rule: "Light body scenes on bg, navy for dark chapters; the four mesh colours appear only in the gradient band and small highlights.",
    },
    typography: [
      "Sora 700 headlines 72 px at -0.02em, 400 body 30 px in mute",
      "Roboto Mono 400 22 px code, navy background panels",
      "Headline left with a small accent kicker above (Sora 600 22 px)",
    ],
    layout: [
      "Slanted gradient band across the top third (skewY -8deg) behind content",
      "Cards float right in a loose perspective stack; text left",
      "Numbers large in navy with accent unit",
    ],
    material: [
      "White cards radius 12, shadow 0 50px 100px -20px rgba(20,33,61,0.22), 0 30px 60px -30px rgba(0,0,0,0.3)",
      "Navy code panels radius 12",
    ],
    texture: [
      "Mesh gradient as 4 large blurred blobs pre-rendered to PNG frames or 2 layered PNGs drifting slowly (one tween spanning the scene, or finite repeats sized to the hold; never repeat -1)",
    ],
    camera: ["Slow drift of card stack (rotateX 12 rotateY -18, parallax 20-40 px)"],
    transitions: [
      "slant-wipe (diagonal band at -8deg sweeps across, power3.inOut 0.6 s)",
      "card-stack (cards slide in from depth z -300 -> 0 with 0.08 s stagger)",
      "mesh-flow (gradient band stretches to fill then contracts into next scene)",
      "fade-up 32 px 0.4 s",
    ],
    bpm: [100, 120],
    rhythm: "Smooth confident flow: scenes 6-8 beats; card and code sequences step every 2 beats.",
    beatResponse: ["Mesh brightness lifts 5% on kicks", "Transaction dots emit on beats along flows"],
    uiChoreography: [
      "Cards enter from depth and settle into the stack; one lifts forward to become active",
      "Payment form fields fill with typeIn, button shows a spinner then a check drawn with draw()",
      "Code lines type in; the matching card updates live alongside",
    ],
    diagrams: [
      "Flows as thin accent lines between rounded nodes with dots travelling along them",
      "Globe of arcs drawn with draw() for global reach",
    ],
    characterMotion: ["No mascot"],
    captions: ["White pill with soft shadow, radius 12, 40 px Be Vietnam Pro 600 ink; current word accent"],
    sound: [
      "Smooth modern electronic 100-120 BPM",
      "Soft ticks, success chimes on checks, low-medium density",
    ],
    preferScenes: ["feature", "ui-demo", "code", "diagram", "stats", "cta"],
    avoidScenes: ["montage", "testimonial"],
    signatureMoves: [
      "Slanted gradient band sweeping across",
      "Perspective card stack with one card lifting",
      "Code typing that drives a live card update",
      "Transaction dots flowing along a network",
    ],
    strengths: ["Premium developer credibility", "Makes abstract money flows visual"],
    constraints: [
      "Mesh gradient baked to PNG, never live blurred divs",
      "Slant angle constant (-8deg) across the video",
      "Max 4 cards in a stack",
    ],
    avoid: ["Hard beat cuts", "Grain or retro textures", "Brand wordmarks"],
    pairsWellWith: ["precision-dark-product", "saas-bento", "monochrome-developer", "data-editorial"],
  },
  {
    id: "human-storytelling",
    name: "Human Storytelling",
    aliases: ["hospitality story", "warm travel story", "photo-card storytelling"],
    summary:
      "Warm, human travel story; rounded photo cards, soft coral accent, gentle parallax and handwritten-feeling pacing.",
    energy: 2,
    bestFor: ["community-story", "marketplace-promo", "testimonial-film", "brand-story"],
    character:
      "Warm and personal: rounded photo cards float over off-white paper, a coral accent points at people and places, and motion breathes like a slow story told by a host. Choose it when belonging and trust matter more than specs.",
    palette: {
      mode: "light",
      colors: {
        bg: "#fffaf6",
        ink: "#222222",
        accent: "#ef6f58",
        blush: "#ffe3dd",
        sand: "#f2e7dc",
        mute: "#717171",
        teal: "#1a9e7e",
      },
      rule: "Coral for pins, hearts and one underline per scene; teal only for positive states; photos carry the colour.",
    },
    typography: [
      "Nunito 800 headlines at 72 px, -0.01em, sentence case",
      "Nunito 400 body 30 px, mute for secondary lines",
      "Fraunces italic 500 for quotes and host names",
    ],
    layout: [
      "Asymmetric: photo card stack right, headline left at x 160",
      "Generous 120 px margins; at most two cards fully in focus",
    ],
    material: [
      "Photo cards radius 24, white 10 px border, shadow 0 20 40 rgba(34,34,34,0.12)",
      "Rounded pill chips for places and dates",
    ],
    texture: ["Subtle paper tone only (flat #fffaf6); no grain, no patterns"],
    camera: [
      "Gentle two-layer parallax (bg 20 px, cards 60 px over the scene)",
      "Slow push on portraits (scale 1.0 -> 1.05, sine.inOut)",
    ],
    transitions: [
      "card shuffle (top card slides off with 6 deg tilt, next rises from behind, power2.inOut 0.7 s)",
      "map pan (dotted route line leads the camera to the next place)",
      "soft cross-dissolve 0.6 s",
      "photo expand (card grows to full-bleed)",
    ],
    bpm: [80, 100],
    rhythm:
      "Story arc with long holds on faces (6-8 beats); quicker 2-beat card runs for place lists; slow warm outro.",
    beatResponse: [
      "Very light: map pins drop on beats with a small bounce (back.out 1.4)",
      "No flashes or shake",
    ],
    uiChoreography: [
      "Listing cards rise 40 px + fade (power2.out 0.6 s), stagger 0.1 s",
      "Heart icon pops (scale 0 -> 1.2 -> 1) and fills coral on the spoken word",
      "Date chips and rating stars fill left to right, 0.05 s stagger",
    ],
    diagrams: [
      "Dotted coral route lines drawn between map pins with draw() power1.inOut",
      "Illustrated rounded icons, 3 px stroke",
    ],
    characterMotion: [
      "Real people in photos; no mascot",
      "Hand-drawn doodle accents (hearts, arrows) drawn on with draw()",
    ],
    captions: [
      "White pill rgba(255,255,255,0.92), radius 22, 42 px Be Vietnam Pro 600 ink; current word coral",
    ],
    sound: [
      "Acoustic guitar, light percussion, warm piano",
      "Very few SFX: soft page flick on card shuffle, gentle pin tick",
    ],
    preferScenes: ["hook", "testimonial", "quote", "montage", "feature", "cta"],
    avoidScenes: ["terminal", "code", "spec", "chart"],
    signatureMoves: [
      "Card shuffle between stories",
      "Dotted route line that pans the map to the next place",
      "Heart pop on the emotional word",
      "Photo card expanding to full-bleed portrait",
    ],
    strengths: ["Trust and warmth", "Community and people stories", "Approachable marketplace explanation"],
    constraints: [
      "Every scene features a person, place or hand-made detail",
      "No hard cuts, flashes or shake",
      "Coral limited to one focal element per scene",
    ],
    avoid: ["Dark tech backgrounds", "Dense data", "Aggressive kinetic type"],
    pairsWellWith: ["documentary-purpose", "calm-workspace", "friendly-system-motion", "paper-cut-collage"],
  },
  {
    id: "immersive-console",
    name: "Immersive Console",
    aliases: ["console reveal", "deep-blue console reveal", "floating ui tiles reveal"],
    summary:
      "Console reveal drama; deep blue void, floating light particles, UI tiles gliding in 3D and a heavy bass reveal.",
    energy: 4,
    bestFor: ["game-launch", "console-ui", "entertainment-hub", "immersive-reveal"],
    character:
      "Immersive and weighty: a deep blue void full of drifting light particles, interface tiles that glide in perspective, and a slow light-edge reveal of the hardware on a bass swell. Epic but controlled.",
    palette: {
      mode: "dark",
      colors: {
        bg: "#00091a",
        ink: "#ffffff",
        accent: "#2a62e0",
        glow: "#4fb3ff",
        navy: "#001f4d",
        mute: "rgba(255,255,255,0.55)",
      },
      rule: "Blue-only world: navy to near-black gradients, glow blue for rims and focus; white for type; no warm colours.",
    },
    typography: [
      "Outfit 300 headlines 70 px, +0.02em, light and airy",
      "Outfit 600 for tile titles 30 px",
      "Be Vietnam Pro 500 for captions",
    ],
    layout: [
      "Hero centred in a deep void; UI tiles in a horizontal row in perspective (rotateY -12 deg)",
      "Headline top-centre, small; lots of vertical space",
    ],
    material: [
      "Glossy black and white shell with glowing blue rim light",
      "UI tiles radius 14 with focus ring 3 px white + blue glow",
    ],
    texture: ["Seeded light particles (max 80) drifting upward", "Baked PNG volumetric light rays"],
    camera: [
      "Slow crane up around the hero (y 80 -> 0, rotateX 8 -> 0 deg over 3 s power2.inOut)",
      "Parallax on particle layers (3 depths)",
    ],
    transitions: [
      "light-edge reveal (a bright rim traces the silhouette, then scene fills in, 0.8 s)",
      "particle dissolve (scene breaks into seeded particles and reforms)",
      "perspective glide (row of tiles slides in z, camera passes through)",
      "fade through navy",
    ],
    bpm: [90, 120],
    rhythm:
      "Epic arc: slow atmospheric opening, mid-section 2-4 beat UI and game shots, a long bass swell into the hero reveal.",
    beatResponse: [
      "Particles brighten and lift on kick beats",
      "Hero reveal = blue glow bloom (one blurred layer) plus 0.6 shake",
      "#pulse 0.6% on kick downbeats",
    ],
    uiChoreography: [
      "Tile row glides in with 0.07 s stagger (x 300 -> 0, power3.out 0.7 s)",
      "Focus ring moves tile to tile on spoken words; focused tile scales 1.08 and background art swaps with a crossfade",
      "Haptic-style ripple circles expand from button presses",
    ],
    diagrams: ["Rarely; glowing blue node lines on navy when needed"],
    characterMotion: ["No mascot; game characters only from licensed user assets"],
    captions: ["Navy pill rgba(0,9,26,0.72), radius 20, 42 px Be Vietnam Pro 500 ink; current word #4fb3ff"],
    sound: [
      "Epic hybrid orchestral / electronic with deep bass swells",
      "SFX: UI focus ticks, whoosh on glides, sub boom on the reveal",
    ],
    preferScenes: ["hook", "product-hero", "ui-demo", "montage", "title", "cta"],
    avoidScenes: ["terminal", "code", "spec"],
    signatureMoves: [
      "Light-edge silhouette reveal on a bass swell",
      "Focus ring travelling across a perspective tile row",
      "Particle dissolve between scenes",
      "Haptic ripple circles on button presses",
    ],
    strengths: ["Game and entertainment reveals", "Epic mood", "Interface browsing demos"],
    constraints: [
      "Blue-only palette, no warm hues",
      "Particles from seeded rng, max 80 on screen",
      "No third-party game art unless supplied by the user",
    ],
    avoid: ["Flat bright illustration", "Paper or clay textures", "Fast jittery cuts"],
    pairsWellWith: ["cinematic-streaming", "holographic-hud", "cinematic-technology", "neon-cyberpunk"],
  },
  {
    id: "joyful-pop",
    name: "Joyful Pop",
    aliases: ["fizzy celebration", "red-and-white celebration", "bubble-burst pop"],
    summary:
      "Joyful red-and-white celebration; fizzy bubbles, bubble-burst transitions, confetti and warm shared moments.",
    energy: 4,
    bestFor: ["seasonal-campaign", "celebration-promo", "community-moment", "brand-anthem"],
    character:
      "Effervescent optimism: a bold red field, rising bubble fizz that carries one scene into the next, bubble bursts and confetti on the happiest words. It celebrates togetherness with warmth and nostalgia.",
    palette: {
      mode: "mixed",
      colors: {
        bg: "#e8503a",
        ink: "#ffffff",
        accent: "#ffffff",
        deep: "#a8321f",
        cream: "#fff4e0",
        gold: "#f5c242",
        dark: "#1a0b0b",
      },
      rule: "Red field with white as the hero colour; cream for photo borders; gold only for sparkles and confetti.",
    },
    typography: [
      "DM Serif Display 400 headlines 88 px, warm and classic",
      "Nunito 700 for supporting lines 32 px",
      "Be Vietnam Pro 700 for captions",
    ],
    layout: [
      "Centred headline over a soft cluster of rising bubbles",
      "Instant-photo clusters of people sharing moments",
    ],
    material: [
      "Cream-bordered photo prints with slight rotation and soft shadow",
      "Glossy white bubbles and speech-bubble shapes with a soft gradient highlight",
    ],
    texture: [
      "Seeded rising bubbles (max 60 small circles)",
      "Baked PNG sparkle sprites",
      "Subtle vignette on red",
    ],
    camera: [
      "Gentle float (y 10 px, sine.inOut, finite repeats sized to the hold) on holds",
      "Lateral pan following the rising bubbles",
    ],
    transitions: [
      "bubble burst (one large bubble swells from centre and pops to reveal the next scene, 0.6 s power2.inOut)",
      "fizz rise (bubbles swell upward and cover, then clear)",
      "confetti burst cut (seeded confetti on the downbeat)",
      "photo toss (print slides away, next drops in)",
    ],
    bpm: [105, 125],
    rhythm:
      "Anthemic: warm 4-beat scenes building to a chorus-like montage of shared moments, joyful end card hold.",
    beatResponse: [
      "Bubbles accelerate on kick beats",
      "Confetti bursts on chorus downbeats",
      "Headline bump 1.03 on kicks",
    ],
    uiChoreography: [
      "Cards and photos drop in with a slight rotation and settle (back.out 1.4, 0.6 s)",
      "Numbers and messages appear inside speech-bubble shapes that pop",
      "A straight white underline bar grows under key words as they are spoken (scaleX 0 -> 1)",
    ],
    diagrams: ["Rarely; rounded red/white infographics with straight rounded connectors"],
    characterMotion: ["Real people moments; optional simple hand-drawn doodles (hearts, stars) drawn on"],
    captions: ["White pill radius 26, 44 px Be Vietnam Pro 700 in #a8321f; current word #e8503a"],
    sound: [
      "Uplifting pop anthem with claps and choir 110-120 BPM",
      "SFX: fizz and pop on bubbles, sparkle chimes on confetti",
    ],
    preferScenes: ["hook", "montage", "testimonial", "quote", "title", "cta", "outro"],
    avoidScenes: ["terminal", "code", "spec", "chart"],
    signatureMoves: [
      "Bubble burst that pops into the next scene",
      "Rising bubble fizz transition",
      "Confetti burst on the happiest word",
      "Instant-photo clusters of shared moments",
    ],
    strengths: ["Celebration and warmth", "Seasonal and community campaigns", "Emotional brand anthems"],
    constraints: [
      "No script-lettered logo imitation, bottle shapes or slogans",
      "No ribbon, wave or swoosh device sweeping across the frame",
      "Confetti and bubbles from seeded rng with fixed caps",
      "Red field or red accents in every scene",
    ],
    avoid: ["Cold tech palettes", "Dense UI", "Grungy textures"],
    pairsWellWith: ["human-storytelling", "music-editorial", "character-comedy", "paper-cut-collage"],
  },
  {
    id: "keynote-stage",
    name: "Keynote Stage",
    aliases: ["live keynote", "keynote presentation", "one word per slide stage"],
    summary:
      "Live-stage presentation feel; black stage, one giant word or number per slide, builds and shared-element morphs.",
    energy: 2,
    bestFor: ["product-launch", "announcement", "stats-reveal", "event-recap"],
    character:
      "A presenter on a dark stage clicking through slides: one enormous word, number or product per slide, bullets that build one at a time and objects that morph into their place on the next slide. Choose it when the story is a sequence of big claims delivered with confidence.",
    palette: {
      mode: "dark",
      colors: {
        bg: "#000000",
        ink: "#ffffff",
        mute: "rgba(255,255,255,0.5)",
        accent: "#f5821f",
        grad_a: "#ff6b3d",
        grad_b: "#b44cff",
        grad_c: "#3d8bff",
      },
      rule: "Black stage, white type; one gradient (grad_a -> grad_b -> grad_c at 100deg) reserved for the hero word or number per slide.",
    },
    typography: [
      "Inter 700 display 180-320 px for single words and numbers, -0.045em tracking",
      "Inter 600 slide titles 72 px; 400 body 36 px; left-aligned bullets only in build slides",
      "Hero number filled with the stage gradient via background-clip text",
    ],
    layout: [
      "One idea per slide: centred giant word, or title top-left at 160/140 with up to 3 bullets",
      "Product or screenshot centre with a single caption line under it",
      "Generous 160 px safe margins; no HUD, no kickers",
    ],
    material: [
      "Flat black stage; screenshots in thin 1 px hair frames with a soft 60 px drop glow in accent at 12%",
    ],
    texture: ["Faint radial stage spotlight baked to PNG behind the hero, 0.25 opacity"],
    camera: ["Locked-off like a projected slide", "Occasional slow push 1.00 -> 1.03 on hero slides only"],
    transitions: [
      "magic-move (shared element tweens position/scale/colour into the next slide's slot, power2.inOut 0.8 s)",
      "dissolve (0.5 s cross-fade)",
      "build (bullets appear one by one with 24 px rise, power2.out 0.4 s)",
      "push-left for chapter changes",
    ],
    bpm: [80, 100],
    rhythm:
      "Slide cadence: each claim holds 4-8 beats after it lands; builds advance on spoken words; chapter slides hold longest.",
    beatResponse: ["None on screen; beats only time slide advances and builds"],
    uiChoreography: [
      "Screenshot enters as a slide object (scale 0.94 -> 1, fade, power2.out 0.6 s)",
      "Callout labels build next to UI one at a time on W(word)",
      "UI element magic-moves out of the screenshot to become the next slide's hero",
    ],
    diagrams: [
      "Big simple charts: 2-4 bars grow with power2.out 0.8 s, value counts up with odo, winning bar in gradient",
    ],
    characterMotion: ["No mascot"],
    captions: ["No pill; 42 px Be Vietnam Pro 600 white, centred bottom band, unread words at mute"],
    sound: [
      "Warm cinematic pad or light electronic bed 80-100 BPM",
      "Near-silent SFX: a soft click on builds at vol 0.2, applause-like swell avoided",
    ],
    preferScenes: ["title", "stats", "product-hero", "feature", "comparison", "outro"],
    avoidScenes: ["terminal", "montage", "code"],
    signatureMoves: [
      "Giant gradient number that counts up and then holds",
      "Magic-move: an object glides from one slide into the next slide's layout",
      "Bullet build timed to spoken words",
      "Single-word slide held in silence before the reveal",
    ],
    strengths: [
      "Confident, legible claims",
      "Very easy to structure from a script",
      "Works with minimal assets",
    ],
    constraints: [
      "One idea per slide; max 3 bullets",
      "Gradient only on one hero element per slide",
      "No beat pulses, flashes or shake",
    ],
    avoid: ["Dense UI collages", "Decorative textures", "Fast cutting"],
    pairsWellWith: ["cinematic-product-launch", "premium-ui-demo", "data-editorial", "product-spec-film"],
  },
  {
    id: "minimal-future-product",
    name: "Minimal Future Product",
    aliases: ["ev launch", "stark futurist product film", "graphite void product"],
    summary:
      "Stark futurist product film; white or graphite void, wide-tracked caps, slow orbit reveals and silent spec reads.",
    energy: 2,
    bestFor: ["hardware-launch", "vehicle-reveal", "spec-sheet", "future-product"],
    character:
      "Engineered minimalism: the product floats in an empty void, a slow orbit reveals its silhouette, and wide-tracked uppercase labels read out specs in silence. Less cinematic warmth than a premium launch, more cold precision.",
    palette: {
      mode: "mixed",
      colors: {
        bg: "#1b1d24",
        ink: "#ffffff",
        paper: "#f4f4f4",
        graphite: "#3a3d45",
        accent: "#e5502e",
        mute: "rgba(255,255,255,0.5)",
      },
      rule: "Alternate graphite void and paper-white void by act; red only as a 2 px tick or single indicator, never a fill.",
    },
    typography: [
      "Outfit 500 uppercase, 0.25em tracking, 56 px titles",
      "Outfit 300 spec values at 120 px with 24 px uppercase unit labels",
      "Be Vietnam Pro 500 for captions",
    ],
    layout: [
      "Product centred low (60% height), horizon line at 68%",
      "Specs in a 3-column row under the hero, separated by 1 px hairlines",
      "Nothing in the top 30% except one title",
    ],
    material: ["Flat void with a single floor reflection (mirrored product at 12% opacity, gradient mask)"],
    texture: ["None; a soft horizon glow gradient baked to PNG"],
    camera: [
      "Slow orbit simulated by a 36-frame image sequence or rotateY on a flat render, 6-8 s per quarter turn",
      "Long lateral track (x 0 -> -180 px) with ease none on opacity-held shots",
    ],
    transitions: [
      "light-up (scene fades in from pure bg as a horizon line draws across)",
      "wipe along horizon (1 px line sweeps, reveals next void)",
      "invert (graphite <-> white void crossfade 0.8 s)",
      "fade to void",
    ],
    bpm: [70, 95],
    rhythm:
      "Very long holds (8-16 beats) on reveals; spec rows count in on single beats; almost no mid-scene motion.",
    beatResponse: ["None visible; beats only time spec counters and line draws"],
    uiChoreography: [
      "Touch-screen UI shown as one flat panel, elements fade in 0.4 s with 0.12 s stagger, no bounce",
      "Spec values count up with odo() in 1.2 s power2.out",
      "Hairline dividers draw left to right before values appear",
    ],
    diagrams: [
      "Single-weight 1 px outlines of the product with dimension callouts drawn with draw()",
      "Energy flow as one thin accent line",
    ],
    characterMotion: ["No mascot"],
    captions: [
      "No pill; 40 px Be Vietnam Pro 500 ink in sentence case, bottom band; current word ink, unread mute",
    ],
    sound: [
      "Ambient electronic pads, sub pulses, near-silence under specs",
      "SFX: electric whine rising on reveals, soft clicks on spec counts",
    ],
    preferScenes: ["product-hero", "spec", "title", "feature", "cta"],
    avoidScenes: ["montage", "testimonial", "terminal"],
    signatureMoves: [
      "Horizon line that draws across before the product lights up",
      "Slow orbit silhouette reveal",
      "Silent spec row counting up in thin numerals",
      "Graphite-to-white void inversion between acts",
    ],
    strengths: ["Futurist credibility", "Spec clarity", "Cold, engineered premium feel"],
    constraints: [
      "Uppercase wide-tracked labels only; no decorative type",
      "Red never used as a fill",
      "No bounce, back or elastic eases",
    ],
    avoid: ["Warm lifestyle photography", "Busy textures", "Playful motion"],
    pairsWellWith: [
      "product-spec-film",
      "precision-hardware",
      "cinematic-product-launch",
      "monochrome-luxury",
    ],
  },
  {
    id: "mission-control",
    name: "Mission Control",
    aliases: ["launch broadcast", "telemetry countdown", "mission control broadcast"],
    summary:
      "Live launch-broadcast feel; telemetry readouts, T-minus countdowns, trajectory arcs and stark white-on-black type.",
    energy: 4,
    bestFor: ["launch-event", "milestone-reveal", "deep-tech", "roadmap-story"],
    character:
      "Mission-control tension: a countdown ticks, telemetry numbers stream in monospace, a trajectory arc draws across a dark globe and the frame holds its breath before liftoff. Stark, factual and thrilling at once.",
    palette: {
      mode: "dark",
      colors: {
        bg: "#000000",
        ink: "#ffffff",
        accent: "#ffffff",
        signal: "#2a5aa8",
        amber: "#ffb000",
        mute: "rgba(255,255,255,0.45)",
        hair: "rgba(255,255,255,0.18)",
      },
      rule: "Monochrome white on black; amber only for live/hold states, blue signal only for trajectory and data lines.",
    },
    typography: [
      "Space Grotesk 500 uppercase, 0.18em tracking, 64 px titles",
      "Roboto Mono 500 for telemetry values, T-minus clock at 160 px tabular numerals",
      "Be Vietnam Pro 500 for captions",
    ],
    layout: [
      "Broadcast overlay: stage label top-left, telemetry blocks top-right and as side rails at mid-height; nothing in the caption band",
      "Hero (vehicle, globe, product) centred with thin crosshair guides",
    ],
    material: [
      "Flat; 1 px hairline boxes with corner ticks, no fills",
      "Globe as dotted sphere of seeded points",
    ],
    texture: ["Baked PNG starfield (static)", "Subtle video-feed scanline PNG at 5% on 'live camera' shots"],
    camera: [
      "Locked tracking shot that slowly tilts up (y 0 -> -200 px over 4 s, sine.in) at liftoff",
      "Slight seeded jitter (1-2 px) on 'onboard camera' scenes only",
    ],
    transitions: [
      "countdown cut (clock hits 0, white frame 2 frames, cut)",
      "stage separation (scene splits horizontally, lower half drops away 0.6 s power2.in)",
      "trajectory wipe (arc line draws across and reveals next scene)",
      "feed switch (brief signal-loss bars 0.15 s)",
    ],
    bpm: [100, 120],
    rhythm:
      "Tension build: slow T-minus holds, ticking beats, then release at liftoff into faster 2-beat telemetry scenes; calm orbit outro.",
    beatResponse: [
      "Countdown digits tick exactly on beats",
      "Telemetry values update on each beat",
      "Liftoff drop = white flash 0.6 plus 1.2 shake decaying over 1 s",
    ],
    uiChoreography: [
      "Telemetry blocks draw their hairline box first (draw() 0.3 s), then values type in with typeIn()",
      "Stage checklist rows switch HOLD (amber) -> GO (white) on spoken words",
      "Progress timeline along the top edge with event ticks (MAX-Q, MECO style labels as generic STAGE 1/2)",
    ],
    diagrams: [
      "Trajectory arcs over a dotted globe drawn with draw() 1.5 s power1.inOut",
      "Orbital rings as ellipses with a travelling dot",
      "Staged roadmap as a launch timeline",
    ],
    characterMotion: ["No mascot"],
    captions: [
      "No pill; 42 px Be Vietnam Pro 500 ink with black shadow, owns the bottom band alone (no telemetry beside it); current word ink",
    ],
    sound: [
      "Ambient orchestral tension with ticking pulse, swelling at liftoff",
      "SFX: countdown beeps, radio chatter-style blips (synthesised), low rumble on liftoff",
    ],
    preferScenes: ["hook", "timeline", "stats", "product-hero", "diagram", "outro"],
    avoidScenes: ["testimonial", "code"],
    signatureMoves: [
      "T-minus countdown landing exactly on the drop",
      "Stage-separation transition",
      "Trajectory arc drawn over a dotted globe",
      "HOLD to GO checklist flips",
    ],
    strengths: ["Tension and anticipation", "Milestones and roadmaps", "Hard-tech credibility"],
    constraints: [
      "Telemetry values must be real numbers from the script, not invented",
      "Monochrome except amber states and blue trajectory lines",
      "One liftoff drop per video",
      "Captions own the bottom band; telemetry and timelines stay out of it",
    ],
    avoid: ["Colourful gradients", "Rounded friendly UI", "Mascots"],
    pairsWellWith: ["holographic-hud", "blueprint-engineering", "accelerated-compute", "data-editorial"],
  },
  {
    id: "modular-build",
    name: "Modular Build",
    aliases: ["brick build", "stackable block build", "step-by-step build"],
    summary:
      "Build-it-yourself play; plain stackable blocks snapping together step by step, stop-motion stepping and bold primaries.",
    energy: 4,
    bestFor: ["product-assembly", "onboarding-steps", "platform-building-blocks", "kids-promo"],
    character:
      "Everything is built from blocks: plain stackable blocks drop and snap in stop-motion steps, instruction-style numbered panels show each stage, and whole scenes assemble or crumble brick by brick. Creative and systematic.",
    palette: {
      mode: "light",
      colors: {
        bg: "#fef9e7",
        ink: "#1b1b1b",
        accent: "#d8462c",
        yellow: "#f2aa1a",
        blue: "#2a4fb8",
        green: "#1f8a5c",
        white: "#ffffff",
        mute: "#6d6e70",
      },
      rule: "Primary brick colours only (red, yellow, blue, green, white); each brick one flat colour with a darker side face.",
    },
    typography: [
      "Archivo Black headlines 84 px, tight, uppercase for titles",
      "Archivo 600 for step labels; big step numbers in 160 px Archivo Black",
      "Be Vietnam Pro 700 for captions",
    ],
    layout: [
      "Instruction-manual panels: numbered step box top-left, build area centre",
      "Isometric-ish 3/4 view of assemblies (CSS transforms on flat faces)",
    ],
    material: [
      "Blocks as flat SVG/CSS isometric cuboids with plain tops (no studs), 15% darker side faces, soft 0 6 0 shadow",
    ],
    texture: ["Clean; faint baked PNG plastic sheen on bricks", "Cream instruction-paper background"],
    camera: ["Locked isometric view; occasional stepped rotate in 90 deg increments"],
    transitions: [
      "brick build (next scene assembles from bricks dropping in rows, 0.05 s stagger, 0.6 s)",
      "brick crumble (scene breaks into bricks that fall with gravity-like power2.in)",
      "page turn to next instruction step",
      "tile pop (grid of square tiles pops then fills the frame)",
    ],
    bpm: [110, 128],
    rhythm:
      "Step-by-step: each step 2-4 beats, bricks snap on beats, a completed build held for 4+ beats with a celebratory spin.",
    beatResponse: [
      "A brick snaps into place on each beat during builds (drop y -60 -> 0, snap with 3 px bounce)",
      "Stepped motion on twos for build sequences",
      "No flashes",
    ],
    uiChoreography: [
      "UI panels built from rectangular bricks; components clip on in stepped increments (steps(6))",
      "Numbered instruction callouts with an arrow showing where the next piece goes",
      "Parts list tray slides up showing pieces with counts (x2, x4)",
    ],
    diagrams: [
      "Architecture as stacked bricks, layers colour-coded",
      "Flows as arrows between assembly stages",
    ],
    characterMotion: [
      "Simple blocky minifigure-free characters built from 2-3 bricks, moving on twos with stepped hops",
    ],
    captions: [
      "White box with 4 px ink border and hard 6 px shadow, 42 px Be Vietnam Pro 700 ink; current word red",
    ],
    sound: [
      "Upbeat quirky pop with claps 115-125 BPM",
      "SFX: plastic click snaps on every brick, tumble rattle on crumbles",
    ],
    preferScenes: ["feature", "diagram", "timeline", "ui-demo", "montage", "cta"],
    avoidScenes: ["testimonial", "quote"],
    signatureMoves: [
      "Scene assembles brick by brick on the beat",
      "Instruction-manual numbered step panels",
      "Brick crumble transition",
      "Parts-list tray before a build",
    ],
    strengths: ["Explaining modular or composable products", "Onboarding steps", "Creative playful tone"],
    constraints: [
      "Brick motion stepped (on twos) and snapped, never floaty",
      "Only primary brick colours plus white",
      "No real toy logos, minifigures or studded-brick shapes",
    ],
    avoid: ["Photoreal materials", "Soft gradients", "Slow cinematic pacing"],
    pairsWellWith: ["isometric-systems", "playful-game-system", "functional-playful", "soft-clay-3d"],
  },
  {
    id: "monochrome-developer",
    name: "Monochrome Developer",
    aliases: ["black-and-white developer platform", "deploy log monochrome", "grid-line developer"],
    summary:
      "Stark black-and-white developer platform; plus-marked grid lines, deploy logs, spotlight beams and edge-network globes.",
    energy: 3,
    bestFor: ["developer-platform", "deploy-flow", "infrastructure", "launch-week"],
    character:
      "Pure monochrome with engineering swagger: black canvases ruled by fine grid lines with plus marks at intersections, build logs streaming to a successful deploy, and a soft spotlight beam or a dotted globe for scale.",
    palette: {
      mode: "dark",
      colors: {
        bg: "#000000",
        ink: "#ededed",
        mute: "#a1a1a1",
        line: "rgba(255,255,255,0.12)",
        surface: "#0a0a0a",
        ok: "#4bd69a",
        accent: "#ffffff",
        err: "#ff6a4d",
      },
      rule: "Strict monochrome; ok and err only on status dots and log words. Light inversions (bg #ffffff, ink #0a0a0a) allowed for chapter cards.",
    },
    typography: [
      "Inter Tight 700 headlines 88 px at -0.05em, 400 body 28 px mute",
      "Roboto Mono 400 20 px logs, URLs and labels",
      "Headlines centred; kicker as mono uppercase 16 px (scaled 24 px)",
    ],
    layout: [
      "Visible grid: 1 px line rules framing content cells, plus marks at corners",
      "Terminal or log panel centre; headline above",
    ],
    material: [
      "Surface cells with 1 px line borders, radius 0 or 6",
      "Buttons as solid white pills with black text",
    ],
    texture: [
      "Conic spotlight beam from top baked PNG at 20%",
      "Dotted globe as baked PNG with SVG arcs on top",
    ],
    camera: [
      "Locked-off grid; content pans inside cells",
      "Slow globe rotation (rotate background-position 0 -> 400 px over the scene)",
    ],
    transitions: [
      "grid-draw (grid lines draw across frame with draw(), then content fills cells)",
      "cell-swap (cells flip their content in a stagger along the grid)",
      "beam-sweep (spotlight sweeps and reveals next scene)",
      "cut on terminal enter",
    ],
    bpm: [110, 128],
    rhythm:
      "Log-driven: bursts of fast log lines (0.04 s each) then 4-beat holds on results; hero scenes 6 beats.",
    beatResponse: ["Grid plus marks blink on downbeats", "Log bursts start on beats"],
    uiChoreography: [
      "Logs stream line by line with typeIn; timestamps in mute, success word in ok",
      "Deploy status pill steps Building -> Ready with dot colour change and a check drawn in",
      "Preview URL types, then a browser frame (generic) rises with the site",
    ],
    diagrams: [
      "Edge network: points on a dotted globe light up and arcs draw between them",
      "Request flow as mono labels in cells linked by 1 px arrows",
    ],
    characterMotion: ["No mascot"],
    captions: ["Black box with 1 px line border, radius 6, 40 px Be Vietnam Pro 600 ink; unread words mute"],
    sound: ["Dark minimal techno 110-128 BPM", "Keyboard ticks on logs, a clean chime on Ready, low density"],
    preferScenes: ["terminal", "code", "diagram", "title", "stats", "cta"],
    avoidScenes: ["testimonial", "montage"],
    signatureMoves: [
      "Grid lines drawing across the frame with plus marks",
      "Build log burst to a Ready state",
      "Spotlight beam sweep reveal",
      "Edge globe with arcs lighting up",
    ],
    strengths: ["Crisp developer credibility", "Very strong typographic contrast"],
    constraints: [
      "No colour beyond status accents",
      "Grid lines 1 px only",
      "No triangle logo shapes or brand wordmarks",
    ],
    avoid: ["Gradients and colour meshes", "Soft pastel UI", "Bouncy easing"],
    pairsWellWith: ["precision-dark-product", "terminal-ops", "developer-workflow", "gradient-fintech"],
  },
  {
    id: "music-editorial",
    name: "Music Editorial",
    aliases: ["music culture editorial", "duotone music campaign", "beat-locked stat cards"],
    summary:
      "Bold music culture; duotone portraits, saturated colour blocks, huge type, stat cards and beat-locked cuts.",
    energy: 4,
    bestFor: ["year-in-review", "music-app", "personalized-stats", "culture-campaign"],
    character:
      "Loud colour and music-first rhythm: duotone portraits on saturated blocks, huge tight type, personal stats revealed like story cards and cuts locked to the beat. Playful editorial with a pop-culture pulse.",
    palette: {
      mode: "mixed",
      colors: {
        bg: "#141416",
        ink: "#ffffff",
        mute: "#b5b3ae",
        accent: "#2ad19a",
        pink: "#ff4fa3",
        orange: "#ff8340",
        lilac: "#a99bd0",
        yellow: "#f7e14b",
        blue: "#4238b5",
      },
      rule: "Each scene is one saturated block plus a contrasting duotone pair (e.g. pink on blue, yellow on orange); green accent as a thread across the video.",
    },
    typography: [
      "Archivo 900 headlines 160-260 px, -0.04em, line-height 0.9",
      "Archivo 700 stat labels 40 px; numbers 200+ px",
      "Words can break across lines and stack in alternating colours",
    ],
    layout: [
      "Story-card framing: centred stack of big number, label, small context",
      "Album-art style square grids (3x3) for montage scenes",
      "Duotone portrait cut-out overlapping a colour block",
    ],
    material: [
      "Flat colour blocks, no radius or radius 24 for cards",
      "Square cover-art tiles with no shadow",
    ],
    texture: ["Duotone gradient-mapped images pre-baked to PNG", "Paper grain 6% baked PNG optional"],
    camera: [
      "Beat-synced scale hits 1 -> 1.06 on kicks for images",
      "Grid pans across cover tiles (x 300-600 px, power2.inOut over the scene)",
    ],
    transitions: [
      "colour-block-wipe (full-frame block slides in on the beat, next scene revealed on it)",
      "cut on beat",
      "tile-grid (squares flip in grid order)",
      "shape-mask (blob or circle mask expands from a stat)",
    ],
    bpm: [110, 130],
    rhythm:
      "Beat-locked: stat cards 4 beats, montage 1-beat cuts, big reveals hold 8 beats; builds with the chorus.",
    beatResponse: [
      "Images scale-hit on kicks",
      "Background block colour swaps on bar starts in montage",
      "Waveform bars follow envKeys on the music",
    ],
    uiChoreography: [
      "Player-style UI minimal: progress bar fill, play button morph play -> pause, track rows sliding in",
      "Stats cards stack like stories with swipe-left transitions",
    ],
    diagrams: ["Charts as chunky colour bars and big numbers; genre mixes as stacked coloured bands"],
    characterMotion: ["No mascot; cut-out portraits bounce on kicks (y 12 px)"],
    captions: ["Solid black box radius 8, 42 px Be Vietnam Pro 800 white; current word accent"],
    sound: [
      "Pop, dance or indie with a strong chorus, 110-130 BPM",
      "Few SFX: vinyl scratch-lite on reveals, whoosh on block wipes; music forward (still under speech)",
    ],
    preferScenes: ["stats", "montage", "hook", "cover", "quote", "outro"],
    avoidScenes: ["terminal", "code", "spec"],
    signatureMoves: [
      "Full-frame colour block wipe on the beat",
      "Giant personal stat revealed like a story card",
      "Duotone portrait over a saturated block",
      "Cover-art tile grid flipping in order",
    ],
    strengths: ["Culturally fresh and bold", "Makes numbers personal and shareable"],
    constraints: [
      "Duotones baked to PNG, not live filters",
      "Max 3 saturated colours per scene",
      "No brand logo, wordmark or real album covers",
    ],
    avoid: ["Muted corporate palettes", "Thin light type", "Slow eased dissolves"],
    pairsWellWith: ["sport-editorial", "kinetic-typography", "joyful-pop", "data-editorial"],
  },
  {
    id: "playful-game-system",
    name: "Playful Game System",
    aliases: ["family game promo", "bouncy game ui", "primary-pop game system"],
    summary:
      "Bright family-game joy; white stage, primary colour pops, bouncy springy UI, click sounds and characters that hop.",
    energy: 4,
    bestFor: ["game-promo", "family-product", "playful-feature", "social-cut"],
    character:
      "Pure play: a clean white stage, bold primary-red accents, UI that clicks and springs, and icons that hop, wobble and bounce like toys. Friendly, inclusive and immediately fun, with tactile click feedback on every action.",
    palette: {
      mode: "light",
      colors: {
        bg: "#ffffff",
        ink: "#1a1a1a",
        accent: "#e8402a",
        blue: "#00a7e1",
        yellow: "#ffd400",
        green: "#3ec13e",
        paper: "#f3f3f3",
        mute: "#8a8a8a",
      },
      rule: "White stage with red as the hero colour; blue, yellow and green as secondary pops, one per element; no gradients.",
    },
    typography: [
      "Rubik 800 headlines 80 px, rounded and chunky, sentence case",
      "Rubik 500 body 30 px",
      "Be Vietnam Pro 700 for captions",
    ],
    layout: [
      "Centred compositions, big friendly icons; one idea per scene",
      "Rounded grid tiles 3 x 2 for menus and feature lists",
    ],
    material: [
      "Flat rounded shapes radius 28 with 0 8 0 darker bottom edge (toy-button depth)",
      "White cards with 4 px ink outline for highlights",
    ],
    texture: ["None; flat colour only"],
    camera: ["Locked-off; occasional bouncy zoom (scale 1 -> 1.15, back.out 2) on the hero"],
    transitions: [
      "pop-swap (outgoing scales to 0 with back.in, incoming pops from 0 with back.out 1.8, 0.35 s)",
      "slide-click (panel slides in and snaps with a click and 6 px overshoot)",
      "iris to a star or circle shape",
      "colour wipe (red panel sweeps)",
    ],
    bpm: [120, 140],
    rhythm: "Bouncy and quick: 2-4 beat scenes, a joyful mid-point hero hold, upbeat end card with a jingle.",
    beatResponse: [
      "Icons hop (y -24 px, sine.out/in) on every beat",
      "Squash 1.15/0.85 on landing",
      "No flashes or shake",
    ],
    uiChoreography: [
      "Menu tiles pop in with 0.05 s stagger (scale 0 -> 1, back.out 2, 0.4 s)",
      "Cursor or finger taps: tile presses down 4 px then springs back (elastic.out 1, 0.5)",
      "Progress stars fill one by one with a twinkle",
    ],
    diagrams: [
      "Rounded bubble diagrams with thick 6 px connectors",
      "Step-by-step numbered bubbles that bounce in",
    ],
    characterMotion: [
      "Simple geometric characters (circle bodies, dot eyes) that hop, squash and wave",
      "Idle bob 4 px sine.inOut on held characters, finite repeats sized to the hold",
    ],
    captions: ["White pill with 4 px ink outline, radius 24, 42 px Be Vietnam Pro 700 ink; current word red"],
    sound: [
      "Chiptune-flavoured bright pop 125-135 BPM",
      "Frequent playful SFX: clicks, boings, coin-like chimes (original)",
    ],
    preferScenes: ["cover", "hook", "feature", "ui-demo", "montage", "cta"],
    avoidScenes: ["terminal", "spec", "chart"],
    signatureMoves: [
      "Pop-swap scene change with back eases",
      "Tactile click-and-spring on every tap",
      "Icons hopping on the beat with squash",
      "Star-shaped iris transition",
    ],
    strengths: ["Fun and approachability", "Family and youth audiences", "Simple feature explainers"],
    constraints: [
      "Flat colours only, no gradients or textures",
      "Every tap or selection gets a visible press and spring",
      "No existing game characters, sounds or logos",
    ],
    avoid: ["Dark moody palettes", "Dense text", "Realistic rendering"],
    pairsWellWith: ["pixel-arcade", "character-comedy", "joyful-pop", "modular-build"],
  },
  {
    id: "playful-productivity",
    name: "Playful Productivity",
    aliases: ["cheerful team chat", "chat message pops", "emoji-burst productivity"],
    summary:
      "Cheerful team chat; plum and bright accents, bouncy message pops, emoji bursts, threads that unfold.",
    energy: 4,
    bestFor: ["team-app", "collaboration", "integrations", "workplace-culture"],
    character:
      "Upbeat and human at work: messages bounce into channels, emoji reactions burst and count up, threads unfold and colourful integration tiles snap together. Friendly rounded type and a playful bounce everywhere.",
    palette: {
      mode: "mixed",
      colors: {
        bg: "#ffffff",
        ink: "#1e1d22",
        mute: "#63626a",
        plum: "#3a2358",
        plum_light: "#f4ede4",
        accent: "#2458b0",
        teal: "#26a69a",
        yellow: "#f29544",
        red: "#e2445a",
        sky: "#5aa9ec",
      },
      rule: "White chat surfaces with a plum sidebar; four brights rotate on reactions, tiles and confetti.",
    },
    typography: [
      "Nunito 800 headlines 76 px, 600 body 30 px",
      "Lato 400 26 px for message text; Lato 700 for names",
      "Headlines may wobble per letter on entry",
    ],
    layout: [
      "Chat window: plum sidebar left 280 px, messages column right",
      "Hero scenes: big headline centred with floating emoji and tiles around",
    ],
    material: [
      "Rounded white panels radius 16, shadow 0 12px 32px rgba(30,29,34,0.12)",
      "Reaction pills radius 12 with 1 px border",
    ],
    texture: ["None; flat colours"],
    camera: ["Locked-off; slight bounce zoom 1 -> 1.04 -> 1 on big moments"],
    transitions: [
      "bounce-in (y 100 -> 0 with back.out(1.8) 0.5 s)",
      "confetti-burst (seeded rng confetti from centre, next scene pops in behind)",
      "channel-switch (sidebar item selects and message column slides left)",
      "tile-snap (colour tiles fly in and snap into a grid forming the next scene)",
    ],
    bpm: [110, 128],
    rhythm: "Chatty: messages every 1-2 beats in conversation scenes, hero moments hold 4-6 beats.",
    beatResponse: [
      "Emoji reactions pop on beats",
      "Floating emoji bob 10 px on kicks",
      "#pulse 1% on kick downbeats in hero scenes",
    ],
    uiChoreography: [
      "Typing indicator (three dots bouncing in sequence), then message pops with back.out(1.6)",
      "Reactions pop under messages and count up with odo; burst of 6-10 mini emoji sprites via seeded rng",
      "Threads expand to the right with a slide; app integration cards slot in",
    ],
    diagrams: [
      "Integration hub: colourful rounded tiles connected by thick rounded lines to a centre, drawn with draw()",
    ],
    characterMotion: ["Emoji sprites squash on landing; avatars nod (y 4 px) when speaking"],
    captions: ["Plum pill radius 16, 40 px Be Vietnam Pro 700 white; current word yellow"],
    sound: [
      "Bouncy indie pop or funk 110-128 BPM",
      "Knock-brush message pings, pops on reactions, confetti swish; medium density",
    ],
    preferScenes: ["ui-demo", "feature", "testimonial", "hook", "montage", "cta"],
    avoidScenes: ["spec", "terminal", "code"],
    signatureMoves: [
      "Typing dots then a bouncy message pop",
      "Emoji reaction burst with counter",
      "Colour tiles snapping into a grid",
      "Confetti transition into the next scene",
    ],
    strengths: ["Human, warm, fun", "Great for collaboration features"],
    constraints: [
      "Confetti and bursts use seeded rng only",
      "No brand hashtag logo or its colour pinwheel arrangement",
      "Max 2 bursts per scene",
    ],
    avoid: ["Cold enterprise greys", "Slow held reveals", "Dark hacker looks"],
    pairsWellWith: ["friendly-system-motion", "community-chaos", "creative-canvas", "joyful-pop"],
  },
  {
    id: "precision-dark-product",
    name: "Precision Dark Product",
    aliases: ["crisp dark product ui", "keyboard-driven dark ui", "hairline dark app"],
    summary:
      "Crisp dark product UI; near-black, hairline borders, soft top glows, snappy keyboard-driven list and command moves.",
    energy: 3,
    bestFor: ["saas-product", "dev-tool", "feature-launch", "changelog"],
    character:
      "Fast, exact and quiet: a near-black stage with faint top light, hairline borders, fading gradient headlines and interfaces that respond instantly to keyboard commands. Motion is short and snappy, never floaty.",
    palette: {
      mode: "dark",
      colors: {
        bg: "#0a0a0d",
        ink: "#f5f5f3",
        mute: "#8e9099",
        surface: "#111216",
        hair: "rgba(255,255,255,0.08)",
        accent: "#6d5fd0",
        green: "#3fb39c",
        amber: "#eeaf4a",
        red: "#e25d6f",
      },
      rule: "Near-black with one desaturated indigo accent; status colours only on 8 px dots and small badges.",
    },
    typography: [
      "Inter 500 headlines 64-80 px at -0.035em, gradient fill ink -> mute top to bottom",
      "Inter 400 body 26 px mute; Inter 500 14-16 px (scaled 24 px) UI",
      "Roboto Mono 20 px for shortcut keys in keycap chips",
    ],
    layout: [
      "Headline centred high; product window below, cropped by frame bottom",
      "Or window full-frame with a single floating label",
    ],
    material: [
      "Surface panels with 1 px hair border, radius 8-12, inner top highlight rgba(255,255,255,0.04)",
      "Soft accent top glow: large ellipse baked PNG at 15% above the window",
    ],
    texture: ["Faint noise 2% baked PNG", "Top light glow baked PNG"],
    camera: [
      "Slow tilt-in of the window (rotateX 18 -> 0, perspective 1800, power3.out 1.2 s)",
      "Crops glide to the active area (translate 80-200 px, power3.inOut 0.6 s)",
    ],
    transitions: [
      "glow-rise (next scene rises 24 px from under the top glow, 0.35 s power3.out)",
      "command-cut (command palette opens, selection made, scene switches on enter)",
      "tilt-settle (window tilts in from rotateX 18)",
      "fast fade 0.2 s",
    ],
    bpm: [110, 128],
    rhythm: "Snappy: UI actions every 1-2 beats, 0.15-0.25 s tweens; hero headlines hold 6 beats.",
    beatResponse: ["Top glow breathes 5% on kicks", "Keycap chips depress on beats when shortcuts are shown"],
    uiChoreography: [
      "Command palette drops (scale 0.98 -> 1, fade, 0.15 s), filter text types, highlighted row moves down with each keystroke",
      "Issue rows reorder with FLIP-style y moves 0.25 s power3.out; status dot colour-changes",
      "Keyboard shortcut keycaps appear bottom-centre as the action happens",
    ],
    diagrams: ["Hairline 1 px connectors between surface nodes; progress as thin accent bars filling"],
    characterMotion: ["No mascot"],
    captions: ["Surface pill with hair border, radius 10, 40 px Be Vietnam Pro 500 ink; unread words mute"],
    sound: [
      "Minimal deep house or ambient electronic 110-128 BPM",
      "Crisp key taps on shortcuts, very low density otherwise",
    ],
    preferScenes: ["ui-demo", "feature", "title", "cta", "timeline"],
    avoidScenes: ["montage", "testimonial", "hook"],
    signatureMoves: [
      "Command palette driving a scene change",
      "Rows reordering instantly with FLIP moves",
      "Window tilting in under a soft top glow",
      "Keycap chips pressed in sync with actions",
    ],
    strengths: ["Feels fast and high-craft", "Ideal for dev and SaaS tools"],
    constraints: [
      "UI tweens 0.15-0.3 s; no bouncy springs",
      "1 px hair borders only",
      "Glows baked PNG, max 2 on screen",
    ],
    avoid: ["Bright light themes", "Chunky shadows", "Playful mascots"],
    pairsWellWith: ["monochrome-developer", "gradient-fintech", "cinematic-product-launch", "saas-bento"],
  },
  {
    id: "precision-hardware",
    name: "Precision Hardware",
    aliases: ["drone gear", "aerial gear precision", "exploded hardware spec"],
    summary:
      "Aerial-gear precision; sweeping fly-through camera, exploded component views and crisp spec callouts on graphite.",
    energy: 3,
    bestFor: ["gadget-launch", "camera-gear", "exploded-view", "spec-reveal"],
    character:
      "Engineered and airborne: the camera sweeps like a drone over the product, parts fan out into exploded views with hairline callouts, and specs snap in with gimbal-smooth motion. Precise, sleek and adventurous.",
    palette: {
      mode: "dark",
      colors: {
        bg: "#0d0f12",
        ink: "#f2f4f7",
        accent: "#3aa0ff",
        graphite: "#22262c",
        silver: "#c7ccd3",
        mute: "#7d848d",
        sky: "#8fd3ff",
      },
      rule: "Graphite and silver carry the product; blue only for callout dots and the active spec; outdoor imagery stays natural.",
    },
    typography: [
      "Manrope 700 headlines 68 px, -0.02em",
      "Manrope 400 body 28 px; Roboto Mono 500 for spec values and units",
      "Be Vietnam Pro 600 for captions",
    ],
    layout: [
      "Product centre-left, callouts fan to the right on 1 px leader lines",
      "Spec grid 2 x 3 tiles right side; headline top-left",
    ],
    material: [
      "Machined metal renders with soft studio rim light",
      "Graphite spec tiles radius 12, 1 px silver border at 20%",
    ],
    texture: [
      "Clean; one baked PNG studio gradient floor",
      "Aerial landscape stills for context shots with scale/pan (footage needs supplied clips and a verified HyperFrames video path)",
    ],
    camera: [
      "Drone fly-through: combined x/y/scale move (e.g. scale 1.3 -> 1, x 200 -> 0, rotate 3 -> 0 deg) over 2.4 s power2.inOut",
      "Gimbal-smooth orbit (rotateY -20 -> 20 deg) on product holds",
    ],
    transitions: [
      "fly-through (camera pushes past foreground edge into next scene, 0.7 s)",
      "exploded split (parts fly apart, next scene assembles)",
      "horizon tilt (frame rotates 8 deg and settles in the next)",
      "clean cut on beat",
    ],
    bpm: [105, 125],
    rhythm: "Adventure intro with sweeping holds, then brisk 2-4 beat spec scenes, closing aerial reveal.",
    beatResponse: [
      "Callout dots ping (scale 1 -> 1.4 -> 1) on kicks",
      "No flashes; subtle #pulse 0.5% only on the drop",
    ],
    uiChoreography: [
      "Exploded view: parts translate along their axis with 0.05 s stagger, power3.out 0.9 s, leader lines draw after parts settle",
      "Spec tiles flip up (rotationX 60 -> 0) with 0.08 s stagger; values odo() in",
      "Viewfinder overlay (thirds grid, battery and altitude readouts) for camera features",
    ],
    diagrams: [
      "Hairline callouts with blue terminal dots",
      "Flight-path splines drawn over terrain with a travelling marker",
    ],
    characterMotion: [
      "No mascot; the product moves like it flies (gentle bob 6 px sine.inOut on holds, finite repeats sized to the hold)",
    ],
    captions: [
      "Dark pill rgba(13,15,18,0.75), radius 16, 42 px Be Vietnam Pro 600 ink; current word #8fd3ff",
    ],
    sound: [
      "Uplifting electronic / cinematic pop 110-120 BPM",
      "SFX: air whoosh on fly-throughs, mechanical clicks on exploded parts",
    ],
    preferScenes: ["product-hero", "spec", "feature", "montage", "ui-demo"],
    avoidScenes: ["terminal", "quote"],
    signatureMoves: [
      "Drone fly-through transition past a foreground edge",
      "Exploded component view with leader-line callouts",
      "Viewfinder overlay with live readouts",
      "Horizon tilt settle between scenes",
    ],
    strengths: ["Hardware detail and craftsmanship", "Adventure context", "Spec communication"],
    constraints: [
      "Leader lines only draw after parts come to rest",
      "Blue used only for callouts and the active spec",
      "Camera moves are smooth (power2/sine); no shake",
    ],
    avoid: ["Cartoon textures", "Heavy glows", "Hard flashes"],
    pairsWellWith: [
      "product-spec-film",
      "minimal-future-product",
      "blueprint-engineering",
      "cinematic-technology",
    ],
  },
  {
    id: "premium-ui-demo",
    name: "Premium UI Demo",
    aliases: ["spring ui demo", "light interface demo", "floating panel demo"],
    summary:
      "Light, spring-driven interface demo; floating rounded panels, soft depth, taps that zoom and sheets that rise.",
    energy: 2,
    bestFor: ["app-demo", "feature-walkthrough", "onboarding", "ui-reveal"],
    character:
      "Interface as the hero: bright neutral backgrounds, large rounded panels with soft shadows and gentle spring physics, the camera leaning into the control being used. Every interaction reads as touch: press, settle, reveal.",
    palette: {
      mode: "light",
      colors: {
        bg: "#f2f1ee",
        ink: "#1a1b1f",
        mute: "#6f6e69",
        surface: "#ffffff",
        accent: "#3b74f2",
        green: "#34c77f",
        orange: "#f5821f",
        hair: "rgba(0,0,0,0.08)",
      },
      rule: "Neutral greys plus one system accent; secondary colours only as small status dots or toggles.",
    },
    typography: [
      "Inter 600 headlines 64 px at -0.025em, 400 body 30 px",
      "Inter 500 UI labels 22-28 px inside panels; numbers tabular",
      "Headline above or left of the UI, never overlapping it",
    ],
    layout: [
      "UI panel centred or right two-thirds; text block left third",
      "Max two panels on stage; secondary panel offset back and smaller (scale 0.9)",
      "Background stays flat bg; hero panel casts all the depth",
    ],
    material: [
      "White panels, radius 28-36 px, 1 px hair border, shadow 0 30px 80px rgba(0,0,0,0.12)",
      "Frosted overlay sheets faked with 92% white fill (no live backdrop blur)",
    ],
    texture: ["None"],
    camera: [
      "Zoom into the control being used (scale 1 -> 1.6 around its centre, power3.inOut 0.9 s), then pull back",
      "Subtle 3D tilt of the panel (rotationY 8 -> 0) on entry, perspective 2000",
    ],
    transitions: [
      "spring-rise (y 80 -> 0 with back.out(1.2) 0.7 s)",
      "zoom-into-ui (camera scales into a button that becomes the next scene)",
      "sheet (next scene slides up from the bottom as a card, power3.out 0.6 s)",
      "cross-fade with 8 px blur for calm resets",
    ],
    bpm: [90, 110],
    rhythm:
      "Interaction beats: each tap, toggle or swipe lands on a beat and gets 2-3 beats of settle before the next action.",
    beatResponse: ["None globally; individual taps land on beats"],
    uiChoreography: [
      "Tap = 0.94 press scale for 0.1 s then back.out release, with a soft accent ripple ring (scale 0 -> 1.6, fade)",
      "Lists fill with 0.05 s staggered rise; toggles slide with back.out(1.4)",
      "Sheets and popovers spring up from their anchor; dismiss with power2.in 0.3 s",
      "Values change with odo; progress rings drawn with draw()",
    ],
    diagrams: ["Rare; if needed, rounded cards linked by 2 px mute lines, drawn with draw()"],
    characterMotion: ["No mascot; a simple 36 px translucent touch dot may lead taps"],
    captions: [
      "White pill rgba(255,255,255,0.9) with hair border, radius 18, 40 px Be Vietnam Pro 600 ink; current word accent",
    ],
    sound: [
      "Light acoustic or minimal pop 90-110 BPM",
      "Tiny tap ticks and soft swooshes on sheets, vol 0.2-0.3",
    ],
    preferScenes: ["ui-demo", "feature", "product-hero", "title", "cta"],
    avoidScenes: ["terminal", "montage", "chart"],
    signatureMoves: [
      "Camera zooms into a tapped control that becomes the next screen",
      "Spring press and release with ripple ring",
      "Sheet rising from the bottom to open the next scene",
      "Panel tilt-in from a slight 3D angle",
    ],
    strengths: ["Makes interfaces feel tactile and premium", "Clear step-by-step demos"],
    constraints: [
      "No live backdrop-filter blur; fake frosting with alpha fills",
      "One interaction on screen at a time",
      "All springs use back.out at 1.0-1.4 overshoot, never elastic",
    ],
    avoid: ["Dark neon looks", "Cursor arrows on touch UI", "Busy backgrounds"],
    pairsWellWith: ["cinematic-product-launch", "keynote-stage", "calm-workspace", "friendly-system-motion"],
  },
  {
    id: "product-spec-film",
    name: "Product Spec Film",
    aliases: ["engineering showcase", "exploded-view spec film", "x-ray spec film"],
    summary:
      "Engineering showcase; exploded layers, x-ray linework, leader-line callouts and precise spec numbers on graphite.",
    energy: 2,
    bestFor: ["hardware-spec", "architecture-reveal", "engineering-story", "feature-deep-dive"],
    character:
      "The product taken apart with surgical calm: layers separate along one axis, outlines turn to x-ray line drawings, thin leader lines pin exact numbers to parts. It reads as craftsmanship and measured precision, not hype.",
    palette: {
      mode: "dark",
      colors: {
        bg: "#0b0c0e",
        ink: "#e6e6e2",
        mute: "rgba(230,230,226,0.5)",
        line: "rgba(230,230,226,0.35)",
        accent: "#74b0f7",
        warm: "#f29a4a",
      },
      rule: "Graphite stage, ink linework, one cool accent for the highlighted part; warm only for heat or power callouts.",
    },
    typography: [
      "Inter 300-500: spec numbers 140 px weight 300 with units at 40 px weight 500",
      "Roboto Mono 400 20 px uppercase labels at +0.08em on callouts",
      "Short headline 56 px Inter 600, top-left or centred above the object",
    ],
    layout: [
      "Object centred and large; callouts radiate to left/right columns at 180 px margins",
      "Max 4 callouts per shot, aligned to a vertical baseline",
      "Spec number block lower-left with a thin rule above",
    ],
    material: [
      "Object as layered flat SVG/PNG plates with 1 px ink edges",
      "X-ray mode: fills fade to 0, strokes stay at line alpha",
    ],
    texture: [
      "Fine engineering grid 40 px at 4% ink, baked PNG",
      "Soft top-down light falloff baked into bg",
    ],
    camera: [
      "Slow orbit faked by rotationY -12 -> 12 on layered plates with parallax offsets",
      "Macro push (scale 1 -> 1.25) onto one part, sine.inOut 2-3 s",
    ],
    transitions: [
      "explode (layers separate along z/y with 0.08 s stagger, power2.inOut 1.2 s) then reassemble into next",
      "x-ray dissolve (fills fade, strokes remain, next shot draws in)",
      "macro-push through a part into the next shot",
      "slow cross-fade 0.8 s",
    ],
    bpm: [70, 95],
    rhythm:
      "Long measured holds: 8-16 beats per shot; callouts arrive on words, spec numbers land on downbeats.",
    beatResponse: ["None; downbeats only time number landings"],
    uiChoreography: ["Rare; UI shown as a flat plate that can explode into its layers like hardware"],
    diagrams: [
      "Leader lines: 1 px line from a 6 px accent dot on the part, drawn with draw() 0.5 s, then label types in with typeIn",
      "Cutaway sections with dashed hidden edges and dimension arrows",
      "Flow of heat or data as a thin accent pulse travelling a path",
    ],
    characterMotion: ["No mascot"],
    captions: [
      "No pill; 40 px Be Vietnam Pro 500 ink with soft shadow, bottom band left-aligned to the spec column",
    ],
    sound: [
      "Sparse ambient or minimal piano 70-95 BPM",
      "Micro mechanical ticks on callouts, vol 0.15-0.25; a low whoom on explode",
    ],
    preferScenes: ["spec", "diagram", "product-hero", "feature", "stats"],
    avoidScenes: ["montage", "testimonial", "hook"],
    signatureMoves: [
      "Exploded view that separates, holds, then reassembles",
      "Fill-to-linework x-ray dissolve",
      "Leader-line callouts drawn from dot to label",
      "Thin-weight spec number with a counting odo",
    ],
    strengths: [
      "Communicates engineering depth",
      "Makes specs feel beautiful",
      "Pairs with any premium base",
    ],
    constraints: [
      "Max 4 callouts on screen",
      "All lines 1-1.5 px; no thick strokes or glows",
      "Every move eased; no beat-driven motion",
    ],
    avoid: ["Hype typography", "Colourful gradients", "Mascots"],
    pairsWellWith: [
      "cinematic-product-launch",
      "blueprint-engineering",
      "precision-hardware",
      "keynote-stage",
    ],
  },
  {
    id: "quirky-editorial",
    name: "Quirky Editorial",
    aliases: ["quirky illustration", "offbeat editorial illustration", "mustard ink editorial"],
    summary:
      "Offbeat editorial illustration; mustard fields, loose ink drawings, surreal cut-outs and witty serif headlines.",
    energy: 3,
    bestFor: ["small-business-promo", "marketing-tool", "brand-refresh", "explainer"],
    character:
      "Weird in a good way: loose hand-inked illustrations on warm mustard, surreal cut-out collages where objects do unexpected things, and a big friendly serif headline with a punchline. Creative, human and a little odd.",
    palette: {
      mode: "light",
      colors: {
        bg: "#f2c230",
        ink: "#1f1b17",
        accent: "#1a8072",
        cream: "#f6f0e4",
        coral: "#f2777a",
        sage: "#9eb28c",
        mute: "#6b5f55",
      },
      rule: "Mustard or cream backgrounds, ink linework; teal and coral as flat fills inside illustrations, never as backgrounds.",
    },
    typography: [
      "Fraunces 700 headlines 84 px, soft optical size, -0.02em",
      "Manrope 500 body 30 px",
      "Be Vietnam Pro 600 for captions",
    ],
    layout: [
      "Big serif headline left, illustration spilling off the right edge",
      "Magazine spreads: one illustration, one line, lots of colour field",
    ],
    material: [
      "Flat colour fields with loose 3 px ink outlines (slightly wobbly SVG paths)",
      "Cut-out photo objects with white sticker border",
    ],
    texture: ["Baked PNG risograph grain 8% over fills", "Pencil-texture strokes baked as PNG masks"],
    camera: ["Locked-off editorial frames; occasional slow pan across a wide illustration"],
    transitions: [
      "line redraw (ink outline of next scene draws on, fills flood in after, 0.7 s)",
      "cut-out slide (collage object slides across and becomes the next scene)",
      "colour field swap (mustard to cream with a soft wipe)",
      "surreal morph (object scales into another object)",
    ],
    bpm: [95, 115],
    rhythm:
      "Conversational: 4-6 beat editorial frames, a pause before each punchline, quick 2-beat gag inserts.",
    beatResponse: [
      "Doodle accents (sparkles, squiggles) wiggle on beats",
      "Illustrated objects nod or tilt 4 deg on kicks",
      "No flashes",
    ],
    uiChoreography: [
      "UI shown as hand-drawn wireframe that fills into a flat screenshot (line redraw then fill fade 0.4 s)",
      "Email/card elements slide in with a playful 6 deg tilt then straighten (back.out 1.3)",
      "Metrics in speech bubbles held by illustrated hands",
    ],
    diagrams: [
      "Hand-drawn arrows and loops (wobbly paths via draw())",
      "Venn and flow diagrams inked loosely with flat fills",
    ],
    characterMotion: [
      "Loose-drawn quirky characters and animals (original), moving on twos with a boiling-line effect from 3 baked frames",
    ],
    captions: ["Cream box radius 6 with 3 px ink outline, 42 px Be Vietnam Pro 600 ink; current word teal"],
    sound: [
      "Quirky indie pop, ukulele, whistles, light percussion",
      "SFX: pencil scribbles, pops, cartoon boinks sparingly",
    ],
    preferScenes: ["hook", "feature", "quote", "diagram", "comparison", "cta"],
    avoidScenes: ["terminal", "spec", "montage"],
    signatureMoves: [
      "Ink line redraw then colour flood",
      "Boiling-line character on twos",
      "Surreal object morph between scenes",
      "Wireframe that fills into real UI",
    ],
    strengths: ["Approachable marketing explainers", "Personality and wit", "Illustration-led storytelling"],
    constraints: [
      "All characters original; no chimp mascot or look-alike",
      "Ink outlines always present on illustrations",
      "Textures baked to PNG",
    ],
    avoid: ["Glossy 3D", "Dark tech palettes", "Hyper-fast cutting"],
    pairsWellWith: ["paper-cut-collage", "functional-playful", "character-comedy", "playful-productivity"],
  },
  {
    id: "sensory-tech",
    name: "Sensory Tech",
    aliases: ["vivid consumer tech", "fluid gradient device showcase", "sensory close-ups"],
    summary:
      "Vivid consumer-tech showcase; fluid colour gradients, device morphs, sensory close-ups and bright rhythmic UI.",
    energy: 3,
    bestFor: ["device-launch", "feature-showcase", "display-tech", "consumer-promo"],
    character:
      "Sensory and vivid: liquid colour gradients flow behind devices, the product folds and morphs between forms, and macro close-ups of screen, camera and sound make features felt. Brighter and more colourful than a minimal launch.",
    palette: {
      mode: "mixed",
      colors: {
        bg: "#0a0a14",
        ink: "#ffffff",
        accent: "#3a2fb5",
        violet: "#7b61ff",
        coral: "#ff7a8a",
        mint: "#5ef2c2",
        paper: "#f7f7fa",
        mute: "rgba(255,255,255,0.6)",
      },
      rule: "One liquid gradient per scene built from two of violet/coral/mint over bg; deep blue accent for chips and CTAs.",
    },
    typography: [
      "Sora 600 headlines 72 px, -0.015em; large feature words at 140 px",
      "Sora 400 body 28 px",
      "Be Vietnam Pro 600 for captions",
    ],
    layout: [
      "Device centred, headline above in two lines; feature labels orbit the device",
      "Split screens for before/after camera comparisons",
    ],
    material: [
      "Glossy device renders with coloured reflections sampled from the gradient",
      "Rounded feature chips radius 999, frosted white at 14%",
    ],
    texture: [
      "Liquid gradient mesh baked to 4-6 PNG frames and crossfaded (no live blurs)",
      "Soft light leaks on reveals",
    ],
    camera: [
      "Macro push onto device details (scale 1 -> 2.2 over 1.6 s, power2.inOut)",
      "Floating device rotation (rotateY -25 -> 25 deg, sine.inOut 4 s)",
    ],
    transitions: [
      "colour flood (gradient blob expands from device to fill frame, 0.6 s power2.inOut)",
      "fold (scene folds at the centre like a hinge, rotateY 90 deg each half)",
      "morph (device shape tweens into the next scene's device)",
      "lens zoom (push into the camera ring, iris out)",
    ],
    bpm: [110, 124],
    rhythm:
      "Showcase rhythm: 4-beat feature scenes, a montage of camera shots at 1-2 beats, a hero hold for the flagship.",
    beatResponse: [
      "Gradient shifts hue slightly on kick beats",
      "Feature chips pop in on beats",
      "#pulse 0.8% on kick downbeats",
    ],
    uiChoreography: [
      "Screen UI slides up inside the device (y 60 -> 0, power3.out 0.5 s), widgets stagger 0.06 s",
      "Before/after slider sweeps across a photo on the spoken word",
      "AI feature highlights draw a glowing outline around the edited region",
    ],
    diagrams: [
      "Rounded flow diagrams with gradient strokes",
      "Sound waves via envKeys from the voice envelope",
    ],
    characterMotion: ["No mascot"],
    captions: [
      "Frosted pill rgba(255,255,255,0.14), radius 24, 44 px Be Vietnam Pro 600 ink; current word #5ef2c2",
    ],
    sound: [
      "Bright electronic pop with glossy synths 115-122 BPM",
      "SFX: liquid swooshes on colour floods, soft shutter on camera shots",
    ],
    preferScenes: ["product-hero", "feature", "ui-demo", "comparison", "montage", "cta"],
    avoidScenes: ["terminal", "code"],
    signatureMoves: [
      "Colour flood from the device into the next scene",
      "Hinge fold transition",
      "Before/after slider on a photo",
      "Macro push into the camera ring with iris out",
    ],
    strengths: ["Feature showcases", "Colour and display quality", "Consumer excitement"],
    constraints: [
      "Gradient meshes baked to PNG, never live blur stacks",
      "Max two gradient hues per scene",
      "Device always in frame on feature scenes",
    ],
    avoid: ["Monochrome austerity", "Dense text", "Hand-made textures"],
    pairsWellWith: ["cinematic-technology", "expressive-tonal-ui", "premium-ui-demo", "y2k-liquid-chrome"],
  },
  {
    id: "sport-editorial",
    name: "Sport Editorial",
    aliases: ["street-sport magazine", "sport editorial grid", "cut-out sport collage"],
    summary:
      "Street-sport magazine; off-white editorial grid, split panels, cut-out collage, bold grotesk and rhythmic panel wipes.",
    energy: 4,
    bestFor: ["campaign", "lifestyle-launch", "collection-drop", "culture-story"],
    character:
      "Part sports magazine, part street poster: a visible column grid on paper white, images dropped into panels that slide and split, bold grotesk headlines with small index numbers. Rhythmic and cultured rather than purely aggressive.",
    palette: {
      mode: "light",
      colors: {
        bg: "#efece6",
        ink: "#111111",
        mute: "#7a766f",
        accent: "#0047ff",
        signal: "#ff5a1f",
        panel: "#1a1a1a",
      },
      rule: "Paper and ink dominate; one accent per scene; dark panels invert type to paper.",
    },
    typography: [
      "Archivo 800 condensed-width (wdth 75) uppercase headlines 140-200 px, tracking -0.02em",
      "Space Mono 400 18 px index numbers and credits (e.g. 01/06, place, year)",
      "Headlines break across grid columns with deliberate ragged line lengths",
    ],
    layout: [
      "12-column editorial grid with 1 px ink rules visible at 15% alpha",
      "Split-screen panels: 1/3 + 2/3 or 4 equal verticals",
      "Index numbers and captions in corners of panels",
    ],
    material: [
      "Flat paper; photos as hard-edged rectangles and cut-out figures with 8 px paper outline",
      "Tape strips and sticker labels as flat shapes",
    ],
    texture: ["Paper grain baked PNG 0.12", "Halftone on cut-outs baked PNG, sparing"],
    camera: [
      "Locked-off grid; content moves inside panels (image drift 30-60 px)",
      "Occasional whole-grid slide of one column width",
    ],
    transitions: [
      "panel-wipe (vertical panels slide in sequence, 0.06 s stagger, power3.inOut 0.5 s)",
      "split (frame divides along a grid line and halves slide apart)",
      "column-shift (grid slides one column to reveal next scene)",
      "hard cut on downbeats",
    ],
    bpm: [100, 125],
    rhythm:
      "Steady 2-bar phrases: panels change every 2-4 beats, headline scenes hold 8 beats; build faster in the last quarter.",
    beatResponse: [
      "Panels and index numbers tick on each beat",
      "Accent rule flashes across the grid on bar starts",
      "No pulse wrapper",
    ],
    uiChoreography: [
      "UI placed inside a grid panel like a magazine photo; swaps with panel-wipe",
      "Labels stamp in with Space Mono index",
    ],
    diagrams: ["Editorial infographics: ink rules, big numbers, arrows drawn with draw(); no rounded cards"],
    characterMotion: [
      "No mascot; cut-out figures slide and scale inside panels with a 2-frame hold on arrival",
    ],
    captions: [
      "Ink block on paper with no radius, 40 px Be Vietnam Pro 700 paper-coloured; current word accent",
    ],
    sound: [
      "UK garage, house or hip-hop 100-125 BPM",
      "Paper swipes and shutter clicks on panel moves, moderate density",
    ],
    preferScenes: ["cover", "title", "montage", "feature", "quote", "testimonial", "cta"],
    avoidScenes: ["terminal", "code", "spec"],
    signatureMoves: [
      "Sequential vertical panel wipe",
      "Frame splits along a grid line",
      "Cut-out figure with paper outline over a grid",
      "Index numbers ticking on the beat",
    ],
    strengths: ["Stylish and cultural", "Handles lots of imagery", "Strong rhythm without chaos"],
    constraints: [
      "All moves snap to grid columns",
      "No rounded corners anywhere",
      "No parallel diagonal stripe motifs",
    ],
    avoid: ["Glassy UI", "Gradients", "Logo-like stripe patterns"],
    pairsWellWith: ["athletic-impact", "swiss-kinetic-editorial", "paper-cut-collage", "music-editorial"],
  },
  {
    id: "systematic-enterprise",
    name: "Systematic Enterprise",
    aliases: ["design-system motion", "strict grid enterprise", "blue-on-grey system"],
    summary:
      "Rigorous design-system motion; strict 2x grid, square corners, blue on grey, productive curves and column mask reveals.",
    energy: 2,
    bestFor: ["enterprise-solution", "data-platform", "b2b-explainer", "research-story"],
    character:
      "Disciplined and intelligent: everything sits on a strict modular grid with square corners, colour is mostly greys with one decisive blue, and motion splits into quick productive moves and slower expressive reveals. Data and pictograms carry the story.",
    palette: {
      mode: "mixed",
      colors: {
        bg: "#15171a",
        ink: "#f3f2ef",
        mute: "#a6a8ad",
        layer: "#25272b",
        accent: "#3a4fe0",
        accent_light: "#8a9cf5",
        cyan: "#3ec6e0",
        magenta: "#e0587a",
        light_bg: "#f3f2ef",
        light_ink: "#15171a",
      },
      rule: "Grey scale plus blue; cyan and magenta only in data viz series. Alternate dark and light scenes by chapter.",
    },
    typography: [
      "Inter 300 display 96-128 px, 600 for emphasis words, -0.01em",
      "Roboto Mono 400 18 px labels and numbers",
      "Left-aligned always; text aligns to grid columns",
    ],
    layout: [
      "16-column grid, 32 px gutters, 1 px layer rules optional",
      "Text in columns 1-6, visual in 7-16",
      "Tiles as square-cornered blocks in exact column multiples",
    ],
    material: ["Flat square tiles (radius 0) in layer grey; 1 px accent top border on active tile"],
    texture: ["None; optional 8 px dot grid at 6% baked PNG on diagram scenes"],
    camera: ["Locked-off; grid-aligned slides only"],
    transitions: [
      "column-mask (vertical masks open column by column, 0.04 s stagger, cubic productive ease power2.out 0.24 s)",
      "tile-flip (tiles turn over in grid order to reveal next scene)",
      "slide by one grid module (expressive power3.inOut 0.4 s)",
      "hard cut between dark and light chapters",
    ],
    bpm: [90, 112],
    rhythm:
      "Measured: productive moves 0.1-0.25 s, expressive reveals 0.4-0.7 s; scenes 6-8 beats with data scenes holding longer.",
    beatResponse: ["Grid tiles light accent on downbeats during stats", "Otherwise none"],
    uiChoreography: [
      "Data tables fill row by row (0.03 s stagger), sort with rows sliding to new positions",
      "Tabs switch with an underline sliding 0.2 s; tiles expand in column units",
      "Notifications slide in from the right edge with an accent left bar",
    ],
    diagrams: [
      "Square nodes with Roboto Mono labels, orthogonal connectors drawn with draw()",
      "Line and bar charts on grid axes; series in accent, cyan, magenta",
      "Monoline pictograms 2 px stroke drawn in",
    ],
    characterMotion: ["No mascot; monoline pictograms may draw themselves"],
    captions: [
      "Square block layer grey with 3 px accent left bar, 40 px Be Vietnam Pro 500 ink, left-aligned",
    ],
    sound: ["Minimal electronic or modern classical 90-112 BPM", "Precise ticks and data blips, low density"],
    preferScenes: ["diagram", "chart", "stats", "feature", "spec", "timeline"],
    avoidScenes: ["montage", "hook"],
    signatureMoves: [
      "Column-by-column mask reveal",
      "Tiles flipping in grid order",
      "Data table sorting with rows gliding",
      "Monoline pictogram drawing itself",
    ],
    strengths: ["Credibility for enterprise and data", "Excellent for dense information"],
    constraints: [
      "Radius 0 everywhere",
      "Every element snaps to the 16-column grid",
      "Productive vs expressive durations kept distinct",
    ],
    avoid: ["Bouncy springs", "Gradients", "Decorative textures"],
    pairsWellWith: [
      "data-editorial",
      "layered-productivity",
      "blueprint-engineering",
      "swiss-kinetic-editorial",
    ],
  },
];
