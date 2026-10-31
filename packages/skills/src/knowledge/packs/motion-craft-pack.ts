import type { KnowledgePack } from "../knowledge-pack-schema.ts";
import { agentkitSource } from "../knowledge-sources.ts";

const REFS = "kits/marketing/skills/ak-motion-video/references";
const VOX_MIT = "Portions adapted from vox-director under the MIT License, Copyright (c) 2026 Alisa Qian";

export const motionCraftPack: KnowledgePack = {
  id: "motion-craft",
  version: "1.0.0",
  title: "Motion video story and craft",
  summary:
    "Narrative arcs, hooks, pacing, shot sizes and camera moves, plus the production bar for motion video technique.",
  purpose:
    "Plan what a motion video says and in which order (arc, hook, scene count, ending), frame each scene with one " +
    "shot size and one camera move so adjacent scenes never move alike, then execute every scene to a finished " +
    "production bar: one focal point per beat, overlap instead of queueing, designed easing, depth, edited " +
    "rhythm, readable text and continuity across cuts. The style decides which moves are allowed; this pack " +
    "decides how well they are executed.",
  sources: [
    agentkitSource(`${REFS}/story-and-shots.md`, "MV-17", VOX_MIT),
    agentkitSource(`${REFS}/motion-craft.md`, "MV-17", VOX_MIT),
  ],
  phases: ["script", "storyboard", "motion", "composition", "qa"],
  loadWhen: [
    "motion video",
    "explainer",
    "launch video",
    "promo",
    "narrative arc",
    "hook",
    "pacing",
    "shot size",
    "camera move",
    "cut-in",
    "transition",
    "kinetic type",
    "juice",
    "collage",
    "contact sheet",
  ],
  useCases: [
    "Choosing a narrative arc and hook pattern for a short explainer, ad or release video from its topic.",
    "Sizing a 30, 60 or 150 second video into scenes and voice-over word counts before scripting.",
    "Planning a shot size and camera move per scene so no two neighbours move alike and the payoff lands on a still frame.",
    "Raising a motion draft from demo to production: overlap, anticipation, follow-through, depth layers and edited rhythm.",
    "Building paper, print or poster-style scenes from cut-out pieces that fly to their home positions.",
    "Reviewing each scene as a contact sheet against the director's pass before a final render.",
  ],
  antiPatterns: [
    "Spending the opening seconds on set-up instead of the promise.",
    "Every element fading in with opacity only, all at once, with one duration and one curve.",
    "Two adjacent scenes using the same camera move, or a static frame used anywhere except the payoff.",
    "A framing held unchanged for many seconds with nothing moving: dead frames.",
    "Hard cut to empty and rebuild between every scene instead of carrying motion, shape or colour across.",
    "Three equal-energy scenes in a row; the rhythm reads as a template.",
    "Shake, bounce or elastic in a calm, cinematic or premium style whose constraints rule them out.",
    "A hero element crossing the whole frame in every scene, which turns a punch into a formula.",
  ],
  sections: [
    {
      id: "narrative-arcs",
      title: "Narrative arcs",
      entries: [
        {
          id: "planning-tiers",
          title: "Three planning tiers",
          text:
            "The arc is chosen once for the whole video. Scene copy and the hook are drafted per scene from the " +
            "facts; the resulting beat map is shown to the user once before any paid audio is generated, and work " +
            "continues unless they object. Shot size and camera move per scene are derived from the arc position " +
            "and the anti-monotony rule, from a closed vocabulary.",
        },
        {
          id: "arc-hook-payoff",
          title: "Hook and payoff",
          text: "Any single idea; the safe default.",
          fields: {
            shape: "hook, context, build, payoff, button",
            "camera-rhythm": "push-in, pan, parallax, static, push-in, tilt, pull-out, static (eight scenes)",
          },
          tags: ["arc"],
        },
        {
          id: "arc-problem-agitate-solve",
          title: "Problem, agitate, solve",
          text: "Pain-aware ads and urgency.",
          fields: {
            shape: "problem, agitate, solve, proof, call to action",
            "camera-rhythm": "push-in, static, pan, parallax, push-in, static (six scenes)",
          },
          tags: ["arc"],
        },
        {
          id: "arc-before-after-bridge",
          title: "Before, after, bridge",
          text: "When the improved state sells better than the pain.",
          fields: {
            shape: "before, after, bridge, call to action",
            "camera-rhythm": "push-in, static, pan, parallax, push-in, static (six scenes)",
          },
          tags: ["arc"],
        },
        {
          id: "arc-attention-interest-desire-action",
          title: "Attention, interest, desire, action",
          text: "Paid ads for a cold audience.",
          fields: { shape: "attention, interest, desire, action" },
          tags: ["arc"],
        },
        {
          id: "arc-customer-hero",
          title: "Customer as hero",
          text: "A brand or service story where the customer is the hero and the brand is the guide.",
          fields: { shape: "hero wants, problem, guide, plan, call to action, stakes" },
          tags: ["arc"],
        },
        {
          id: "arc-how-it-works",
          title: "How it works",
          text: "Product, process or system explainers.",
          fields: { shape: "hook, what it is, two or three shown steps, benefit, call to action" },
          tags: ["arc"],
        },
        {
          id: "arc-release-tour",
          title: "Release tour",
          text: "Launch and changelog videos; the strongest features go first and last.",
          fields: {
            shape: "hook, headline number, features, stability or proof, outro",
            "camera-rhythm":
              "alternate push-in and parallax across features, static on the headline number, pull-out into the outro",
          },
          tags: ["arc"],
        },
        {
          id: "arc-timeline",
          title: "Timeline",
          text: "History, evolution and journeys.",
          fields: {
            shape: "start, events, turning point, present, takeaway",
            "camera-rhythm":
              "pan and parallax alternating, both travelling one way through time; push-in on the turning point, pull-out on the takeaway",
          },
          tags: ["arc"],
        },
        {
          id: "arc-man-in-hole",
          title: "Man in a hole",
          text: "Case studies, comebacks and transformations.",
          fields: { shape: "fine, fall, deepen, climb out, better than before" },
          tags: ["arc"],
        },
        {
          id: "arc-story-spine",
          title: "Story spine",
          text: "Mission, founder or brand tales.",
          fields: {
            shape: "once upon a time, every day, until one day, because of that, until finally, ever since",
          },
          tags: ["arc"],
        },
        {
          id: "arc-origin",
          title: "Origin",
          text: "Why an organisation exists.",
          fields: { shape: "world, spark, leap, struggle, breakthrough, today" },
          tags: ["arc"],
        },
        {
          id: "arc-myth-buster",
          title: "Myth buster",
          text: "Correcting a misconception.",
          fields: { shape: "fact first, the myth, expose it, what to believe, call to action" },
          tags: ["arc"],
        },
        {
          id: "arc-listicle",
          title: "Listicle",
          text: "Tips, tools and rankings.",
          fields: {
            shape: "promise, items counting down to number one, recap or call to action",
            "camera-rhythm":
              "parallax on number one, then pan and push-in alternating across items with the pan direction flipped each time, static on the recap",
          },
          tags: ["arc"],
        },
        {
          id: "arc-three-act",
          title: "Three acts",
          text: "Any narrative piece.",
          fields: { shape: "setup, confrontation, resolution" },
          tags: ["arc"],
        },
        {
          id: "arc-selection",
          title: "Choosing an arc by topic",
          text:
            "Product ad: problem-agitate-solve, before-after-bridge, attention-interest-desire-action or customer " +
            "as hero. Release or changelog: release tour. Concept or system: how it works or hook and payoff. " +
            "History: timeline. Transformation: man in a hole. Mission: story spine or origin. A wrong belief: " +
            "myth buster. A ranking: listicle.",
        },
        {
          id: "arc-scene-types",
          title: "Arc stages to scene types",
          text:
            "The hook maps to a hook or cover scene, proof to a stats or testimonial scene, steps to feature, " +
            "interface-demo or diagram scenes, the call to action to a CTA scene and the end to an outro.",
        },
      ],
    },
    {
      id: "hook-and-pacing",
      title: "Hook, pacing and scene count",
      entries: [
        {
          id: "hook-first-seconds",
          title: "Hook within three seconds",
          text:
            "The first spoken line and the first on-screen words carry the promise within 3 seconds. Never spend " +
            "the cover on set-up.",
        },
        {
          id: "hook-patterns",
          title: "Hook patterns",
          text:
            "Pick one per video: a mistake callout, a pain point, a surprising statistic, a direct question, an " +
            "urgent warning, a secret reveal, an experiment story, a pattern interrupt or an outcome tease.",
        },
        {
          id: "pacing-proportions",
          title: "Proportions",
          text: "How the running time divides.",
          fields: { hook: "1-3 seconds", body: "70-80%", payoff: "10-20%", ending: "0-2 seconds" },
        },
        {
          id: "scene-count-by-duration",
          title: "Scene count by duration",
          text: "Sized for voice-over at about 150 words per minute.",
          fields: {
            "30-seconds": "6-8 scenes of 4-5 seconds, 70-80 voice-over words",
            "60-seconds": "10-12 scenes of 5-6 seconds, 130-150 words",
            "140-150-seconds": "14-16 scenes of 8-10 seconds each with internal cuts, about 360 words",
          },
        },
        {
          id: "change-cadence",
          title: "Change cadence",
          text:
            "Something visibly changes every 3-5 seconds. A scene longer than about 7 seconds gets an internal " +
            "cut-in, and no framing holds unchanged past 8 seconds.",
        },
        {
          id: "ending-types",
          title: "Endings",
          text: "Pick one ending per video.",
          fields: {
            "hard-cut": "cut on the payoff; encourages rewatching",
            "quick-cta": "2 seconds or less: one action plus its benefit in 3-5 words",
            "loop-close": "the last line mirrors the first so a loop replays seamlessly",
            "signature-outro":
              "a calm outro bed with the user's signature when supplied; the default for releases",
          },
        },
        {
          id: "short-candidates",
          title: "Short-form candidates",
          text:
            "When vertical clips will be wanted, mark candidate scene ranges while planning. A candidate runs " +
            "20-60 seconds, opens on its own hook line and makes one complete point without the scenes around it, " +
            "so its vertical framing can be planned while the context is fresh.",
        },
      ],
    },
    {
      id: "shots",
      title: "Shot sizes and camera moves",
      entries: [
        {
          id: "size-establishing-wide",
          title: "Establishing wide",
          text: "The whole system or diagram in frame; orients the viewer and shows scale.",
          tags: ["shot-size"],
        },
        {
          id: "size-wide",
          title: "Wide",
          text: "The subject in its environment; sets the scene.",
          tags: ["shot-size"],
        },
        {
          id: "size-medium",
          title: "Medium",
          text: "One subject centred; the workhorse for explaining.",
          tags: ["shot-size"],
        },
        {
          id: "size-close",
          title: "Close",
          text: "One detail fills the frame; emphasis and emotion.",
          tags: ["shot-size"],
        },
        {
          id: "size-detail",
          title: "Detail",
          text: "One number, word or texture; a punch moment.",
          tags: ["shot-size"],
        },
        {
          id: "size-progressions",
          title: "Size progressions across scenes",
          text:
            "Build intensity by tightening from establishing wide to medium to close. Reveal context by opening " +
            "from close to wide, which makes a good ending. In a graphic composition, shot size is the camera " +
            "group's scale and which layers are in view.",
        },
        {
          id: "cut-in",
          title: "The cut-in",
          text:
            "The strongest two-shot scene: a wide that orients, then a cut on a spoken keyword to a close of the " +
            "key element while the voice runs on uninterrupted. Do it either as a 0.35-0.5 second eased in-out " +
            "scale and translate of the camera group onto the element at the keyword, or as a hard cut to a " +
            "pre-built close layer on a beat. Use it in any scene longer than about 7 seconds.",
        },
        {
          id: "move-static",
          title: "Static",
          text: "No camera transform beyond a slow settling micro push; lets a statistic or quote land.",
          tags: ["camera-move"],
        },
        {
          id: "move-push-in",
          title: "Push in",
          text: "Camera scale from 1.00 to 1.06-1.12, eased in-out over the hold; tension and focus.",
          tags: ["camera-move"],
        },
        {
          id: "move-pull-out",
          title: "Pull out",
          text: "Camera scale from 1.12 back to 1.00, revealing more layers; the big picture.",
          tags: ["camera-move"],
        },
        {
          id: "move-pan",
          title: "Pan",
          text: "Horizontal travel across a stage wider than the frame; reading a list or a timeline.",
          tags: ["camera-move"],
        },
        {
          id: "move-tilt",
          title: "Tilt",
          text: "Vertical travel across a tall stage; revealing scale or a countdown.",
          tags: ["camera-move"],
        },
        {
          id: "move-parallax",
          title: "Parallax",
          text: "Background, midground and foreground move at about 0.3 : 1 : 1.6; the living, layered look.",
          tags: ["camera-move"],
        },
        {
          id: "move-element",
          title: "Element",
          text: "The camera stays still while one element slides or hinges in; introduces one item.",
          tags: ["camera-move"],
        },
        {
          id: "move-bold",
          title: "Bold moves",
          text:
            "Orbit (a 3D rotation of a perspective group), roll (a few degrees of rotation), whip and dolly zoom " +
            "(background scales up while the subject scales down). Use them only when the style allows and the " +
            "moment earns it; a locked-off style constraint always wins.",
          tags: ["camera-move"],
        },
        {
          id: "camera-on-group",
          title: "Move the camera group, not the text",
          text:
            "Apply one move per shot to the scene's camera group, never to individual text. Uniform translate and " +
            "uniform scale keep type crisp and aligned.",
        },
        {
          id: "anti-monotony",
          title: "Anti-monotony",
          text:
            "The biggest single quality lever, because scenes of one style look alike. No two adjacent scenes use " +
            "the same move. Alternate families: scale moves (push in, pull out), translate moves (pan, tilt, " +
            "parallax) and static; two different translate moves may sit together when the arc travels. Reserve " +
            "static for the payoff, quote or headline number so the drop in motion says this is the point. Under " +
            "a locked-off style use only the moves it names, fill the rest with element moves and keep static for " +
            "the payoff.",
        },
        {
          id: "element-motion",
          title: "Element motion is a separate axis",
          text:
            "One camera move per shot plus as much element motion as the energy budget allows. A wide moves " +
            "several elements a little; a close moves its one subject strongly. A hero element crossing the whole " +
            "frame is a punch for a key scene, not every scene.",
        },
      ],
    },
    {
      id: "production-bar",
      title: "The production bar",
      entries: [
        {
          id: "juice-by-energy",
          title: "Scale the juice to the style's energy",
          text:
            "Juice is the amount of anticipation, overshoot, impact and secondary motion. Read the style's energy " +
            "level and constraints first; a constraint such as no shake or no bounce always wins.",
          fields: {
            "energy-1-2":
              "cinematic, calm, premium: no shake, bounce or elastic; juice comes from easing, overlap, parallax, light sweeps, match-moves and held stillness",
            "energy-3":
              "product, editorial: soft overshoot, smears on interface parts, one soft impact per section on a drop with a flash but no shake",
            "energy-4-5":
              "comic, sport, hype: the full vocabulary of slams, squash and stretch, shake, smear and impact frames, particle bursts on kicks",
          },
        },
        {
          id: "focal-point-per-moment",
          title: "One focal point per moment",
          text: "Decide where the eye goes on every beat and move only what serves it; everything else holds or drifts.",
        },
        {
          id: "no-dead-frames",
          title: "No dead frames",
          text:
            "A hold is at least one beat of stillness for reading, carried by micro-motion: a slow camera push " +
            "from 1.00 to 1.03-1.05, a parallax drift or a light sweep. Nothing on screen is ever fully frozen.",
        },
        {
          id: "overlap-never-queue",
          title: "Overlap, never queue",
          text:
            "The next action starts while the previous one is still settling, 30-60% of the way through it. " +
            "Staggers use an eased distribution (for example from the centre with accelerating offsets), never " +
            "uniform steps.",
        },
        {
          id: "anticipation-follow-through",
          title: "Anticipation, action, follow-through",
          text:
            "Big moves wind up 2-4 frames the other way, overshoot, then settle. Secondary parts (shadows, labels, " +
            "icons, underlines) arrive 2-4 frames after the primary part and settle later.",
        },
        {
          id: "designed-easing",
          title: "Designed easing",
          text:
            "Entrances use a strong exponential or quartic ease-out (fast, then a long settle); camera and layout " +
            "moves use a cubic or exponential in-out; exits run about 60% of the entrance with an ease-in. Never " +
            "linear except for opacity holds and the settling camera push, and never the weakest default ease.",
        },
        {
          id: "arcs-not-rails",
          title: "Arcs, not rails",
          text:
            "Moving objects travel on curves: ease the horizontal and vertical components differently (an " +
            "exponential ease-out on one axis, a gentler in-out on the other), or add a small rotation that " +
            "resolves on landing.",
        },
        {
          id: "continuity-across-cuts",
          title: "Continuity across cuts",
          text:
            "A scene hands off to the next: a shape grows into the next background, the hero shrinks into its " +
            "slot (a match-move), or motion keeps its direction through a whip. Fading to nothing and rebuilding " +
            "is the fallback, not the default.",
        },
        {
          id: "depth-layers",
          title: "Depth",
          text:
            "At least three layers: a background that moves slowest (it may be blurred and pre-rendered), the " +
            "midground content, and a foreground accent (particles, a soft-focus or glass shape, a frame edge) " +
            "moving fastest, at a parallax ratio of about 0.3 : 1 : 1.6.",
        },
        {
          id: "edited-rhythm",
          title: "Rhythm is edited",
          text:
            "Big moves land on downbeats and musical drops, reveals on the spoken keyword, micro accents on " +
            "off-beats. Vary density: calm set-up, build, drop, breathe. Three equal-energy scenes in a row read " +
            "as a template.",
        },
        {
          id: "readable-text",
          title: "Readable text",
          text:
            "Once text settles it holds for at least 0.4 seconds plus 0.06 seconds per word, and no motion runs " +
            "behind a line while it is being read.",
        },
        {
          id: "camera-cadence",
          title: "Cadence and camera variety",
          text:
            "Something visibly changes every 3-5 seconds; a scene longer than about 7 seconds gets an internal " +
            "cut-in so no framing holds past 8 seconds. Adjacent scenes never repeat a camera move.",
        },
      ],
    },
    {
      id: "techniques",
      title: "Technique cookbook",
      entries: [
        {
          id: "tech-slam",
          title: "Slam",
          text:
            "The element lands oversized and blurred exactly on a word onset, squashes for about 3 frames, then " +
            "settles elastically. For hero numbers and titles on a drop.",
        },
        {
          id: "tech-squash-stretch",
          title: "Squash and stretch on landing",
          text:
            "On landing scale to about 1.08 wide by 0.9 tall for 2-3 frames, then settle elastically, keeping " +
            "width times height near 1 so volume is preserved. For mascots, badges and icons.",
        },
        {
          id: "tech-smear",
          title: "Smear frame",
          text:
            "Skew the element in its direction of travel and settle the skew to zero; for a longer blur add two or " +
            "three ghost copies at about 0.35, 0.2 and 0.1 opacity, each trailing by one frame. For fast lateral " +
            "entrances and whip transitions.",
        },
        {
          id: "tech-masked-line-reveal",
          title: "Masked line reveal",
          text:
            "Clip each line to its own box and raise its words from below the mask with a slight rotation that " +
            "resolves. For headlines and kinetic type.",
        },
        {
          id: "tech-kinetic-keyword",
          title: "Kinetic keyword",
          text:
            "On its spoken onset the keyword scales 1 to 1.12 and back, switches to the accent colour and its " +
            "letter spacing tightens slightly. For emphasis inside a sentence.",
        },
        {
          id: "tech-whip-pan",
          title: "Whip pan",
          text:
            "The outgoing stage shoots off one side with a skew over about 0.22 seconds on a sharp ease-in while " +
            "the incoming one arrives from the other side on a sharp ease-out, on a beat, with an optional " +
            "one-frame speed-line layer. For energetic scene changes.",
        },
        {
          id: "tech-zoom-through",
          title: "Zoom-through",
          text:
            "The current scene scales up to about 2.4 and fades out over 0.3 seconds on a sharp ease-in while the " +
            "next scales from 0.85 to 1. For revealing a detail or product.",
        },
        {
          id: "tech-shape-wipe",
          title: "Shape wipe",
          text:
            "An accent block sweeps across, growing from one edge then shrinking to the other, and the scene swaps " +
            "underneath at the midpoint. For clean branded transitions.",
        },
        {
          id: "tech-iris-reveal",
          title: "Iris or clip reveal",
          text:
            "A circular clip opens from a point to beyond the frame on an exponential in-out. For focusing on an " +
            "interface element; clip effects are expensive, so count them against the effect budget.",
        },
        {
          id: "tech-camera-push-rack-focus",
          title: "Camera push and rack focus",
          text:
            "Wrap the scene in a camera group and push slowly during holds; rack focus by cross-swapping blur " +
            "between two pre-rendered layers over about 0.4 seconds. For premium holds and depth.",
        },
        {
          id: "tech-impact-frame",
          title: "Impact frame",
          text:
            "One frame of a bright flash at 0.6-0.9 opacity, then a shake decaying over about 6 frames, with an " +
            "optional two-frame colour-channel split. For drops and big reveals at energy 4 or more.",
        },
        {
          id: "tech-light-sweep",
          title: "Light sweep",
          text:
            "A skewed white gradient bar crosses a card inside its mask over about 0.6 seconds, eased in-out, at " +
            "no more than 0.35 opacity. For premium cards and product glints.",
        },
        {
          id: "tech-particle-burst",
          title: "Particle burst",
          text:
            "8-16 pre-built dots fly outward at seeded random angles and distances on a sharp ease-out, fading " +
            "late with slight gravity. For clicks, unlocks and achievements.",
        },
        {
          id: "tech-counter",
          title: "Counter",
          text:
            "A number counts up decelerating into its value, then bumps to about 1.06 with an accent flash on the " +
            "final digit. For statistics.",
        },
        {
          id: "tech-chart-growth",
          title: "Chart growth",
          text:
            "Bars grow with a soft overshoot, staggered from the tallest; lines draw on with a leading dot riding " +
            "the path. For data scenes.",
        },
        {
          id: "tech-interface-choreography",
          title: "Interface choreography",
          text:
            "The cursor travels on an arc and decelerates, a press is a 0.96 scale for about 3 frames plus a " +
            "ripple, panels cascade with overlap and the result lands with a soft overshoot. For product demos.",
        },
        {
          id: "tech-still-pan",
          title: "Still pan",
          text:
            "A still image slowly scales from 1.00 to 1.08 and drifts 2-4% across the hold on a gentle in-out. For " +
            "photos and generated art when nothing else moves.",
        },
        {
          id: "technique-rules",
          title: "Rules for the cookbook",
          text:
            "Heavy effects (filters, clipping, large gradients) are active only while they run. Shake, whips and " +
            "pans over a full-bleed backdrop run on a stage oversized by about 1.2x so translation never reveals " +
            "an empty edge. A piece that settles over a full backdrop scales with a plain ease-out, not a " +
            "back-style ease, which dips below its final size and briefly shows what is behind it. A technique the " +
            "style rules out is not used even when it would add juice, and when the style gives its own values for " +
            "a technique, those values win.",
        },
      ],
    },
    {
      id: "collage-recipes",
      title: "Collage recipes",
      entries: [
        {
          id: "collage-assembly",
          title: "Collage assembly",
          text:
            "Pre-rendered cut-out pieces start off-frame or oversized and fly to their home positions, so the " +
            "settled frame reconstructs the original poster. Under each piece its home spot on the backdrop is " +
            "blurred, not dimmed, until it lands; this avoids a ghost copy or a dark patch. For paper, print and " +
            "poster styles.",
          tags: ["collage"],
        },
        {
          id: "collage-fly-in",
          title: "Fly-in",
          text:
            "From off-frame on an arc (a sharp ease-out horizontally, a gentle in-out vertically) with 6-15 " +
            "degrees of spin that resolves on landing, then a 2-3 frame settle. For cut-outs, stickers and hero " +
            "props.",
          tags: ["collage"],
        },
        {
          id: "collage-slap",
          title: "Slap",
          text:
            "From about 1.4 scale and a slight blur straight onto its spot in 4-6 frames on a sharp ease-out, then " +
            "a soft shake of the parent. For stamps, labels and cut-out headlines.",
          tags: ["collage"],
        },
        {
          id: "collage-drop",
          title: "Drop",
          text:
            "From above with a bounce ease-out while the shadow tightens and darkens on landing. For pieces landing " +
            "on a desk or board.",
          tags: ["collage"],
        },
        {
          id: "collage-pop-settle",
          title: "Pop-settle",
          text:
            "In place and opaque, scaling from about 1.35 to 1.00 on a cubic ease-out with no travel, so it cannot " +
            "ghost over a full backdrop. For focusing one piece of a full poster.",
          tags: ["collage"],
        },
        {
          id: "collage-sway-breathe",
          title: "Sway and breathe",
          text:
            "After landing, a seeded low-frequency rotation of 1-2 degrees and a scale between 1.00 and 1.015, " +
            "back and forth with a finite number of repeats sized to the hold. For settled pieces during holds.",
          tags: ["collage"],
        },
        {
          id: "collage-confetti-drift",
          title: "Confetti drift",
          text:
            "20-40 pre-built scraps in the palette's colours drift and rotate slowly through the whole scene on " +
            "seeded paths, with a denser burst on a drop. Tactile energy for paper, pop and party styles.",
          tags: ["collage"],
        },
      ],
    },
    {
      id: "demo-to-production",
      title: "Replacing demo tells",
      entries: [
        {
          id: "tell-opacity-only",
          title: "Opacity-only entrances",
          text:
            "Give each element an entrance verb instead: rise out of a mask, slam, smear, draw, or grow from its " +
            "anchor.",
        },
        {
          id: "tell-uniform-timing",
          title: "One duration and ease everywhere",
          text: "Vary duration with mass and distance; small interface parts move faster than big panels.",
        },
        {
          id: "tell-simultaneous-start",
          title: "Everything starts together",
          text: "Choreograph overlap with a clear lead element.",
        },
        {
          id: "tell-flat-centred",
          title: "Centred text on a flat background, scene after scene",
          text:
            "Frame compositions: asymmetric layouts, scale contrast, depth layers, product interface shown in " +
            "context.",
        },
        {
          id: "tell-identical-scenes",
          title: "Every scene built the same way",
          text: "Give each scene type its own choreography and keep recurring types consistent with one reference.",
        },
        {
          id: "tell-hard-cut-rebuild",
          title: "Hard cut, then rebuild from empty",
          text: "Use transitions that carry motion, shape or colour into the next scene.",
        },
        {
          id: "tell-dead-stop",
          title: "Motion stops dead at the end of a tween",
          text: "Overshoot and settle, then keep micro-motion going until the exit.",
        },
        {
          id: "tell-placeholder",
          title: "Placeholder copy and stock styling",
          text: "Use real facts, designed components and textured surfaces instead of default borders and stock gradients.",
        },
      ],
    },
    {
      id: "review",
      title: "Review",
      entries: [
        {
          id: "directors-pass",
          title: "Director's pass per scene",
          text:
            "Before the final render, check every scene: the focal point of every beat is obvious and the hero " +
            "moment lands on the spoken keyword or a drop; there are three depth layers and something keeps " +
            "moving during holds; every entrance has anticipation or a mask and every landing has follow-through; " +
            "the exit hands off to the next scene; the camera move differs from the neighbours' and a long scene " +
            "has a cut-in; text is readable for its full hold and captions and signature are untouched; the juice " +
            "matches the style's energy and constraints.",
        },
        {
          id: "contact-sheet-review",
          title: "Review motion with contact sheets",
          text:
            "Stills hide motion problems and watching full renders is slow. Render one draft and read each scene " +
            "as a contact sheet of 18 small frames spread evenly across the scene: it covers the entrance, holds, " +
            "exit and handoff and shows whether moves overlap, overshoot and settle and whether any stretch is " +
            "dead. For a fast entrance add a second sheet of the scene's first second. Re-render only when the " +
            "choreography changed.",
        },
      ],
    },
  ],
  checks: [
    {
      id: "motion-craft.hook-within-3s",
      kind: "hard",
      level: "video",
      measure:
        "Time from the start of the video to the first spoken line or on-screen words that state the promise.",
      metric: { id: "hook-onset-s", unit: "seconds" },
      threshold: { op: "<=", value: 3 },
    },
    {
      id: "motion-craft.max-unchanged-hold",
      kind: "hard",
      level: "shot",
      measure:
        "Longest stretch during which the framing holds without a visible change (cut-in, move or reveal).",
      metric: { id: "unchanged-hold-max-s", unit: "seconds" },
      threshold: { op: "<=", value: 8 },
    },
    {
      id: "motion-craft.long-scene-cut-in",
      kind: "hard",
      level: "video",
      measure: "Scenes longer than the cut-in length that have no internal cut-in.",
      metric: { id: "long-scenes-without-cut-in", unit: "count" },
      threshold: { op: "==", value: 0 },
      params: { sceneLengthS: 7 },
    },
    {
      id: "motion-craft.text-read-time",
      kind: "hard",
      level: "scene",
      measure:
        "Text blocks whose settled hold is shorter than the base time plus the per-word time multiplied by their " +
        "word count.",
      metric: { id: "text-holds-below-read-time", unit: "count" },
      threshold: { op: "==", value: 0 },
      params: { baseS: 0.4, perWordS: 0.06 },
    },
    {
      id: "motion-craft.depth-layers",
      kind: "hard",
      level: "scene",
      measure:
        "Distinct depth layers moving at different parallax rates (background, midground, foreground accent).",
      metric: { id: "depth-layer-count", unit: "count" },
      threshold: { op: ">=", value: 3 },
    },
    {
      id: "motion-craft.quick-cta-length",
      kind: "hard",
      level: "scene",
      measure: "Length of the closing call to action when the ending is a quick CTA.",
      metric: { id: "quick-cta-length-s", unit: "seconds" },
      threshold: { op: "<=", value: 2 },
    },
    {
      id: "motion-craft.short-candidate-length",
      kind: "hard",
      level: "video",
      measure: "Running time of each scene range marked as a short-form candidate.",
      metric: { id: "short-candidate-length-s", unit: "seconds" },
      threshold: { op: "between", min: 20, max: 60 },
    },
    {
      id: "motion-craft.camera-variety",
      kind: "evidence",
      level: "video",
      measure: "The reviewer lists the shot size and camera move of each scene in cut order.",
      judges: ["ai", "human"],
      evidence: ["document"],
      pass:
        "No two adjacent scenes share a camera move, every move is allowed by the style, and static is kept for " +
        "the payoff, quote or headline number.",
    },
    {
      id: "motion-craft.directors-pass",
      kind: "evidence",
      level: "scene",
      measure: "The reviewer reads each scene's contact sheet against the director's pass.",
      judges: ["ai", "human"],
      evidence: ["contact-sheet"],
      pass:
        "Every item of the director's pass holds: clear focal point, hero on the keyword or drop, three depth " +
        "layers, no dead stretch, anticipation and follow-through, a handoff to the next scene.",
    },
    {
      id: "motion-craft.juice-matches-energy",
      kind: "evidence",
      level: "video",
      measure:
        "The reviewer compares the impacts, overshoot, shake and bounce used with the style's energy and constraints.",
      judges: ["ai", "human"],
      evidence: ["clip", "document"],
      pass: "No technique the style rules out appears, and the amount of juice fits the style's energy level.",
    },
    {
      id: "motion-craft.beat-map-shown",
      kind: "evidence",
      level: "job",
      measure: "The user is shown the beat map (arc, hook, scene copy) before any paid audio is generated.",
      judges: ["human"],
      evidence: ["document"],
      pass: "The user has seen the beat map and raised no objection before paid audio generation starts.",
    },
  ],
};
