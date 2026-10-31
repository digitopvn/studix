import type { KnowledgeEntry, KnowledgePack } from "../knowledge-pack-schema.ts";
import { agentkitSource } from "../knowledge-sources.ts";

const CREATIVITY = "kits/marketing/skills/ak-creativity";

/** One row of the visual style registry. */
function style(
  id: string,
  title: string,
  text: string,
  f: {
    keywords: string;
    palette: string;
    signatureEffects: string;
    music: string;
    voiceStyle: string;
    bestFor: string;
    avoidFor: string;
  },
): KnowledgeEntry {
  return { id, title, text, fields: f, tags: ["visual-style"] };
}

/** One row of the voice-over style registry. */
function voice(
  id: string,
  title: string,
  text: string,
  f: {
    tone: string;
    delivery: string;
    pacing: string;
    pitch: string;
    energy: string;
    bestFor: string;
    directionKeywords: string;
  },
): KnowledgeEntry {
  return { id, title, text, fields: f, tags: ["voiceover-style"] };
}

/** One colour of the colour psychology table. */
function color(
  id: string,
  title: string,
  f: { emotion: string; bestFor: string; caution: string },
): KnowledgeEntry {
  return {
    id,
    title,
    text: `Reads as ${f.emotion.toLowerCase()}; a hypothesis to fit to the brief, not a guaranteed effect.`,
    fields: f,
    tags: ["color"],
  };
}

export const creativeDirectionPack: KnowledgePack = {
  id: "creative-direction",
  version: "1.0.0",
  title: "Creative direction",
  summary:
    "Visual style registry, voice-over style registry and colour psychology for briefing a video's look and sound.",
  purpose:
    "Pick a visual style, a voice-over style and a palette that fit the audience, the message and the established " +
    "brand. The registries are suggestions: a style may be rejected for a reason taken from the brief, and every " +
    "choice is stated as a fit argument and a testable hypothesis, not as a proven uplift.",
  sources: [
    agentkitSource(`${CREATIVITY}/SKILL.md`, "CR-04"),
    agentkitSource(`${CREATIVITY}/data/styles.csv`, "CR-04"),
    agentkitSource(`${CREATIVITY}/data/voiceover.csv`, "CR-04"),
    agentkitSource(`${CREATIVITY}/references/voiceover-styles.md`, "CR-04"),
    agentkitSource(`${CREATIVITY}/references/color-psychology.md`, "CR-04"),
  ],
  phases: ["brief", "design", "grade", "sound", "qa"],
  loadWhen: [
    "creative direction",
    "visual style",
    "look and feel",
    "aesthetic",
    "mood",
    "palette",
    "color",
    "voice-over",
    "narrator tone",
    "brief",
  ],
  useCases: [
    "Writing the creative brief: match audience, goal and industry to a short list of visual styles, then justify the pick.",
    "Turning a chosen style into concrete design inputs: palette, signature effects, music genre and voice-over tone.",
    "Casting and directing a voice-over: choose a delivery style and hand the talent or voice tool its direction keywords.",
    "Choosing a palette: primary colour from brand personality, accent for hierarchy, harmony rule for the overall mood.",
    "Reviewing assets for palette consistency, text contrast and cultural fit before delivery.",
  ],
  antiPatterns: [
    "Treating a registry row as a rule: applying a style because the table lists the audience, without a brief-based reason.",
    "Using a style on an audience its avoid-for list names (a chaotic maximalist look for a conservative finance brief).",
    "Claiming a colour or style lifts sales, recall or recognition by a number without dated, scoped evidence.",
    "Picking colours from psychology tables alone, ignoring brand authority, readability and what is being sold.",
    "Assuming colour meanings are universal; the same colour can mean luck in one culture and danger in another.",
    "Defaulting every voice-over to the same announcer voice regardless of brand and audience.",
    "Mixing palettes across the assets of one campaign so they no longer read as one piece.",
  ],
  sections: [
    {
      id: "visual-styles",
      title: "Visual style registry",
      entries: [
        style(
          "minimalist-clean",
          "Minimalist clean",
          "Product hero shots on clean layouts with a single focal point; signals premium restraint.",
          {
            keywords: "minimal, whitespace, elegant, simple, refined, essential",
            palette: "White, light gray, one accent",
            signatureEffects: "Generous negative space, thin lines, geometric shapes",
            music: "Ambient piano, soft electronic",
            voiceStyle: "Calm, measured, sophisticated",
            bestFor: "Premium brands, tech products, luxury goods, professional services",
            avoidFor: "Youth brands, entertainment, playful products",
          },
        ),
        style(
          "maximalist-bold",
          "Maximalist bold",
          "Pattern mixing, dense composition and oversized type; loud, layered energy for youth and fashion.",
          {
            keywords: "vibrant, layered, eclectic, bold, energetic, chaotic",
            palette: "Bright multi-colour, neon accents, clashing hues",
            signatureEffects: "Overlapping elements, texture mixing, bold typography",
            music: "Upbeat pop, electronic dance",
            voiceStyle: "Energetic, fast-paced, playful",
            bestFor: "Gen Z, fashion, entertainment, social media",
            avoidFor: "B2B, finance, healthcare, conservative brands",
          },
        ),
        style(
          "quiet-luxury",
          "Quiet luxury",
          "Simple product shots with extensive space and premium materials; understated, whispered expense.",
          {
            keywords: "understated, sophisticated, whisper, refined, expensive",
            palette: "Muted neutrals, cream, soft beige, charcoal",
            signatureEffects: "Ultra-clean frames, material textures, subtle shadows",
            music: "Classical strings, soft jazz",
            voiceStyle: "Hushed, intimate, refined",
            bestFor: "Luxury goods, premium services, heritage brands",
            avoidFor: "Mass market, budget products, youth",
          },
        ),
        style(
          "nostalgic-80s",
          "Nostalgic 80s",
          "Geometric patterns, grid lines and chrome text in a synthwave mood; retro energy for tech and gaming.",
          {
            keywords: "retro, neon, synthwave, vintage, geometric, VHS",
            palette: "Neon pink #FF1493, cyan #00FFFF, purple #8B00FF, black",
            signatureEffects: "VHS grain, scan lines, chrome or metallic text",
            music: "Synthwave, 80s pop",
            voiceStyle: "Bold, announcer-style, dramatic",
            bestFor: "Gaming, tech, retro campaigns, Gen X and millennial audiences",
            avoidFor: "Luxury, healthcare, B2B corporate",
          },
        ),
        style(
          "nostalgic-90s",
          "Nostalgic 90s",
          "Grunge textures, chunky fonts and bubble shapes; ironic Y2K nostalgia for fashion and beauty.",
          {
            keywords: "Y2K, grunge, chunky, metallic, gradient",
            palette: "Silver, purple gradients, bright blue, lime",
            signatureEffects: "Chrome gradients, lens flare, pixelated edges",
            music: "90s pop, grunge rock",
            voiceStyle: "Casual, ironic, playful",
            bestFor: "Fashion, beauty, Gen Z nostalgia, trend-driven campaigns",
            avoidFor: "Conservative brands, elderly audiences, B2B",
          },
        ),
        style(
          "futuristic-sci-fi",
          "Futuristic sci-fi",
          "Geometric precision, tech interfaces and space imagery; sleek, advanced and metallic.",
          {
            keywords: "sleek, tech, advanced, metallic, space-age",
            palette: "Silver, chrome, electric blue #0080FF, black",
            signatureEffects: "Metallic gradients, holographic effects, clean lines",
            music: "Ambient electronic, sci-fi score",
            voiceStyle: "Calm authority, tech-forward",
            bestFor: "AI and ML products, tech startups, sci-fi themes",
            avoidFor: "Traditional, organic, handmade products",
          },
        ),
        style(
          "cyberpunk-digital",
          "Cyberpunk digital",
          "Dark cityscapes, digital overlays and tech decay; an edgy, dystopian night world.",
          {
            keywords: "dark, neon, digital, dystopian, glitch",
            palette: "Neon pink #FF006E, cyan #00FFFF on black, purple",
            signatureEffects: "Glitch effects, neon glow, pixel distortion",
            music: "Dark electronic, industrial",
            voiceStyle: "Edgy, intense, dystopian",
            bestFor: "Gaming, tech, counter-culture, edgy brands",
            avoidFor: "Family, wellness, conservative brands",
          },
        ),
        style(
          "retro-futurism",
          "Retro-futurism",
          "A 70s vision of the future: vintage tech and a warm, optimistic tomorrow.",
          {
            keywords: "vintage-future, space-age, analog-digital",
            palette: "Orange, teal, warm metallics",
            signatureEffects: "Film grain, lens flare, warm colour grading",
            music: "Disco, space-age lounge",
            voiceStyle: "Warm, optimistic, nostalgic",
            bestFor: "Music, creative agencies, entertainment",
            avoidFor: "Healthcare, finance, B2B",
          },
        ),
        style(
          "emotional-storytelling",
          "Emotional storytelling",
          "Real people, candid moments and a narrative arc; heartfelt human connection for causes and wellness.",
          {
            keywords: "authentic, real, heartfelt, human, connection",
            palette: "Warm earth tones, soft natural light",
            signatureEffects: "Natural lighting, shallow depth of field, intimate framing",
            music: "Acoustic guitar, piano ballad",
            voiceStyle: "Warm, conversational, genuine",
            bestFor: "Non-profits, healthcare, wellness, family brands",
            avoidFor: "Tech specs, B2B, fast-paced content",
          },
        ),
        style(
          "cinematic-documentary",
          "Cinematic documentary",
          "Wide shots, narrative structure and dramatic lighting; epic film production values.",
          {
            keywords: "epic, film, narrative, dramatic, production",
            palette: "Deep blues, cinematic orange, rich shadows",
            signatureEffects: "Film colour grade, letterbox, dramatic shadows",
            music: "Orchestral, cinematic score",
            voiceStyle: "Dramatic, narrator, inspiring",
            bestFor: "Sports brands, premium products, story-driven pieces",
            avoidFor: "Quick promos, social snippets, low budgets",
          },
        ),
        style(
          "humor-comedic",
          "Humour comedic",
          "Absurd scenarios, unexpected twists and character comedy; built on timing.",
          {
            keywords: "funny, absurd, exaggerated, silly, surprising",
            palette: "Bright, saturated, varies with the joke",
            signatureEffects: "Quick cuts, comedic timing, reaction shots",
            music: "Upbeat music cut to comedic timing",
            voiceStyle: "Over-the-top, comedic delivery",
            bestFor: "Fast-moving consumer goods, snacks, beverages, entertainment",
            avoidFor: "Luxury, B2B, serious topics",
          },
        ),
        style(
          "sarcasm-witty",
          "Sarcasm and wit",
          "Wordplay visuals and self-aware moments on a clean base; clever, ironic and sharp.",
          {
            keywords: "clever, ironic, smart, self-aware, sharp",
            palette: "Clean, modern, often a minimalist base",
            signatureEffects: "Clean design carrying clever copy, deadpan delivery",
            music: "Quirky indie, subtle",
            voiceStyle: "Deadpan, dry, intelligent",
            bestFor: "SaaS, tech, millennial professionals",
            avoidFor: "Conservative brands, elderly audiences, mass market",
          },
        ),
        style(
          "conversational-casual",
          "Conversational casual",
          "Everyday scenarios, first-person point of view and casual settings; friendly and relatable.",
          {
            keywords: "friendly, relatable, everyday, warm, approachable",
            palette: "Warm friendly pastels, earth tones",
            signatureEffects: "Natural lighting, handheld feel, informal framing",
            music: "Indie acoustic, lo-fi beats",
            voiceStyle: "Friendly, like talking to a friend",
            bestFor: "Lifestyle, community brands, direct-to-consumer",
            avoidFor: "Luxury, corporate, formal B2B",
          },
        ),
        style(
          "authoritative-expert",
          "Authoritative expert",
          "Data visualisations, credentials and expert interviews; commanding, credible and trusted.",
          {
            keywords: "commanding, credible, professional, trusted, expert",
            palette: "Navy, dark gray, white, gold accents",
            signatureEffects: "Clean graphics, data overlays, professional lighting",
            music: "Corporate, subtle orchestral",
            voiceStyle: "Confident, measured, expert",
            bestFor: "Finance, legal, healthcare, B2B enterprise",
            avoidFor: "Youth, entertainment, casual brands",
          },
        ),
        style(
          "inspirational-motivational",
          "Inspirational motivational",
          "Achievement moments and transformation in powerful imagery; uplifting triumph.",
          {
            keywords: "uplifting, aspirational, powerful, moving, triumph",
            palette: "Bold primaries, golden sunrise, dynamic",
            signatureEffects: "Slow motion, epic wide shots, dynamic camera",
            music: "Anthemic, building crescendo",
            voiceStyle: "Passionate, powerful, moving",
            bestFor: "Sports, fitness, self-help, causes",
            avoidFor: "Corporate, B2B, technical content",
          },
        ),
        style(
          "provocative-edgy",
          "Provocative edgy",
          "Challenging imagery and bold, uncomfortable statements that push boundaries.",
          {
            keywords: "bold, challenging, controversial, boundary-pushing",
            palette: "High contrast, often black and white with red",
            signatureEffects: "Stark contrast, jarring cuts, intense framing",
            music: "Industrial, aggressive electronic",
            voiceStyle: "Intense, confrontational",
            bestFor: "Fashion, activism, counter-culture",
            avoidFor: "Family, conservative, healthcare",
          },
        ),
        style(
          "authentic-ugc",
          "Authentic user-generated",
          "Real customer footage and unscripted testimonials; social proof from the community.",
          {
            keywords: "real, user, genuine, testimonial, community",
            palette: "Natural, uncontrolled lighting",
            signatureEffects: "Phone-camera quality, natural audio, candid framing",
            music: "Currently trending sounds, popular music",
            voiceStyle: "Real customers speaking",
            bestFor: "Direct-to-consumer, community brands, social-proof-heavy campaigns",
            avoidFor: "Luxury, premium, B2B enterprise",
          },
        ),
        style(
          "raw-unpolished",
          "Raw unpolished",
          "Behind-the-scenes and process shots with mistakes kept in; deliberately anti-polish.",
          {
            keywords: "lo-fi, imperfect, candid, real, anti-polish",
            palette: "Natural, varied, imperfect white balance",
            signatureEffects: "Grain, natural imperfections, jump cuts",
            music: "Lo-fi beats, bedroom pop",
            voiceStyle: "Casual, unscripted feel",
            bestFor: "Gen Z, creator collaborations, short-form vertical native content",
            avoidFor: "Luxury, corporate, B2B",
          },
        ),
        style(
          "dark-moody-cinematic",
          "Dark moody cinematic",
          "Low-key lighting, rich shadows and selective focus; mysterious, noir sophistication.",
          {
            keywords: "mysterious, sophisticated, noir, dramatic, deep",
            palette: "Deep blues, purples, blacks, selective warm accents",
            signatureEffects: "Chromatic aberration, film noir lighting",
            music: "Dark ambient, moody electronic",
            voiceStyle: "Hushed, mysterious, intimate",
            bestFor: "Premium tech, luxury, entertainment, thrillers",
            avoidFor: "Family, wellness, cheerful brands",
          },
        ),
        style(
          "bright-cheerful",
          "Bright cheerful",
          "Smiling people, sunshine and active scenes; happy, optimistic and positive.",
          {
            keywords: "happy, optimistic, sunny, positive, energetic",
            palette: "Bright yellow, sky blue, white, warm tones",
            signatureEffects: "High-key lighting, bright whites, warm grading",
            music: "Upbeat pop, happy acoustic",
            voiceStyle: "Cheerful, energetic, positive",
            bestFor: "Family brands, wellness, food, summer campaigns",
            avoidFor: "Luxury, B2B, serious topics",
          },
        ),
        style(
          "monochromatic",
          "Monochromatic",
          "Tonal variations, shadow play and texture inside one colour family; cohesive and refined.",
          {
            keywords: "single-color, sophisticated, cohesive, refined",
            palette: "One colour family, tints and shades only",
            signatureEffects: "Subtle gradients within one hue, material textures",
            music: "Minimal, ambient",
            voiceStyle: "Refined, subtle, sophisticated",
            bestFor: "Luxury, art, sophisticated brands",
            avoidFor: "Youth, entertainment, playful brands",
          },
        ),
        style(
          "bold-color-clash",
          "Bold colour clash",
          "Unexpected pairings and colour blocking with complementary opposites; daring and playful.",
          {
            keywords: "vibrant, complementary, energetic, playful, daring",
            palette: "Opposite colours: blue and orange, pink and green",
            signatureEffects: "Hard colour blocks, high saturation throughout",
            music: "Energetic pop, dance",
            voiceStyle: "Bold, confident, playful",
            bestFor: "Fashion, youth, entertainment, bold brands",
            avoidFor: "Corporate, healthcare, conservative brands",
          },
        ),
        style(
          "earthy-organic",
          "Earthy organic",
          "Natural materials, outdoor settings and organic shapes; grounded and sustainable.",
          {
            keywords: "natural, sustainable, grounded, warm, authentic",
            palette: "Terracotta, sage, warm brown, cream",
            signatureEffects: "Warm colour grade, soft shadows, texture emphasis",
            music: "Acoustic folk, nature sounds",
            voiceStyle: "Warm, genuine, grounded",
            bestFor: "Sustainability, organic products, wellness, outdoor",
            avoidFor: "Tech, gaming, urban, fast-paced content",
          },
        ),
        style(
          "metallic-luxe",
          "Metallic luxe",
          "Reflective surfaces, luxury materials and premium finishes; opulent glamour.",
          {
            keywords: "premium, gold, chrome, elegant, opulent",
            palette: "Gold, silver, rose gold, black",
            signatureEffects: "Metallic highlights, reflections, glamour lighting",
            music: "Elegant orchestral, jazz",
            voiceStyle: "Sophisticated, premium",
            bestFor: "Jewellery, luxury goods, premium services",
            avoidFor: "Budget, mass market, casual brands",
          },
        ),
        style(
          "gradient-smooth",
          "Gradient smooth",
          "App interfaces, modern tech and smooth transitions; flowing contemporary digital.",
          {
            keywords: "modern, digital, flowing, contemporary, tech",
            palette: "Smooth colour transitions, often pastels to dark",
            signatureEffects: "Seamless colour blends, soft shadows, clean edges",
            music: "Modern electronic, ambient",
            voiceStyle: "Modern, clean, friendly",
            bestFor: "SaaS, apps, modern tech, digital services",
            avoidFor: "Traditional, rustic, handmade products",
          },
        ),
        style(
          "neon-cyber",
          "Neon cyber",
          "Night scenes, urban glow and electric accents; nightlife and launch energy.",
          {
            keywords: "neon, glow, cyber, electric, night",
            palette: "Neon green #39FF14, magenta #FF00FF, electric blue",
            signatureEffects: "Neon glow, blur effects, light trails",
            music: "Electronic, bass-heavy",
            voiceStyle: "Electric, energetic",
            bestFor: "Gaming, clubs, night events, tech launches",
            avoidFor: "Daytime, wellness, natural products",
          },
        ),
        style(
          "pastel-soft",
          "Pastel soft",
          "Soft focus and gentle compositions in a dreamy mood; calming and tender.",
          {
            keywords: "gentle, calming, soft, dreamy, tender",
            palette: "Soft pink, mint, lavender, baby blue",
            signatureEffects: "Soft glow, gentle shadows, bloom",
            music: "Soft pop, acoustic covers",
            voiceStyle: "Gentle, soothing, tender",
            bestFor: "Beauty, skincare, baby products, wellness",
            avoidFor: "B2B, aggressive brands, gaming",
          },
        ),
        style(
          "high-contrast-bw",
          "High-contrast black and white",
          "Strong shadows, dramatic lighting and bold shapes; timeless and stark.",
          {
            keywords: "dramatic, timeless, artistic, stark, powerful",
            palette: "Pure black, pure white, no grays",
            signatureEffects: "Hard shadows, high contrast, grain",
            music: "Minimal, classical",
            voiceStyle: "Dramatic, timeless",
            bestFor: "Fashion editorial, art, premium photography",
            avoidFor: "Colourful brands, playful brands, children",
          },
        ),
        style(
          "vintage-film",
          "Vintage film",
          "Film-like compositions, classic framing and warm tones; analog, faded nostalgia.",
          {
            keywords: "nostalgic, warm, analog, faded, classic",
            palette: "Faded colours, warm yellows, soft contrast",
            signatureEffects: "Film grain, light leaks, faded blacks",
            music: "Vintage tracks, jazz, oldies",
            voiceStyle: "Nostalgic, warm, reflective",
            bestFor: "Heritage brands, craft, storytelling campaigns",
            avoidFor: "Tech, modern, futuristic brands",
          },
        ),
        style(
          "pop-art",
          "Pop art",
          "Comic-style illustration, bold outlines and iconic imagery; graphic and colourful.",
          {
            keywords: "bold, graphic, comic, colorful, iconic",
            palette: "Primary colours, halftone dots",
            signatureEffects: "Halftone effects, bold outlines, colour separation",
            music: "Upbeat retro, pop",
            voiceStyle: "Bold, playful, iconic",
            bestFor: "Entertainment, pop culture, youth brands",
            avoidFor: "Luxury, B2B, conservative brands",
          },
        ),
        style(
          "minimalist-tech",
          "Minimalist tech",
          "Clean interfaces, geometric shapes and precision; efficient and functional.",
          {
            keywords: "clean, efficient, geometric, precise, functional",
            palette: "White, gray, single accent colour",
            signatureEffects: "Clean lines, minimal shadows, functional design",
            music: "Ambient electronic, minimal",
            voiceStyle: "Clear, efficient, modern",
            bestFor: "Tech products, developer tools, productivity",
            avoidFor: "Creative, entertainment, playful brands",
          },
        ),
        style(
          "luxe-dark-mode",
          "Luxe dark mode",
          "Premium dark interfaces with selective highlights; rich and exclusive.",
          {
            keywords: "premium, dark, sophisticated, elegant, rich",
            palette: "Deep blacks, gold accents, rich jewel tones",
            signatureEffects: "Rich shadows, subtle gradients, gold accents",
            music: "Elegant electronic, deep bass",
            voiceStyle: "Sophisticated, premium, exclusive",
            bestFor: "Premium apps, luxury tech, exclusive services",
            avoidFor: "Budget, children, bright brands",
          },
        ),
        style(
          "nature-inspired",
          "Nature inspired",
          "Nature imagery, botanical elements and outdoor scenes; fresh and green.",
          {
            keywords: "organic, botanical, green, fresh, natural",
            palette: "Greens, earth tones, sky blue, flower colours",
            signatureEffects: "Natural lighting, organic textures, soft greens",
            music: "Nature sounds, acoustic",
            voiceStyle: "Fresh, natural, grounding",
            bestFor: "Eco brands, outdoor gear, natural products",
            avoidFor: "Urban, tech, artificial products",
          },
        ),
        style(
          "urban-street",
          "Urban street",
          "Street scenes, urban textures and real locations; gritty and raw.",
          {
            keywords: "gritty, urban, raw, authentic, street",
            palette: "Concrete gray, asphalt black, graffiti colours",
            signatureEffects: "Gritty textures, street photography style",
            music: "Hip-hop, urban electronic",
            voiceStyle: "Urban, authentic, raw",
            bestFor: "Streetwear, sneakers, urban lifestyle brands",
            avoidFor: "Luxury, corporate, rural",
          },
        ),
        style(
          "corporate-modern",
          "Corporate modern",
          "Business settings, professional people and clean design; polished and trustworthy.",
          {
            keywords: "professional, clean, trustworthy, corporate, polished",
            palette: "Blue, gray, white, green or orange accent",
            signatureEffects: "Clean gradients, professional photography",
            music: "Corporate ambient, subtle",
            voiceStyle: "Professional, confident, trustworthy",
            bestFor: "B2B enterprise, consulting, professional services",
            avoidFor: "Youth, entertainment, casual brands",
          },
        ),
        style(
          "festival-vibrant",
          "Festival vibrant",
          "Celebration scenes, confetti and dynamic movement; joyful and colourful.",
          {
            keywords: "celebration, colorful, joyful, festival, dynamic",
            palette: "Rainbow spectrum, bright neons, metallics",
            signatureEffects: "Motion blur, confetti, light trails",
            music: "Festival music, upbeat electronic",
            voiceStyle: "Joyful, energetic, celebratory",
            bestFor: "Festivals, events, celebrations, launches",
            avoidFor: "Serious topics, B2B, healthcare",
          },
        ),
        style(
          "handcrafted-artisan",
          "Handcrafted artisan",
          "Hands at work, process shots and detailed textures; crafted and authentic.",
          {
            keywords: "crafted, artisan, handmade, authentic, detailed",
            palette: "Warm earth tones, natural materials, aged surfaces",
            signatureEffects: "Warm lighting, detailed macro, texture focus",
            music: "Acoustic, folk, workshop sounds",
            voiceStyle: "Authentic, passionate, detailed",
            bestFor: "Craft brands, artisan products, handmade goods",
            avoidFor: "Mass production, tech, fast-paced content",
          },
        ),
        style(
          "tech-minimal",
          "Tech minimal",
          "Code visuals, geometric patterns and clean interfaces; precise developer look.",
          {
            keywords: "clean, geometric, code, developer, efficient",
            palette: "Dark gray, white, syntax-highlighting colours",
            signatureEffects: "Clean animations, code typography, monospace type",
            music: "Ambient electronic, lo-fi coding beats",
            voiceStyle: "Technical, precise, efficient",
            bestFor: "Developer tools, technical products, APIs",
            avoidFor: "Creative, emotional, mass-consumer pieces",
          },
        ),
        style(
          "lifestyle-aspirational",
          "Lifestyle aspirational",
          "Beautiful spaces and curated aspirational moments; the life the audience wants.",
          {
            keywords: "aspirational, lifestyle, dream, curated, goals",
            palette: "Bright, warm, naturally lit",
            signatureEffects: "Soft focus, golden hour, lifestyle photography",
            music: "Chill pop, indie acoustic",
            voiceStyle: "Aspirational, warm, inspiring",
            bestFor: "Lifestyle brands, travel, home decor, fashion",
            avoidFor: "Budget, B2B, technical content",
          },
        ),
        style(
          "data-visualization",
          "Data visualisation",
          "Charts, graphs and data stories; informative, analytical and clear.",
          {
            keywords: "informative, data, analytical, clear, insight",
            palette: "Blues, greens, clean backgrounds, accent colours",
            signatureEffects: "Animated charts, smooth transitions, clean graphics",
            music: "Ambient, subtle electronic",
            voiceStyle: "Informative, clear, analytical",
            bestFor: "B2B analytics, finance, research, reports",
            avoidFor: "Emotional, storytelling, creative pieces",
          },
        ),
        style(
          "behind-the-scenes",
          "Behind the scenes",
          "Production shots, the team at work and real moments; transparent and authentic.",
          {
            keywords: "authentic, bts, process, real, transparent",
            palette: "Natural lighting, uncontrolled environments",
            signatureEffects: "Documentary style, natural audio, raw footage",
            music: "Production sounds, ambient",
            voiceStyle: "Real, transparent, authentic",
            bestFor: "Brand transparency, product launches, team culture",
            avoidFor: "Polished, formal, luxury pieces",
          },
        ),
        style(
          "split-screen",
          "Split screen",
          "Side-by-side comparisons, transformations and choices; dual frames in sync.",
          {
            keywords: "comparison, before-after, dual, contrast, choice",
            palette: "Varies by content, often contrasting halves",
            signatureEffects: "Clean splits, synchronised motion",
            music: "Varies by content",
            voiceStyle: "Clear, comparative, informative",
            bestFor: "Before and after, product comparisons, transformations",
            avoidFor: "Narrative, emotional, storytelling pieces",
          },
        ),
        style(
          "stop-motion",
          "Stop motion",
          "Object animation, product assembly and playful movement; tactile and handcrafted.",
          {
            keywords: "playful, crafted, unique, animated, tactile",
            palette: "Varies, often bright and playful",
            signatureEffects: "Frame-by-frame object animation, handcrafted feel",
            music: "Playful, quirky music",
            voiceStyle: "Playful, unique, engaging",
            bestFor: "Food brands, creative products, unusual campaigns",
            avoidFor: "Serious, corporate, fast-paced content",
          },
        ),
        style(
          "drone-aerial",
          "Drone aerial",
          "Aerial views and landscapes that demonstrate scale; grand perspective.",
          {
            keywords: "epic, scale, landscape, perspective, grand",
            palette: "Blues, greens, earth tones seen from above",
            signatureEffects: "Smooth drone moves, revealing shots",
            music: "Epic orchestral, ambient",
            voiceStyle: "Grand, epic, awe-inspiring",
            bestFor: "Travel, real estate, large events, outdoor",
            avoidFor: "Indoor, small-scale, intimate pieces",
          },
        ),
        style(
          "time-lapse",
          "Time-lapse",
          "Construction progress, day cycles and busy scenes compressed; visible change over time.",
          {
            keywords: "progress, transformation, time, change, fast-forward",
            palette: "Varies by subject, often day to night",
            signatureEffects: "Time compression, smooth transitions",
            music: "Building music, ambient",
            voiceStyle: "Progressive, dynamic, efficient",
            bestFor: "Construction, events, urban scenes, transformations",
            avoidFor: "Detailed, intimate, slow-paced pieces",
          },
        ),
        style(
          "macro-close-up",
          "Macro close-up",
          "Extreme close-ups and texture reveals; intimate precision on detail.",
          {
            keywords: "detail, texture, intimate, precision, focus",
            palette: "Subject-specific, rich detail colours",
            signatureEffects: "Shallow depth of field, smooth focus pulls, detail lighting",
            music: "Intimate, delicate music",
            voiceStyle: "Detailed, precise, intimate",
            bestFor: "Beauty, food, jewellery, product details",
            avoidFor: "Wide shots, landscapes, action",
          },
        ),
        style(
          "slow-motion",
          "Slow motion",
          "Action moments, emotional beats and product reveals stretched for impact.",
          {
            keywords: "dramatic, impact, emphasis, emotional, powerful",
            palette: "Varies, often muted or dramatic",
            signatureEffects: "High frame rate capture (120 fps or more), dramatic timing, emphasis",
            music: "Dramatic, building music",
            voiceStyle: "Dramatic, impactful, emotional",
            bestFor: "Sports, luxury reveals, emotional campaigns",
            avoidFor: "Fast-paced, comedy, quick content",
          },
        ),
        style(
          "kinetic-typography",
          "Kinetic typography",
          "Moving text, message emphasis and animated quotes; the words are the picture.",
          {
            keywords: "text, motion, dynamic, message-driven, bold",
            palette: "High contrast, minimal, text-focused",
            signatureEffects: "Text animation, dynamic layouts, rhythm-based cuts",
            music: "Beat-driven, rhythmic",
            voiceStyle: "Punchy, message-driven, dynamic",
            bestFor: "Social content, manifestos, key-message campaigns",
            avoidFor: "Visual-heavy, product-focused, subtle pieces",
          },
        ),
        style(
          "isometric-3d",
          "Isometric 3D",
          "Isometric illustrations, tech diagrams and app mock-ups; clean explanatory geometry.",
          {
            keywords: "geometric, 3D, illustrated, tech, clean",
            palette: "Flat colours, clean palette, accent highlights",
            signatureEffects: "Smooth 3D animation, clean geometry",
            music: "Tech ambient, playful electronic",
            voiceStyle: "Modern, clean, explanatory",
            bestFor: "SaaS explainers, tech products, infographics",
            avoidFor: "Realistic, emotional, storytelling pieces",
          },
        ),
        style(
          "collage-mixed-media",
          "Collage mixed media",
          "Cut-out style, mixed elements and texture layers; eclectic and artistic.",
          {
            keywords: "eclectic, layered, artistic, mixed, creative",
            palette: "Varied, often contrasting, paper textures",
            signatureEffects: "Layered compositions, texture mixing, movement",
            music: "Eclectic, indie, experimental",
            voiceStyle: "Creative, artistic, unique",
            bestFor: "Creative agencies, fashion, art campaigns",
            avoidFor: "Corporate, clean, minimal brands",
          },
        ),
        style(
          "duotone",
          "Duotone",
          "Duotone photography and bold colour overlays; simplified and striking.",
          {
            keywords: "two-tone, bold, modern, striking, simplified",
            palette: "Two contrasting colours, often the brand colours",
            signatureEffects: "Colour overlay, high contrast, simplified forms",
            music: "Modern electronic, bold",
            voiceStyle: "Bold, modern, striking",
            bestFor: "Tech brands, music, bold campaigns",
            avoidFor: "Realistic, detailed, traditional pieces",
          },
        ),
        style(
          "vaporwave",
          "Vaporwave",
          "Surreal compositions, retro tech and dreamy irony from early internet culture.",
          {
            keywords: "surreal, 80s-90s, digital, nostalgic, internet",
            palette: "Pink, cyan, purple, classical statues, grids",
            signatureEffects: "Glitch, VHS effects, surreal imagery",
            music: "Vaporwave, slowed tracks",
            voiceStyle: "Dreamy, ironic, surreal",
            bestFor: "Internet culture, ironic campaigns, Gen Z memes",
            avoidFor: "Corporate, traditional, serious brands",
          },
        ),
        style(
          "clean-infographic",
          "Clean infographic",
          "Data visualisations, process flows and comparisons; structured and educational.",
          {
            keywords: "informative, educational, clear, structured, data",
            palette: "Clean whites, blues, greens, accent colours",
            signatureEffects: "Clean animations, icon-driven, structured layouts",
            music: "Subtle, educational",
            voiceStyle: "Clear, educational, informative",
            bestFor: "Educational content, how-tos, explainers",
            avoidFor: "Entertainment, emotional, storytelling pieces",
          },
        ),
        style(
          "immersive-360",
          "Immersive 360",
          "Virtual tours and spatial experiences the viewer moves through.",
          {
            keywords: "immersive, 360, experiential, interactive, spatial",
            palette: "Environment-specific, often rich and detailed",
            signatureEffects: "360 video, spatial audio, interactive elements",
            music: "Spatial audio, ambient",
            voiceStyle: "Immersive, experiential, guiding",
            bestFor: "Real estate, travel, immersive experiences",
            avoidFor: "Quick content, simple messages, low budgets",
          },
        ),
        style(
          "ai-generated-art",
          "AI-generated art",
          "Generated, experimental imagery with a surreal, dreamy quality.",
          {
            keywords: "surreal, generated, unique, experimental, creative",
            palette: "Varied, often surreal colour combinations",
            signatureEffects: "Generative aesthetics, dreamy quality",
            music: "Experimental electronic, ambient",
            voiceStyle: "Creative, experimental, unique",
            bestFor: "Tech and AI campaigns, experimental marketing",
            avoidFor: "Traditional, realistic, conservative brands",
          },
        ),
      ],
    },
    {
      id: "style-shortlists",
      title: "Style shortlists by audience",
      entries: [
        {
          id: "shortlist-by-audience",
          title: "Starting shortlists by audience or goal",
          text:
            "A first shortlist to argue from, not a decision. Pick from it only with a reason taken from the brief, " +
            "and reject any entry the brief contradicts.",
          fields: {
            premiumLuxury: "minimalist-clean, quiet-luxury, dark-moody-cinematic",
            techSaas: "futuristic-sci-fi, gradient-smooth, minimalist-tech",
            youthGenZ: "raw-unpolished, humor-comedic, nostalgic-90s, neon-cyber",
            wellnessOrganic: "earthy-organic, emotional-storytelling, pastel-soft",
            b2bFinance: "authoritative-expert, data-visualization, corporate-modern",
            community: "authentic-ugc, conversational-casual, behind-the-scenes",
          },
        },
      ],
    },
    {
      id: "voiceover-styles",
      title: "Voice-over style registry",
      entries: [
        voice(
          "vo-conversational-friendly",
          "Conversational friendly",
          "Sounds like chatting with a friend: informal language, natural pauses, engaged but never hyped.",
          {
            tone: "Warm, relatable, like chatting with a friend",
            delivery: "Natural pace, informal language, intimate feel",
            pacing: "Moderate, natural pauses, breathing room",
            pitch: "Mid-range, varied naturally",
            energy: "Medium, engaged but not hyped",
            bestFor: "Lifestyle, community, how-to, approachable brands",
            directionKeywords:
              "warm, friendly, natural, relatable, intimate, casual, approachable, down-to-earth, genuine",
          },
        ),
        voice(
          "vo-authoritative-expert",
          "Authoritative expert",
          "Firm, unhurried confidence in a lower register; credibility carried by calm gravitas.",
          {
            tone: "Commanding, credible, professional, trusted",
            delivery: "Firm clarity, measured pace, confident assertions",
            pacing: "Measured, deliberate, unhurried",
            pitch: "Lower register, steady",
            energy: "Calm confidence, gravitas",
            bestFor: "Finance, legal, healthcare, B2B, professional services",
            directionKeywords:
              "confident, credible, expert, authoritative, professional, knowledgeable, trustworthy, commanding, assured",
          },
        ),
        voice(
          "vo-inspirational-motivational",
          "Inspirational motivational",
          "Builds momentum toward peaks and drops to intimacy in the valleys; belief-driven cadence.",
          {
            tone: "Uplifting, aspirational, emotionally moving",
            delivery: "Dynamic energy, powerful cadence, belief-driven",
            pacing: "Building momentum, dynamic variation",
            pitch: "Rises through key moments",
            energy: "High at peaks, intimate at valleys",
            bestFor: "Sports, wellness, self-help, non-profits, causes",
            directionKeywords:
              "inspiring, powerful, uplifting, passionate, moving, aspirational, triumphant, emotional, motivating",
          },
        ),
        voice(
          "vo-formal-professional",
          "Formal professional",
          "Even, structured and clearly enunciated; serious without drama.",
          {
            tone: "Direct, professional, measured, serious",
            delivery: "Clear enunciation, structured, moderate pace",
            pacing: "Even, predictable, structured",
            pitch: "Mid-range, minimal variation",
            energy: "Consistent, controlled, steady",
            bestFor: "Corporate communications, compliance, training, institutional",
            directionKeywords:
              "professional, formal, clear, direct, measured, proper, polished, corporate, institutional",
          },
        ),
        voice(
          "vo-playful-humorous",
          "Playful humorous",
          "Quick, personality-driven delivery that lives on comic timing.",
          {
            tone: "Light, witty, amusing, energetic",
            delivery: "Quick pace, comic timing, personality-driven",
            pacing: "Quick, comedic beats, timing-dependent",
            pitch: "Varied for comedic effect",
            energy: "High, animated, expressive",
            bestFor: "Consumer goods, entertainment, youth brands",
            directionKeywords:
              "fun, witty, playful, energetic, cheeky, humorous, light, entertaining, quirky",
          },
        ),
        voice(
          "vo-hushed-intimate",
          "Hushed intimate",
          "Close-mic, breathy and near-whispered, with slow deliberate pauses.",
          {
            tone: "Soft, whispered, ASMR-like, sensual",
            delivery: "Gentle, close-mic, breathy quality",
            pacing: "Slow, deliberate pauses",
            pitch: "Low, soft register",
            energy: "Low, intimate, personal",
            bestFor: "Luxury, beauty, wellness, premium products",
            directionKeywords:
              "hushed, intimate, whispered, sensual, gentle, soft, close, personal, luxurious",
          },
        ),
        voice(
          "vo-dramatic-narrator",
          "Dramatic narrator",
          "Deep, resonant, theatrical narration that rises and falls toward crescendos.",
          {
            tone: "Epic, cinematic, storytelling, powerful",
            delivery: "Grand delivery, theatrical timing",
            pacing: "Varied, building to crescendos",
            pitch: "Deep, resonant",
            energy: "Rises and falls dramatically",
            bestFor: "Trailers, premium brands, sports",
            directionKeywords:
              "epic, dramatic, powerful, grand, cinematic, storytelling, resonant, theatrical, commanding",
          },
        ),
        voice(
          "vo-youthful-energetic",
          "Youthful energetic",
          "Fast, upbeat and enthusiastic with no dead air.",
          {
            tone: "Excited, enthusiastic, high-energy",
            delivery: "Fast pace, upbeat delivery",
            pacing: "Quick, no dead air",
            pitch: "Higher, varied",
            energy: "Very high, enthusiastic",
            bestFor: "Youth brands, gaming, entertainment, Gen Z",
            directionKeywords:
              "excited, energetic, youthful, enthusiastic, pumped, hyped, dynamic, vibrant, upbeat",
          },
        ),
        voice(
          "vo-calm-reassuring",
          "Calm reassuring",
          "Slow, even and supportive; a voice that lowers the listener's worry.",
          {
            tone: "Soothing, comforting, trustworthy",
            delivery: "Even, gentle, supportive",
            pacing: "Slow, calming",
            pitch: "Mid-low, steady",
            energy: "Low, peaceful",
            bestFor: "Healthcare, insurance, wellness, security",
            directionKeywords:
              "calm, soothing, reassuring, comforting, supportive, gentle, peaceful, secure, trustworthy",
          },
        ),
        voice(
          "vo-deadpan-dry",
          "Deadpan dry",
          "Flat, matter-of-fact delivery with deliberate pauses that let the irony land.",
          {
            tone: "Ironic, understated, clever, flat",
            delivery: "Minimal inflection, matter-of-fact",
            pacing: "Even, deliberate pauses for effect",
            pitch: "Flat, minimal variation",
            energy: "Low, controlled",
            bestFor: "Tech, SaaS, witty brands, young professionals",
            directionKeywords:
              "deadpan, dry, ironic, understated, clever, flat, matter-of-fact, wry, sardonic",
          },
        ),
        voice(
          "vo-real-customer",
          "Real customer",
          "Unscripted, imperfect natural speech from actual users; testimonial authenticity.",
          {
            tone: "Authentic, unscripted, genuine, testimonial",
            delivery: "Natural speech patterns, imperfect",
            pacing: "Varies, natural",
            pitch: "Natural, uncontrolled",
            energy: "Genuine, varied",
            bestFor: "User-generated content, testimonials, community, direct-to-consumer",
            directionKeywords:
              "real, authentic, genuine, testimonial, unscripted, natural, honest, relatable, customer-voice",
          },
        ),
        voice(
          "vo-tech-voice",
          "Tech voice",
          "Clean, neutral and consistently articulated; the sound of an assistant or a product demo.",
          {
            tone: "Clean, precise, futuristic, neutral",
            delivery: "Clear articulation, consistent",
            pacing: "Even, measured",
            pitch: "Neutral, consistent",
            energy: "Controlled, efficient",
            bestFor: "Tech products, AI assistants, product demos, interface audio",
            directionKeywords:
              "clean, precise, tech, neutral, futuristic, articulate, consistent, modern, digital",
          },
        ),
      ],
    },
    {
      id: "voice-casting",
      title: "Voice casting and direction",
      entries: [
        {
          id: "voice-talent-considerations",
          title: "Casting the voice",
          text:
            "Do not default to an 'announcer' voice: match gender presentation, age and accent to the brand and the " +
            "audience. Younger audiences respond to youthful voices, adults to mature ones; represent the target " +
            "market's accents. Keep the same voice across a campaign so it is recognisable.",
          tags: ["casting"],
        },
        {
          id: "voice-direction-template",
          title: "Direction sheet for a voice-over",
          text:
            "Hand the talent or the voice tool one short sheet: who the voice is, a primary tone from the registry, " +
            "energy and pacing levels, a reference described by its traits, and what it must not sound like.",
          fields: {
            voice: "Gender presentation, age range, accent if specific",
            tone: "Primary tone from the voice-over registry",
            energy: "Low, medium or high",
            pacing: "Slow, moderate or fast",
            reference: "A comparable delivery described by traits, never a named person",
            avoid: "What it must not sound like",
          },
          tags: ["direction"],
        },
      ],
    },
    {
      id: "color-meanings",
      title: "Colour psychology",
      entries: [
        {
          id: "color-evidence-rule",
          title: "Colour associations are hypotheses",
          text:
            "Choose colour from brand authority, contrast and readability, cultural context and the message. " +
            "Associations below are starting hypotheses, not universal effects. Appropriateness beats psychology: " +
            "ask whether the colour fits what is being sold. Cite dated, scoped research before claiming a number " +
            "for any effect on purchase, recall or recognition.",
          tags: ["rule"],
        },
        color("color-red", "Red", {
          emotion: "Excitement, urgency, passion, power",
          bestFor: "Calls to action, sales, urgency, action brands",
          caution: "Overstimulating if overused",
        }),
        color("color-blue", "Blue", {
          emotion: "Trust, security, calm, intelligence",
          bestFor: "Finance, tech, SaaS, healthcare",
          caution: "Can feel cold without warm accents",
        }),
        color("color-green", "Green", {
          emotion: "Growth, nature, balance, health",
          bestFor: "Eco, wellness, organic, finance (money)",
          caution: "Meaning depends on culture",
        }),
        color("color-yellow", "Yellow", {
          emotion: "Optimism, warmth, happiness, attention",
          bestFor: "Family brands, attention grabs, warmth",
          caution: "Hard to read, overstimulating",
        }),
        color("color-orange", "Orange", {
          emotion: "Playful, friendly, creative, energetic",
          bestFor: "Creative, youth, friendly brands",
          caution: "Less formal than red or blue",
        }),
        color("color-purple", "Purple", {
          emotion: "Luxury, creativity, royalty, mystery",
          bestFor: "Premium, creative, spiritual",
          caution: "The wrong shade can feel juvenile",
        }),
        color("color-black", "Black", {
          emotion: "Luxury, power, sophistication, elegance",
          bestFor: "Premium, formal, high-end",
          caution: "Needs deliberate white space",
        }),
        color("color-white", "White", {
          emotion: "Clean, pure, simple, fresh",
          bestFor: "Healthcare, minimalist, tech",
          caution: "Feels empty without content or accents",
        }),
        color("color-gray", "Gray", {
          emotion: "Professional, neutral, timeless",
          bestFor: "Corporate, B2B, backgrounds",
          caution: "Uninspiring on its own",
        }),
        color("color-pink", "Pink", {
          emotion: "Nurturing, playful, soft",
          bestFor: "Beauty, playful brands",
          caution: "Risk of gender stereotyping",
        }),
        color("color-brown", "Brown", {
          emotion: "Earthy, warm, stable, natural",
          bestFor: "Organic, craft, heritage",
          caution: "Heavy; needs lighter accents",
        }),
        color("color-gold-silver", "Gold and silver", {
          emotion: "Premium, luxury, prestige",
          bestFor: "Luxury accents, special editions",
          caution: "Overuse feels cheap",
        }),
        {
          id: "color-cultural-variation",
          title: "Cultural variation",
          text:
            "Verify colour meaning for the target market. Red reads as luck in China but danger in much of the West; " +
            "white is purity in the West but mourning in parts of Asia; purple's royal meaning is not global.",
          tags: ["rule", "culture"],
        },
      ],
    },
    {
      id: "color-harmony",
      title: "Colour combinations and palettes",
      entries: [
        {
          id: "harmony-complementary",
          title: "Complementary",
          text: "Opposite hues (blue with orange, red with green): high energy and visual tension.",
        },
        {
          id: "harmony-analogous",
          title: "Analogous",
          text: "Adjacent hues (blue, teal, green): harmony, sophistication, calm.",
        },
        {
          id: "harmony-monochromatic",
          title: "Monochromatic",
          text: "Tints and shades of a single hue: premium, focused, sophisticated.",
        },
        {
          id: "harmony-triadic",
          title: "Triadic",
          text: "Three evenly spaced hues (red, yellow, blue): balanced, vibrant, playful.",
        },
        {
          id: "palette-warm-cool",
          title: "Warm versus cool palettes",
          text:
            "Warm palettes (red, orange, yellow, brown) carry energy, action, urgency and friendliness; cool palettes " +
            "(blue, green, purple) carry calm, trust, stability and professionalism.",
        },
        {
          id: "industry-color-defaults",
          title: "Industry colour defaults and how to break them",
          text:
            "Each industry has expected colours; matching them reads as safe, breaking them reads as a deliberate " +
            "position. Break the convention only with a reason from the brief.",
          fields: {
            finance: "Expected blue, navy, gray; break with green for growth or gold for premium",
            tech: "Expected blue, purple, gradients; break with black for premium or neon for edgy",
            health: "Expected green, blue, white; break with warm colours for wellness",
            beauty: "Expected pink, purple, gold; break with bold colours for edgy brands",
            food: "Expected red, yellow, green; the break depends on positioning",
            luxury: "Expected black, gold, white; break with a monochromatic palette for a modern feel",
            organic: "Expected green, brown, cream; break with blue for a clean or pure angle",
          },
        },
        {
          id: "palette-application-checklist",
          title: "Palette application checklist",
          text:
            "Primary colour matches brand personality; an accent gives contrast and hierarchy; the call to action " +
            "stands out from its surroundings; text is readable on its background; one palette runs across every " +
            "asset; cultural fit is verified.",
          tags: ["checklist"],
        },
      ],
    },
  ],
  checks: [
    {
      id: "creative-direction.text-contrast",
      kind: "hard",
      level: "asset",
      measure:
        "Contrast ratio between on-screen text and the background behind it (accessibility contrast guideline).",
      metric: { id: "text-contrast-ratio-min", unit: "ratio" },
      threshold: { op: ">=", value: 4.5 },
    },
    {
      id: "creative-direction.style-rationale",
      kind: "evidence",
      level: "video",
      measure:
        "The brief names the chosen visual and voice-over styles with a fit argument and a testable hypothesis.",
      judges: ["ai", "human"],
      evidence: ["document"],
      pass:
        "Each choice is justified by the brief's audience, message and brand, and the brief names no audience that " +
        "the style's avoid-for list excludes without saying why.",
    },
    {
      id: "creative-direction.no-unsourced-numbers",
      kind: "evidence",
      level: "job",
      measure:
        "Numerical claims in the brief about the effect of a style or colour (uplift, recall, recognition).",
      judges: ["ai", "human"],
      evidence: ["document"],
      pass: "Every such number cites dated, scoped evidence; otherwise the number is removed.",
    },
    {
      id: "creative-direction.palette-consistency",
      kind: "evidence",
      level: "video",
      measure: "The reviewer looks at frames from every asset of the piece side by side.",
      judges: ["ai", "human"],
      evidence: ["contact-sheet"],
      pass:
        "All assets share one palette, the accent creates hierarchy and the call to action stands out from its " +
        "surroundings.",
    },
    {
      id: "creative-direction.cultural-fit",
      kind: "evidence",
      level: "video",
      measure: "The user reviews colour and style choices against the target market's cultural meanings.",
      judges: ["human"],
      evidence: ["contact-sheet", "document"],
      pass: "The user confirms no colour or style carries an unintended meaning in the target market.",
    },
  ],
};
