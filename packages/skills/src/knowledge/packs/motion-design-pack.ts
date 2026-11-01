import type { KnowledgePack } from "../knowledge-pack-schema.ts";
import { agentkitSource } from "../knowledge-sources.ts";

const SKILL = "kits/marketing/skills/ak-motion-design";
const LOTTIE_MIT = "Adapted from material under the MIT License, Copyright (c) 2025 LottieFiles";
const md01 = (path: string) => agentkitSource(`${SKILL}/${path}`, "MD-01", LOTTIE_MIT);
const md02 = (path: string) => agentkitSource(`${SKILL}/${path}`, "MD-02", LOTTIE_MIT);

export const motionDesignPack: KnowledgePack = {
  id: "motion-design",
  version: "1.0.0",
  title: "Motion design principles",
  summary:
    "Emotion-led motion: personality archetypes, durations, easing, stagger, choreography, patterns and QA.",
  purpose:
    "Decide how things move before deciding what moves them: name the emotional target, pick one motion " +
    "personality, choose the minimum properties, size durations to element weight and distance, use " +
    "directional easing and choreograph several elements so one hero leads and the eye can follow. The pack is " +
    "principles only; implementation-specific values (exact keyframes or library props) are left to the stage " +
    "that renders the motion.",
  sources: [
    md01("SKILL.md"),
    md01("director/choreography.md"),
    md01("director/context-adaptation.md"),
    md01("director/core-philosophy.md"),
    md01("director/decision-framework.md"),
    md01("director/disney-principles.md"),
    md01("director/emotion-mapping.md"),
    md01("director/motion-personality.md"),
    md01("director/narrative-structure.md"),
    md02("patterns/ambient-continuous.md"),
    md02("patterns/entrance-exit.md"),
    md02("patterns/multi-element.md"),
    md02("patterns/state-feedback.md"),
    md02("reference/property-selection.md"),
    md02("reference/quality-checklist.md"),
    md02("reference/timing-easing-tables.md"),
    md02("reference/troubleshooting.md"),
    md02("references/easing-selection.md"),
  ],
  phases: ["design", "motion", "composition", "qa"],
  loadWhen: [
    "animation",
    "motion",
    "easing",
    "timing",
    "duration",
    "stagger",
    "choreography",
    "transition",
    "micro-interaction",
    "overshoot",
    "spring",
    "entrance",
    "exit",
    "loading state",
    "ambient motion",
  ],
  useCases: [
    "Setting a motion direction for a new piece: emotional target, personality archetype, signature easing and a three-step duration palette.",
    "Choosing duration and easing for one element from its type, weight and travel distance.",
    "Choreographing a multi-element reveal so a hero leads, supporting elements stagger within budget and no more than a third move at once.",
    "Designing success, error, loading and hover feedback that is fast, legible and consistent with the chosen personality.",
    "Reviewing a motion draft against the quality checklist and diagnosing why it looks robotic, slow, flat or distracting.",
  ],
  antiPatterns: [
    "Linear easing on spatial movement; it reads as mechanical.",
    "An important state change carried by opacity alone, which viewers miss.",
    "One duration and one curve for every element regardless of size, weight or distance.",
    "Everything starting and stopping together instead of a staggered, overlapping sequence with a clear lead.",
    "Several heroes competing in the same moment, or ambient motion loud enough to steal focus.",
    "A long uninterrupted slide across most of the frame with no intermediate keyframe.",
    "Mixing archetypes freely so the piece has no recognisable motion identity.",
    "Decorative stagger that delays something the viewer needs to act on or read.",
  ],
  sections: [
    {
      id: "workflow",
      title: "Motion workflow",
      entries: [
        {
          id: "when-to-apply",
          title: "Which lens to reach for",
          text:
            "Functional motion (feedback, guidance) is governed by timing for responsiveness; brand expression by " +
            "the personality archetypes; storytelling and attention by the animation principles and choreography; " +
            "complex multi-element scenes by the one-third rules and stagger budgets.",
        },
        {
          id: "eight-step-checklist",
          title: "Eight-step checklist for new choreography",
          text:
            "1. Name the emotional target (joy, calm, urgency, elegance). 2. Pick the motion personality. " +
            "3. Pick the primary property (position, scale, rotation, opacity). 4. Set duration from the duration " +
            "table. 5. Pick the easing family: entrances decelerate, exits accelerate. 6. Identify the hero and " +
            "stage it. 7. Add secondary and ambient layers only if they help. 8. Apply the one-third rules for " +
            "travel distance and simultaneous elements. For a targeted fix, reuse the established personality and " +
            "timing and inspect only the affected interaction.",
          tags: ["checklist"],
        },
        {
          id: "three-pillars",
          title: "Three pillars",
          text:
            "Emotional intent (what the viewer should feel) drives easing, timing and amplitude. Visual narrative " +
            "(the micro-story) drives the setup, action and resolution shape. Motion craft (believability) drives " +
            "physics, secondary motion and paths: arcs for organic things, straight lines for mechanical ones, " +
            "duration proportional to size and distance, and nothing starting and stopping all at once. Simple " +
            "feedback fixes need not invent a narrative or a personality.",
        },
        {
          id: "motion-layers",
          title: "Primary, secondary and ambient layers",
          text:
            "Primary is the action the viewer follows. Secondary adds supporting richness (shadows, icons " +
            "shifting), offset after the primary with a different easing. Ambient is slow continuous background " +
            "life that never demands attention. Add the extra layers only when they support the brief.",
          fields: {
            primary: "100% amplitude",
            secondary: "30-50% of primary amplitude, starting 50-100ms after it",
            ambient: "10-20% of primary amplitude, continuous and slow",
          },
        },
        {
          id: "attention-budget",
          title: "Attention budget",
          text:
            "One hero motion per moment, at most two or three elements in active motion at once, stagger rather " +
            "than synchronise. Ambient motion does not count against the budget.",
        },
      ],
    },
    {
      id: "personality",
      title: "Motion personality",
      entries: [
        {
          id: "personality-playful",
          title: "Playful",
          text:
            "Bounce settles, squash and stretch on press, rotation wobble, bright colour pops and varied stagger " +
            "timing. Paths are arcs, never straight.",
          fields: {
            duration: "150-300ms",
            easing: "back-style ease-out or bouncy springs",
            overshoot: "10-20%",
            "squash-stretch": "yes, on impacts",
            palette: "quick 150ms, standard 250ms, slow 400ms",
            entrance: "bounce up from below",
            keywords: "fun, whimsical, bouncy, cute, friendly",
            "use-for":
              "children's apps, casual games, social content, celebrations, onboarding, creative tools",
          },
        },
        {
          id: "personality-premium",
          title: "Premium",
          text:
            "Slow fades, subtle scale (98% to 100%), generous pauses, minimal properties (opacity plus one), smooth " +
            "curves and subtle parallax. Never squash and stretch.",
          fields: {
            duration: "350-600ms",
            easing: "cubic-bezier(0.4, 0, 0.2, 1)",
            overshoot: "0%",
            "squash-stretch": "never",
            palette: "quick 350ms, standard 500ms, slow 800ms",
            entrance: "slow fade with scale 98% to 100%",
            keywords: "elegant, minimal, luxury, sophisticated",
            "use-for": "fashion, finance, luxury goods, premium software, portfolios, editorial",
          },
        },
        {
          id: "personality-corporate",
          title: "Corporate",
          text:
            "Consistent timing, clear state transitions, functional and predictable motion, uniform stagger. " +
            "Paths mostly straight with small arcs for emphasis.",
          fields: {
            duration: "200-400ms",
            easing: "cubic-bezier(0.2, 0, 0, 1)",
            overshoot: "0-3%",
            "squash-stretch": "no",
            palette: "quick 200ms, standard 300ms, slow 450ms",
            entrance: "slide right with opacity",
            keywords: "clean, professional, business, dashboard",
            "use-for": "enterprise tools, dashboards, admin, healthcare, banking",
          },
        },
        {
          id: "personality-energetic",
          title: "Energetic",
          text:
            "Large scale changes (50-150%), fast colour transitions, particle bursts, accelerating stagger, bold " +
            "entrances from the edge, dramatic diagonal arcs and exaggerated squash and stretch.",
          fields: {
            duration: "100-250ms",
            easing: "exponential ease-out or elastic",
            overshoot: "15-30%",
            "squash-stretch": "yes, exaggerated",
            palette: "quick 100ms, standard 180ms, slow 300ms",
            entrance: "snap in from the edge with overshoot",
            keywords: "dynamic, energetic, bold, exciting",
            "use-for": "gaming, sports, music, events, marketing, fitness",
          },
        },
        {
          id: "personality-defaults",
          title: "Picking an archetype",
          text:
            "Reuse the project's existing motion identity when there is one. Otherwise match the brief's keywords " +
            "to an archetype; with no keywords, default to Corporate for interface motion and Playful for " +
            "illustration.",
        },
        {
          id: "brand-motion-identity",
          title: "Brand motion identity",
          text:
            "Define three constants and reuse them everywhere: one signature easing used for about 80% of " +
            "animations, a duration palette of three tiers (quick, standard, slow) and one consistent entrance " +
            "pattern. Establish them only when new brand motion is requested; a local fix does not need a system.",
        },
        {
          id: "mixing-archetypes",
          title: "Mixing archetypes",
          text:
            "Keep about 90% of motion in the primary archetype; specific moments may borrow another (a corporate " +
            "dashboard borrowing Playful for its success state only). Ease into a personality shift, do not snap.",
        },
      ],
    },
    {
      id: "timing",
      title: "Duration and timing",
      entries: [
        {
          id: "duration-by-element",
          title: "Duration by element type",
          text:
            "Starting ranges, not universal limits; tune them to distance, device, repetition and existing motion " +
            "tokens.",
          fields: {
            "tooltip-micro-feedback": "80-120ms, must feel instant",
            "button-toggle": "120-180ms, responsive feedback",
            "icon-transition": "150-250ms, clear state change",
            "card-enter-exit": "200-350ms, spatial awareness",
            "modal-dialog": "300-400ms, focus shift",
            "page-transition": "400-600ms, context switch",
            "dramatic-reveal": "600-1200ms, theatrical build",
            ambient: "2000-20000ms per cycle",
          },
        },
        {
          id: "distance-scaling",
          title: "Distance scales duration",
          text: "Longer travel needs more time; scale the base duration by distance travelled.",
          fields: {
            "50px": "0.8x",
            "100px": "1.0x (base)",
            "200px": "1.3x",
            "300px": "1.5x",
            "400px": "1.6x",
            "full-screen": "1.8-2.0x",
          },
        },
        {
          id: "enter-exit-asymmetry",
          title: "Entrances outlast exits",
          text:
            "Viewers care about what appears more than what leaves, so an exit runs about 65-75% of its paired " +
            "entrance (equivalently, the entrance is 30-50% longer).",
        },
        {
          id: "interactive-feedback-latency",
          title: "Interactive feedback timing",
          text: "Feedback for direct interaction must start fast; settling may take longer.",
          fields: {
            hover: "under 100ms",
            "press-tap": "under 150ms",
            "release-settle": "200-300ms",
            "error-shake": "300-400ms with 2-3 oscillations",
            "long-press": "500-800ms",
            "drag-start": "under 50ms",
          },
        },
        {
          id: "weight-heavy",
          title: "Heavy elements",
          text: "Modals and overlays: gentle, highly damped motion with no overshoot.",
          fields: { duration: "300-500ms", overshoot: "0%" },
          tags: ["weight"],
        },
        {
          id: "weight-medium",
          title: "Medium elements",
          text: "Cards and panels: moderate easing with a small overshoot.",
          fields: { duration: "200-350ms", overshoot: "3-5%" },
          tags: ["weight"],
        },
        {
          id: "weight-light",
          title: "Light elements",
          text: "Tooltips, badges and icons: responsive easing and a livelier overshoot.",
          fields: { duration: "80-200ms", overshoot: "5-15%" },
          tags: ["weight"],
        },
      ],
    },
    {
      id: "stagger",
      title: "Stagger",
      entries: [
        {
          id: "stagger-micro-cascade",
          title: "Micro cascade",
          text: "Tight ripple through many small items.",
          fields: { delay: "20-40ms", "total-budget": "under 200ms", "use-for": "list items, grid cells" },
        },
        {
          id: "stagger-standard",
          title: "Standard stagger",
          text: "The everyday interface cascade.",
          fields: {
            delay: "50-100ms",
            "total-budget": "under 400ms",
            "use-for": "cards, panels, navigation",
          },
        },
        {
          id: "stagger-dramatic",
          title: "Dramatic stagger",
          text: "A slower build for a hero section.",
          fields: { delay: "100-200ms", "total-budget": "under 600ms", "use-for": "hero sections" },
        },
        {
          id: "stagger-wave",
          title: "Wave stagger",
          text: "Sine-shaped offsets for continuous series.",
          fields: { delay: "30-60ms", "total-budget": "under 500ms", "use-for": "data visualisations, bars" },
        },
        {
          id: "stagger-order",
          title: "Stagger order",
          text:
            "Sequential follows reading order (lists, grids); center-out radiates from the middle (hero content, " +
            "ripples); random varies timing for organic, particle-like groups; wave is sine-based for data; " +
            "reverse runs bottom to top for exits and backward navigation.",
        },
        {
          id: "stagger-rules",
          title: "Stagger rules",
          text:
            "All staggered elements share one easing family and vary only their start time, not their curve. The " +
            "last element may get a slight overshoot as punctuation. For routine interface motion keep the whole " +
            "stagger within 500ms; narrative sequences may set a different budget, but never delay essential " +
            "interaction for decoration.",
        },
      ],
    },
    {
      id: "easing",
      title: "Easing",
      entries: [
        {
          id: "directional-easing",
          title: "Directional easing rules",
          text:
            "Entrances decelerate (ease-out: fast start, gentle landing). Exits accelerate (ease-in: gentle start, " +
            "fast departure). On-screen moves ease both ends (ease-in-out). Ambient loops use a sine-based " +
            "ease-in-out so they are seamless. Linear is only for rotation, progress bars and timers.",
        },
        {
          id: "ease-standard",
          title: "Standard (snappy)",
          text: "Default for on-screen moves; fast and decisive. Corporate signature curve.",
          fields: {
            curve: "cubic-bezier(0.2, 0, 0, 1)",
            "use-for": "default on-screen motion, snappy interface",
          },
          tags: ["easing-curve"],
        },
        {
          id: "ease-emphasized-decelerate",
          title: "Emphasized decelerate",
          text: "A strong, quick arrival with a long gentle tail.",
          fields: { curve: "cubic-bezier(0.05, 0.7, 0.1, 1)", "use-for": "entrances, drawing attention" },
          tags: ["easing-curve"],
        },
        {
          id: "ease-decelerate",
          title: "Decelerate",
          text: "Pure deceleration for elements entering the frame.",
          fields: { curve: "cubic-bezier(0, 0, 0, 1)", "use-for": "entering elements" },
          tags: ["easing-curve"],
        },
        {
          id: "ease-accelerate",
          title: "Accelerate",
          text: "Gentle start and fast departure.",
          fields: { curve: "cubic-bezier(0.3, 0, 1, 1)", "use-for": "exits, dismissals" },
          tags: ["easing-curve"],
        },
        {
          id: "ease-common-default",
          title: "Common default ease",
          text: "The familiar general-purpose ease that many platforms use when nothing is specified.",
          fields: { curve: "cubic-bezier(0.25, 0.1, 0.25, 1)", "use-for": "standard platform-native motion" },
          tags: ["easing-curve"],
        },
        {
          id: "ease-gentle",
          title: "Gentle float",
          text: "Smooth symmetrical-feeling curve. Premium and elegance signature curve.",
          fields: {
            curve: "cubic-bezier(0.4, 0, 0.2, 1)",
            "use-for": "ambient and background motion, premium",
          },
          tags: ["easing-curve"],
        },
        {
          id: "ease-bounce-settle",
          title: "Bounce settle",
          text: "Overshoots the target and settles back.",
          fields: { curve: "cubic-bezier(0.175, 0.885, 0.32, 1.275)", "use-for": "overshoot, playful" },
          tags: ["easing-curve"],
        },
        {
          id: "ease-elastic-snap",
          title: "Elastic snap",
          text: "Pulls back before leaving and overshoots on arrival.",
          fields: { curve: "cubic-bezier(0.68, -0.55, 0.265, 1.55)", "use-for": "dramatic moments" },
          tags: ["easing-curve"],
        },
        {
          id: "spring-interactive",
          title: "Interactive spring",
          text: "Physics spring for direct-manipulation feedback.",
          fields: { stiffness: "300", damping: "20", "use-for": "interactive feedback" },
          tags: ["easing-curve", "spring"],
        },
        {
          id: "spring-parameters",
          title: "Spring parameter ranges",
          text:
            "Pick stiffness and damping by feel. As a damping ratio: below 1.0 oscillates, exactly 1.0 is the " +
            "fastest settle without oscillation, above 1.0 settles slowly. Increase damping when an overshoot " +
            "settle drags.",
          fields: {
            "very-stiff": "stiffness 400+, damping 25-30",
            standard: "stiffness 250-350, damping 18-24",
            bouncy: "stiffness 150-250, damping 10-15",
            "very-bouncy": "stiffness 100-200, damping 5-10",
            gentle: "stiffness 100-150, damping 20-25",
          },
          tags: ["spring"],
        },
        {
          id: "material-easing",
          title: "Material-based duration and overshoot",
          text: "Let the implied physical material scale duration and overshoot.",
          fields: {
            "rigid-metal-stone": "1.2x duration, 0% overshoot",
            "elastic-rubber-gel": "0.8x duration, 15-25% overshoot",
            "fluid-water-paint": "1.5x duration, 5% overshoot",
            "paper-cards-sheets": "1.0x duration, 3-5% overshoot",
            "gas-smoke-fog": "2.0x duration, 0% overshoot",
            "glass-brittle": "0.9x duration, 0% overshoot",
          },
        },
        {
          id: "overshoot-budget",
          title: "Overshoot budget by context",
          text: "How far past the target a move may travel before settling.",
          fields: {
            success: "5-10%",
            error: "0%",
            feedback: "2-5%",
            celebration: "15-25%",
            premium: "0%",
          },
        },
      ],
    },
    {
      id: "choreography",
      title: "Choreography",
      entries: [
        {
          id: "lead-with-hero",
          title: "Lead with the hero",
          text:
            "The hero enters first or most prominently, with the largest displacement and the most " +
            "attention-grabbing easing; supporting elements are subtler in every dimension.",
        },
        {
          id: "shared-origin",
          title: "Spatial origin consistency",
          text:
            "Elements enter from the same direction or a shared origin; mixed directions read as chaos. When one " +
            "trigger moves several elements, motion originates at the trigger, nearer elements go first and " +
            "farther ones get more delay.",
        },
        {
          id: "counter-motion",
          title: "Counter-motion",
          text: "A slower opposing move balances the hero and adds depth.",
          fields: {
            "hero-enters-or-slides": "background shifts the opposite way at 20-30% of the speed",
            "hero-scales-up": "shadow scales down or spreads at 10-20%",
            "hero-rotates": "ambient drifts the other way at 15-25%",
            "hero-lifts": "shadow spreads and softens at 20-30%",
            "hero-expands": "siblings compress",
          },
        },
        {
          id: "sequence-phases",
          title: "Setup, action, resolution",
          text:
            "Even a 200ms fade has an implicit setup, action and resolution. Leave 100-200ms of stillness after " +
            "the resolution before new motion starts.",
          fields: {
            setup: "20-30% of the duration: elements enter, scene establishes",
            action: "30-40%: primary motion, the hero moment",
            resolution: "30-40%: settle, secondary reactions, breathing",
          },
        },
        {
          id: "one-third-distance",
          title: "One-third rule for distance",
          text:
            "No motion travels more than a third of the screen or container without an intermediate keyframe; " +
            "break long paths with a direction change, a speed change or an arc adjustment so the eye can follow.",
        },
        {
          id: "one-third-elements",
          title: "One-third rule for elements",
          text:
            "With three or more animated elements, no more than a third are in active motion at once. Stagger so " +
            "the first element settles as the third one starts.",
        },
        {
          id: "shared-motion-events",
          title: "Shared motion events",
          text:
            "When several elements react to one trigger they all start within 50ms of each other, use one easing " +
            "family and may land at different times.",
        },
        {
          id: "attention-direction",
          title: "Directing attention",
          text:
            "Leading motion animates the target before its context; following motion settles on the focal point; " +
            "peripheral ambient motion stays subtle and continuous; pointing motion moves toward the call to action.",
        },
        {
          id: "depth-through-speed",
          title: "Depth through speed",
          text: "Nearer layers travel farther and faster.",
          fields: { foreground: "1.0x displacement", midground: "0.5x", background: "0.2x" },
        },
        {
          id: "timing-overlap",
          title: "Timing overlap sets tempo",
          text:
            "How much consecutive moves overlap sets the feel: none is methodical, a quarter is brisk (the " +
            "standard), half is fluid, three quarters is rapid (energetic).",
        },
        {
          id: "group-rules",
          title: "Group easing",
          text:
            "Elements of one group share an easing family; durations and delays may differ. Secondary and ambient " +
            "layers may use a different curve.",
        },
      ],
    },
    {
      id: "emotion-mapping",
      title: "Emotion to motion",
      entries: [
        {
          id: "emotion-joy",
          title: "Joy and delight",
          text: "Bouncy, arcing, with overshoot.",
          fields: { path: "curved, upward", easing: "back-style ease-out", duration: "200-400ms" },
          tags: ["emotion"],
        },
        {
          id: "emotion-calm",
          title: "Calm",
          text: "Smooth and flowing.",
          fields: { path: "gentle curves", easing: "sine ease-in-out", duration: "500-1000ms" },
          tags: ["emotion"],
        },
        {
          id: "emotion-urgency",
          title: "Urgency and alert",
          text: "Sharp, fast and direct.",
          fields: { path: "straight lines", easing: "snappy ease-out", duration: "100-200ms" },
          tags: ["emotion"],
        },
        {
          id: "emotion-sadness",
          title: "Sadness and weight",
          text: "Slow and downward.",
          fields: { path: "drooping curves", easing: "cubic ease-in-out", duration: "600-1200ms" },
          tags: ["emotion"],
        },
        {
          id: "emotion-surprise",
          title: "Surprise and impact",
          text: "Sudden and expanding.",
          fields: { path: "radial outward", easing: "exponential ease-out", duration: "150-300ms" },
          tags: ["emotion"],
        },
        {
          id: "emotion-elegance",
          title: "Elegance",
          text: "Slow and controlled.",
          fields: { path: "long smooth arcs", easing: "cubic-bezier(0.4, 0, 0.2, 1)", duration: "400-700ms" },
          tags: ["emotion"],
        },
        {
          id: "emotion-playfulness",
          title: "Playfulness",
          text: "Bouncy and irregular.",
          fields: { path: "arcs, squiggles", easing: "back-style ease-out", duration: "200-350ms" },
          tags: ["emotion"],
        },
        {
          id: "emotion-confidence",
          title: "Confidence",
          text: "Direct and decisive.",
          fields: { path: "straight, horizontal", easing: "strong ease-out", duration: "200-400ms" },
          tags: ["emotion"],
        },
        {
          id: "emotion-trust",
          title: "Trust",
          text: "Smooth and predictable.",
          fields: { path: "gentle curves", easing: "gentle ease", duration: "300-400ms" },
          tags: ["emotion"],
        },
        {
          id: "emotion-curiosity",
          title: "Curiosity",
          text: "Exploratory and varied.",
          fields: { path: "mixed, circular", easing: "varied", duration: "300-500ms" },
          tags: ["emotion"],
        },
        {
          id: "emotion-tenderness",
          title: "Tenderness",
          text: "Soft and gentle.",
          fields: { path: "very subtle curves", easing: "soft ease-in-out", duration: "600-1000ms" },
          tags: ["emotion"],
        },
        {
          id: "path-language",
          title: "Path as emotional language",
          text: "The shape of the path carries meaning on its own.",
          fields: {
            angular: "tense, urgent, mechanical",
            curved: "relaxed, friendly, organic",
            spiral: "playful, whimsical",
            diagonal: "dynamic, purposeful",
            "vertical-up": "growth, achievement",
            "vertical-down": "settling, gravity",
            horizontal: "journey, progress",
            "radial-outward": "explosion, release",
            "radial-inward": "focus, convergence",
          },
        },
        {
          id: "emotional-intensity",
          title: "Intensity matches importance",
          text:
            "Low intensity (subtle opacity, tiny shifts) for ambient and routine motion; medium (visible, not " +
            "demanding) for most interactions; high (large displacement, demands attention) for errors, " +
            "celebrations and onboarding.",
        },
        {
          id: "colour-pairing",
          title: "Colour and motion pairing",
          text: "Pair a colour's emotional read with matching motion.",
          fields: {
            blue: "trust, calm: smooth medium transitions",
            green: "success, growth: upward expansion, gentle overshoot",
            red: "alert: sharp, fast horizontal shakes",
            orange: "energy, warmth: bouncy diagonal paths",
            purple: "premium, mystery: slow reveals, elegant easing",
            yellow: "optimism, caution: quick pulses",
            teal: "modern clarity: clean snappy transitions",
          },
        },
        {
          id: "colour-transition-rules",
          title: "Colour transition rules",
          text:
            "Success transitions to green rather than starting green. Error flashes red then settles; it is not " +
            "sustained. Warning pulses amber. Neutral changes use opacity rather than colour.",
        },
        {
          id: "context-emotion-defaults",
          title: "Default emotion by context",
          text: "A starting emotional target when the brief does not name one.",
          fields: {
            "form-success": "joy and confidence",
            "validation-error": "mild urgency",
            "page-load": "calm and confidence",
            navigation: "confidence",
            notification: "mild surprise",
            loading: "calm",
            onboarding: "curiosity and delight",
            dashboard: "calm and confidence",
            "purchase-complete": "joy and confidence",
            "delete-remove": "calm, a respectful departure",
          },
        },
      ],
    },
    {
      id: "decision-framework",
      title: "Decision framework",
      entries: [
        {
          id: "decide-purpose",
          title: "Purpose first",
          text: "Name what the motion does before choosing how it moves.",
          fields: {
            "draw-attention": "scale, colour, pulse; prioritise responsiveness",
            "guide-sequence": "stagger, directional flow; prioritise clarity",
            "provide-feedback": "immediate response; prioritise speed",
            "create-atmosphere": "subtle, continuous; prioritise subtlety",
            "explain-relationship": "position, connection; prioritise legibility",
            "celebrate-reward": "overshoot, particles; prioritise delight",
          },
        },
        {
          id: "decide-audience-context",
          title: "Audience and context",
          text:
            "Stressed or task-focused viewers get calm, fast, minimal motion; browsing or exploring viewers can " +
            "take richer, more dramatic motion. Motion seen a hundred times a day stays fast and subtle; motion " +
            "seen once may be dramatic. A busy layout or small container calls for simpler, smaller motion; " +
            "coordinate or stagger with other animations already running.",
        },
        {
          id: "motion-categories",
          title: "Motion categories",
          text:
            "Revealing (content appears), concealing (content leaves), transitioning (between states or views), " +
            "emphasising (draws attention), responding (reacts to interaction) and ambient (background atmosphere).",
        },
        {
          id: "motion-direction-meaning",
          title: "What direction communicates",
          text: "Direction is part of the message.",
          fields: {
            upward: "growth, aspiration",
            downward: "settling, completion",
            leftward: "regression, departure",
            rightward: "progression, arrival",
            "scale-up": "importance, emergence",
            "scale-down": "dismissal, removal",
            "toward-centre": "focus, convergence",
            "away-from-centre": "distribution, release",
          },
        },
        {
          id: "decision-quick-path",
          title: "Quick decision path",
          text:
            "1. Purpose: feedback is short, eased out and minimal; an entrance eases out in the chosen " +
            "personality; an exit eases in at about 70% of the entrance; emphasis is a scale or colour pulse; " +
            "ambient is slow, continuous and sine-eased. 2. Personality from the brief's keywords. 3. Properties: " +
            "the minimum needed, two is the sweet spot. 4. Timing from the duration table, adjusted for distance " +
            "and weight. 5. Easing by direction.",
        },
        {
          id: "pre-delivery-evaluation",
          title: "Evaluation before delivery",
          text:
            "Ask of every motion: does it have a clear function, does the personality fit the context, is it " +
            "still fine on the hundredth viewing, does it respect the viewer's focus, does it reinforce hierarchy, " +
            "is there one clear primary action with only useful supporting layers, and is the duration right.",
        },
      ],
    },
    {
      id: "animation-principles",
      title: "The classic twelve animation principles, adapted",
      entries: [
        {
          id: "principle-squash-stretch",
          title: "Squash and stretch",
          text:
            "Squash to about 1.2 by 0.8 on impact and stretch to about 0.85 by 1.15 in travel, preserving volume. " +
            "Impact takes 2-4 frames (30-65ms) and recovery 4-8 frames (65-130ms). Skip it for premium styles.",
        },
        {
          id: "principle-anticipation",
          title: "Anticipation",
          text:
            "A small move opposite the main direction first: 100-200ms at 10-20% of the main action's magnitude " +
            "(a button scales down 3% before expanding; a card shifts 5-10px away). Skip it for micro-feedback " +
            "under 150ms.",
        },
        {
          id: "principle-staging",
          title: "Staging",
          text:
            "Dim non-hero elements to 40-60% opacity, optionally with a 2-4px blur; the hero enters 100-200ms " +
            "after supporting elements; one primary action per timing beat.",
        },
        {
          id: "principle-straight-ahead-pose-to-pose",
          title: "Straight ahead and pose to pose",
          text:
            "Straight-ahead motion is fluid and spontaneous, suited to particles, ambient and generative art. " +
            "Pose-to-pose is planned and controlled, suited to transitions and state changes.",
        },
        {
          id: "principle-follow-through",
          title: "Follow-through and overlapping action",
          text:
            "Child parts trail their parent by 50-150ms and trailing parts stop 100-200ms later; springs with " +
            "lower stiffness trail more.",
        },
        {
          id: "principle-slow-in-slow-out",
          title: "Slow in and slow out",
          text:
            "Entrances ease out, exits ease in, on-screen moves ease in and out, ambient loops use sine. Never " +
            "linear for spatial movement.",
        },
        {
          id: "principle-arcs",
          title: "Arcs",
          text:
            "Offset the path midpoint perpendicular to travel by 10-20px: about 5px for corporate, 20px or more " +
            "for playful. Mechanical styles may keep straight paths on purpose.",
        },
        {
          id: "principle-secondary-action",
          title: "Secondary action",
          text:
            "Supporting motion at 30-50% of the primary amplitude, 50-100ms after it, on a different curve (a " +
            "card enters and its shadow grows; a button is pressed and a ripple expands).",
        },
        {
          id: "principle-timing",
          title: "Timing",
          text:
            "Heavy things (modals, pages) take 400-800ms, light things (tooltips, toggles) 100-250ms, sad or " +
            "serious moods 600ms or more, happy moods 200-400ms, urgent ones 100-200ms.",
        },
        {
          id: "principle-exaggeration",
          title: "Exaggeration",
          text:
            "Scale overshoot of 10-30% and rotation of 5-15 degrees, scaled by personality: Playful 15-25%, " +
            "Energetic 20-30%, Corporate 0-5%, Premium none.",
        },
        {
          id: "principle-solid-drawing",
          title: "Solid drawing",
          text:
            "Keep proportions consistent across keyframes, combine scale and rotation for depth, and keep shadows " +
            "consistent with the implied light source.",
        },
        {
          id: "principle-appeal",
          title: "Appeal",
          text:
            "Smooth curves over sharp angles, satisfying timing and one personality across all elements. Appeal " +
            "dies with jerky motion, inconsistent timing, abrupt stops and uniform animation.",
        },
        {
          id: "combining-principles",
          title: "Combining principles",
          text:
            "A button press uses anticipation, squash and stretch, follow-through, secondary action and timing. A " +
            "card entrance uses anticipation, arcs, slow in and out, follow-through and staging. A celebration " +
            "uses exaggeration, secondary action, timing, squash and stretch and appeal. An error shake uses " +
            "timing, slow in and out and staging with no exaggeration. A spinner uses timing, easing and appeal.",
        },
      ],
    },
    {
      id: "narrative-structure",
      title: "Micro-story structure",
      entries: [
        {
          id: "act-anticipation",
          title: "Act 1: anticipation",
          text:
            "About 10-20% of the motion: a wind-up opposite the main direction, elements gathering before they " +
            "disperse, context dimming for focus, or a brief compressed hold of about 50ms. Skip it for " +
            "interactions under 150ms and hovers.",
        },
        {
          id: "act-action",
          title: "Act 2: action",
          text:
            "About 30-50%: the peak energy and the communicative move. Fast and direct for alerts, smooth and " +
            "flowing for transitions, explosive and radial for celebrations, controlled and near-linear for data.",
        },
        {
          id: "act-reaction",
          title: "Act 3: reaction",
          text:
            "About 10-20%: shadows adjust 50-100ms after the primary, siblings shift 50-150ms after, the " +
            "environment ripples 100-200ms after; counter-motion runs with the action. Skip it for simple toggles.",
        },
        {
          id: "act-resolution",
          title: "Act 4: resolution",
          text:
            "About 20-30%: an overshoot settles, opacity reaches its final value, and 100-200ms of breathing room " +
            "follows before the next motion. Even 50ms of settling changes the feel.",
        },
        {
          id: "act-scaling",
          title: "Scaling the acts to total duration",
          text: "Short motion drops acts; long motion uses all four.",
          fields: {
            "100-200ms": "no anticipation or reaction; action 60-70%, resolution 30-40%",
            "200-400ms": "anticipation 10-15%, action 40-50%, reaction 10-15%, resolution 25-30%",
            "400-800ms": "anticipation 15-20%, action 30-40%, reaction 15-20%, resolution 20-25%",
            "800ms-plus": "anticipation 20%, action 30-35%, reaction 15-20%, resolution 25-30%",
          },
        },
        {
          id: "multi-beat-progressions",
          title: "Multi-beat progressions",
          text:
            "Beats can overlap (fluid), run sequentially (clear) or run together (parallel). Common shapes: " +
            "build-up (low, rising, peak, settling), cycle (depart, peak, return, repeat) and impact (sudden " +
            "action, ripple, slow settle).",
        },
        {
          id: "narrative-by-personality",
          title: "Acts by personality",
          text:
            "Playful: exaggerated wind-up, bouncy action, wobble settle. Premium: subtle tension, controlled " +
            "action, elegant ease. Corporate: little or no wind-up, direct action, clean stop. Energetic: quick " +
            "gather, explosive action, fast snap.",
        },
        {
          id: "micro-story-patterns",
          title: "Micro-story patterns",
          text:
            "Reveal: tension (dim, scale 95%), emerge to full size and opacity, surroundings adjust, settle. " +
            "Departure: gather (scale 98%), exit, close the gap, layout settles. Transformation: destabilise with " +
            "a small vibration, morph, secondary appears, new state breathes. Celebration: compress 50-100ms, " +
            "burst, settle, rest in the positive state.",
        },
      ],
    },
    {
      id: "context-adaptation",
      title: "Context adaptation",
      entries: [
        {
          id: "platform-scaling",
          title: "Platform scaling",
          text:
            "Smaller screens get shorter, simpler motion. On mobile prefer opacity and transform, keep touch " +
            "feedback under 100ms, cut stagger budgets by 30% and avoid parallax. Desktop allows hover states, " +
            "cursor tracking, multi-column stagger and spatial choreography.",
          fields: {
            desktop: "1.0x duration, full complexity, all physics",
            tablet: "0.9x, standard complexity, most physics",
            mobile: "0.8x, 1-2 properties, snappy physics only",
            watch: "0.6x, one property, no physics",
            "tv-kiosk": "1.3x, full complexity, all physics",
          },
        },
        {
          id: "reduced-motion",
          title: "Reduced-motion alternatives",
          text:
            "Reduced motion removes spatial movement and spring easing, keeps opacity, shortens durations by half " +
            "or more and never auto-plays loops: a slide becomes a fade, a bounce becomes instant or a plain " +
            "ease-out, parallax becomes static, complex choreography becomes one fade, and continuous ambient " +
            "becomes static or a faint opacity pulse.",
        },
        {
          id: "vestibular-triggers",
          title: "Vestibular triggers",
          text:
            "Avoid, or provide alternatives for, large-scale zooms, full-screen position transitions, spinning " +
            "elements larger than 100px, parallax deeper than two layers and rapid direction changes.",
        },
        {
          id: "cognitive-accessibility",
          title: "Cognitive accessibility",
          text:
            "The same interaction always produces the same animation, animations longer than 5 seconds can be " +
            "paused, and critical information is never conveyed by motion alone.",
        },
        {
          id: "performance-tiers",
          title: "Performance tiers",
          text:
            "Prefer transform and opacity for all motion; they composite cheaply. Colour and clip changes repaint; " +
            "size and spacing changes trigger layout; shadows, corner radii and filters are the most expensive.",
          fields: {
            optimal: "transform, opacity: effectively unlimited elements",
            good: "plus colour and clip-path: 10-15 elements",
            acceptable: "plus width, height, margin: 5-8 elements",
            avoid: "box-shadow, border-radius, filter: 1-3 elements",
          },
        },
        {
          id: "frame-budget",
          title: "Frame budget",
          text:
            "Target 60fps (16.67ms per frame) with animation logic under 10ms per frame; 30fps is acceptable for " +
            "ambient motion. Keep animated elements under 20 per viewport, use layer hints sparingly and stagger " +
            "to spread peak load.",
        },
        {
          id: "content-type-defaults",
          title: "Defaults by content type",
          text: "Personality, duration and motion density by content domain.",
          fields: {
            financial: "Corporate or Premium, 250-500ms, low density",
            social: "Playful, 150-300ms, medium density",
            "enterprise-software": "Corporate, 200-400ms, low density",
            gaming: "Energetic, 100-250ms, high density",
            healthcare: "Corporate or calm, 300-600ms, very low density",
            "e-commerce": "varies, 200-400ms, medium density",
            editorial: "Premium, 350-600ms, low density",
            "childrens-apps": "Playful, 150-300ms, high density",
          },
        },
        {
          id: "responsive-displacement",
          title: "Responsive displacement",
          text:
            "Cap travel relative to container width. Small viewports move one element at a time; medium ones use " +
            "standard stagger across two or three columns; large ones can use full choreography, center-out " +
            "stagger and parallax.",
          fields: {
            "under-400px": "max 20% of width, 0.8x duration",
            "400-800px": "max 25% of width, 1.0x duration",
            "800-1200px": "max 20% of width, 1.0x duration",
            "over-1200px": "max 15% of width, 1.1x duration",
          },
        },
        {
          id: "dark-mode",
          title: "Dark backgrounds",
          text:
            "Bright elements on dark carry more impact, so reduce motion intensity by 10-20%, keep ambient subtler, " +
            "handle opacity carefully and avoid pure white flashes.",
        },
      ],
    },
    {
      id: "entrance-exit-patterns",
      title: "Entrance and exit patterns",
      entries: [
        {
          id: "entrance-slide",
          title: "Direct entrance (slide in)",
          text:
            "Position plus opacity: start 20-40px off with opacity 0, ease out over 200-350ms. Direction carries " +
            "meaning: from below is arrival, from the right is forward, from the left is back, from above is a " +
            "dropdown or authority.",
          fields: {
            playful: "30-50px, back-style ease-out, 10-15% overshoot",
            premium: "15-25px, cubic-bezier(0.4, 0, 0.2, 1), no overshoot",
            corporate: "20-30px, cubic-bezier(0.2, 0, 0, 1), 0-3% overshoot",
            energetic: "40-80px, exponential ease-out, 15-25% overshoot",
          },
        },
        {
          id: "entrance-scale",
          title: "Emergent entrance (scale in)",
          text:
            "Scale plus opacity from 85-95% and opacity 0 to full over 250-400ms. Best for modals, dialogs, " +
            "notifications, popovers and tooltips.",
          fields: {
            playful: "start 70-80%, back-style ease-out, 10-20% overshoot",
            premium: "start 95-98%, cubic-bezier(0.4, 0, 0.2, 1), no overshoot",
            corporate: "start 90-95%, cubic-bezier(0.2, 0, 0, 1), 0-3% overshoot",
            energetic: "start 50-70%, exponential ease-out, 15-30% overshoot",
          },
        },
        {
          id: "entrance-reveal",
          title: "Reveal entrance (clip or mask)",
          text:
            "A clip or mask opens with opacity over 300-500ms, eased out. Top to bottom is dramatic, left to " +
            "right follows reading order, center-out focuses, edge-in feels contained.",
        },
        {
          id: "entrance-assembled",
          title: "Assembled entrance",
          text:
            "Parts arrive from different positions, staggered 50-100ms, 300-600ms in total. Best for icon " +
            "assembly, logo builds and data visualisation construction.",
        },
        {
          id: "exit-strategies",
          title: "Exit strategies",
          text:
            "Exits run 65-75% of the entrance and ease in. Slide out: 20-40px offset plus fade, 150-250ms. " +
            "Dissolve: fade with an optional scale to 98%, 150-250ms, for gentle departures and crossfades. " +
            "Collapse: scale to 85-95% plus fade, 150-250ms, for deletion and dismissal. Transfer: move toward a " +
            "destination while shrinking, ease-in-out over 250-400ms, for add-to-cart or move-to-folder.",
        },
        {
          id: "entrance-exit-continuity",
          title: "Entrance and exit continuity",
          text:
            "Let the eye flow from an exit into the next entrance: exit near the next entry point, overlap the " +
            "two by 100-150ms and keep paired entrances and exits in one easing family.",
        },
        {
          id: "recipe-notification-toast",
          title: "Notification in and toast out",
          text:
            "Notification: slide in from the right with a fade (250ms, ease-out), overshoot 3-5% for corporate or " +
            "10-15% for playful, then the icon appears (100ms, 50ms delay). Toast dismiss: slide toward the edge " +
            "with a fade (180ms, ease-in) while remaining toasts shift up (200ms, ease-in-out).",
        },
        {
          id: "recipe-dropdown",
          title: "Dropdown open",
          text: "The container scales vertically from 0 to full (200ms, ease-out); items fade in 30ms apart, starting 50ms after the container.",
        },
        {
          id: "recipe-page-transition",
          title: "Forward page transition",
          text:
            "The current page slides left and fades (300ms, ease-in); the new page enters from the right and " +
            "fades in (400ms, ease-out, 100ms delay); shared elements morph between them (400ms, ease-in-out), " +
            "the hero scales in and content staggers 50ms apart.",
        },
      ],
    },
    {
      id: "ambient-patterns",
      title: "Ambient and continuous patterns",
      entries: [
        {
          id: "ambient-breathing",
          title: "Breathing and pulse",
          text:
            "A sine-eased scale or opacity oscillation of 2-4 seconds per cycle. Pulses larger than plus or minus " +
            "5% scale start demanding attention.",
          fields: {
            "active-indicator": "scale 0.95-1.05, 2000ms, opacity 0.6-1.0",
            "waiting-idle": "scale 0.98-1.02, 3000ms, opacity 0.8-1.0",
            background: "scale 0.99-1.01, 4000ms, opacity 0.9-1.0",
            "cta-attention": "scale 0.97-1.03, 2500ms, opacity 0.7-1.0",
          },
        },
        {
          id: "ambient-floating",
          title: "Floating",
          text:
            "Vertical drift of 5-15px, sine-eased, 3-5 seconds per cycle, with optional 2-3 degrees of rotation " +
            "offset by 30% of the cycle. When several elements float, give each a different period and phase so " +
            "they never sync.",
        },
        {
          id: "ambient-gradient-shift",
          title: "Gradient shift",
          text:
            "Shift a gradient's position by 10-20% or its angle by about 15 degrees over 8-20 seconds, linear or " +
            "sine; it should be imperceptible at a glance.",
        },
        {
          id: "ambient-parallax",
          title: "Parallax layers",
          text:
            "Foreground (text, interactive) at 1.0x, midground (decorative, cards) 0.5x, background (patterns, " +
            "scenery) 0.2x, deep background (texture, atmosphere) 0.1x. Scroll-driven parallax stays under 100px " +
            "total and never moves text; pointer-driven parallax moves the foreground at most 10-20px and the " +
            "background 5-10px the opposite way, smoothed over 100-200ms.",
        },
        {
          id: "ambient-rotation",
          title: "Continuous rotation",
          text:
            "Spinners rotate linearly at 1-2 seconds per revolution. Decorative slow spins take 10-30 seconds, " +
            "gear-like motion 3-5 seconds, orbits 5-15 seconds; a playful idle wobble is a 2-4 second sine cycle.",
        },
        {
          id: "ambient-shimmer",
          title: "Shimmer and gleam",
          text:
            "A gradient sweeps left to right over 1.5-2.5 seconds, peaking around 30% opacity, with 2-5 seconds " +
            "between sweeps. Use it for skeleton loading, premium accents and new badges.",
        },
        {
          id: "ambient-particles",
          title: "Ambient particles",
          text:
            "Falling (snow): 10-20 elements of 3-8px drifting down at 20-60px/s at 30-70% opacity. Dust motes: " +
            "5-10 elements of 2-5px wandering at 10-30px/s. Sparkles: 8-15 elements pulsing in and out over " +
            "0.5-1.5 seconds with random stagger. Keep fewer than 20 ambient elements, transform and opacity only, " +
            "and prefer fewer larger particles.",
        },
        {
          id: "ambient-layering",
          title: "Combining ambient layers",
          text:
            "Background takes a gradient shift or parallax, midground floating or particles, foreground a breath " +
            "or shimmer. All ambient motion together stays within 20% of the primary motion's visual energy.",
        },
      ],
    },
    {
      id: "multi-element-patterns",
      title: "Multi-element patterns",
      entries: [
        {
          id: "recipe-list-stagger",
          title: "List items",
          text: "Rise 20px and fade in (200ms, ease-out), staggered 40-60ms; keep eight items under 400ms in total.",
          fields: {
            playful: "250ms each, 60ms stagger, back-style ease-out",
            premium: "350ms each, 80ms stagger, cubic-bezier(0.4, 0, 0.2, 1)",
            corporate: "200ms each, 50ms stagger, cubic-bezier(0.2, 0, 0, 1)",
            energetic: "150ms each, 30ms stagger, exponential ease-out",
          },
        },
        {
          id: "recipe-grid-cards",
          title: "Grid cards",
          text:
            "Scale from 95% and fade (250ms, ease-out), staggered 50-80ms in reading order with an extra 20ms per " +
            "row; each shadow follows its card by 50ms. Center-out, column-first or random orders also work.",
        },
        {
          id: "recipe-nav-items",
          title: "Navigation items",
          text: "Slide in from the side and fade (180ms, ease-out), staggered 30-50ms, under 300ms in total.",
        },
        {
          id: "recipe-dashboard-load",
          title: "Dashboard load",
          text:
            "Skeletons show first; the hero metric arrives at about 100ms (250ms, ease-out); supporting widgets " +
            "start at about 200ms (200ms each, 50-60ms apart); the chart draws in with the cards (300ms); all " +
            "land by about 500ms and an ambient pulse on the primary metric starts after.",
        },
        {
          id: "recipe-modal-open",
          title: "Modal open",
          text:
            "The backdrop dims (200ms); the modal scales from 95% and fades in (300ms, 50ms delay); content " +
            "follows in reading order (title, body, buttons) about 100ms after the modal; the close button comes " +
            "last.",
        },
        {
          id: "recipe-list-item-added",
          title: "List item added",
          text:
            "Existing items shift down (200ms, ease-in-out); the new item fades and slides in from the top (250ms, " +
            "ease-out, 50ms delay) and lands with a 3-5% overshoot.",
        },
        {
          id: "recipe-tab-switch",
          title: "Tab switch",
          text:
            "The indicator slides (250ms, ease-in-out) while old content fades (150ms); new content enters from " +
            "the tab's direction at 100ms (200ms) and its elements stagger 40ms apart.",
        },
        {
          id: "recipe-accordion",
          title: "Accordion",
          text:
            "Expand: the arrow rotates (150ms), height expands (250ms), content fades in from 50ms (200ms) and " +
            "siblings shift (200ms). Collapse runs the reverse with ease-in.",
        },
        {
          id: "recipe-drag-drop",
          title: "Drag and drop",
          text:
            "On drag the item lifts to 1.03 scale (150ms) and others shift (200ms); on drop it settles to 1.0 " +
            "(200ms) and the gaps close.",
        },
      ],
    },
    {
      id: "state-feedback-patterns",
      title: "State and feedback patterns",
      entries: [
        {
          id: "recipe-button-press",
          title: "Button press",
          text: "Press compresses, release recovers; personality sets overshoot and secondary cues.",
          fields: {
            playful:
              "press to 0.95 (60ms), release overshoots to 1.05 (80ms), springs to 1.0 (120ms); shadow and colour react; about 260ms",
            premium:
              "press to 0.98 (80ms) with opacity at 90%, release to 1.0 (150ms) with no overshoot; about 230ms",
            corporate:
              "press to 0.97 (60ms) with background 10% darker, release to 1.0 (100ms), 0-2% overshoot; about 160ms",
          },
        },
        {
          id: "recipe-hover",
          title: "Hover states",
          text:
            "Hover-in under 100ms, hover-out slower at 150-200ms. Buttons scale 1.02-1.05; cards 1.01-1.02 with a " +
            "shadow lift; links change colour and underline; icons scale 1.1 with 2-5 degrees of rotation; images " +
            "scale 1.03 inside a clipped frame over 150ms.",
        },
        {
          id: "recipe-toggle",
          title: "Toggle switch",
          text:
            "The thumb slides in 120-180ms (ease-in-out) while the track colour changes, with a slight squash in " +
            "the direction of travel; Playful bounces at the destination, Premium lands with no overshoot.",
        },
        {
          id: "recipe-success",
          title: "Success states",
          text:
            "Checkmark: the container scales 0.9 to 1.0 (200ms, back-style ease-out, 5-10% overshoot), the check " +
            "stroke draws (150ms, 100ms delay), colour moves to green (200ms) and an optional glow or particles " +
            "follow; 400-500ms in total. Badge: scales from 0 (200ms), text fades in (150ms, 50ms delay), the " +
            "background pulses once (300ms). Payment: the spinner crossfades to a check (200ms), the check draws " +
            "and the container turns success-coloured (200ms each), text follows, optional confetti 300-500ms.",
        },
        {
          id: "recipe-error",
          title: "Error states",
          text:
            "Shake: horizontal oscillation of 10-15px for 2-3 cycles of decreasing amplitude, ease-in-out, " +
            "300-400ms, red tint, no overshoot, settling at the origin. Inline validation: error text slides down " +
            "and fades in (200ms), the border turns red (150ms), an icon scales in (150ms, 50ms delay), optionally " +
            "one short shake. Form error: the button returns to normal, the message slides in (250ms), affected " +
            "fields highlight 30ms apart and the view scrolls smoothly to the first error (300ms).",
        },
        {
          id: "recipe-loading",
          title: "Loading states",
          text:
            "Spinner: continuous linear rotation at 1-1.5 seconds per turn, optionally breathing over 2-3 seconds. " +
            "Skeleton: a left-to-right sweep over 1.5-2 seconds from a 10-20% base to a 30-40% peak. Progress " +
            "bar: eased in-out growth with optional colour milestones. Indeterminate: oscillation over 1.5-2.5 " +
            "seconds, continuous but never frantic.",
        },
        {
          id: "recipe-warning",
          title: "Warning state",
          text:
            "An amber border (150ms), a warning icon scaling in with a subtle overshoot (150ms), an optional slow " +
            "icon pulse (2-3 seconds, sine) and text fading in (200ms, 50ms delay).",
        },
        {
          id: "recipe-disabled-focus",
          title: "Disabled, enabled and focus",
          text:
            "Disabling fades to 50-60% opacity over 200ms, optionally scaling to 98%; enabling returns to full " +
            "opacity with an optional 98-100% pulse. A focus ring scales from 95% with a fade (150ms); card focus " +
            "scales to 1.01 with more shadow; keyboard focus responds in under 100ms and must survive reduced " +
            "motion.",
        },
      ],
    },
    {
      id: "property-selection",
      title: "Property selection",
      entries: [
        {
          id: "property-meanings",
          title: "What each property says",
          text:
            "Position carries direction and progress. Scale up reads as importance or proximity, scale down as " +
            "deprioritisation; a pulse is attention or life, breathing is presence or waiting. Small rotation " +
            "(5-15 degrees) is an adjustment, 45-90 degrees a transformation, a full turn completion, continuous " +
            "rotation ongoing activity. Fading in is arrival, fading out departure, partial opacity a secondary " +
            "or disabled state. Colour to green is success, to red error, to blue trust, to grey inactive; " +
            "brightening is activation, dimming backgrounding.",
        },
        {
          id: "property-pairs",
          title: "Property pairs",
          text:
            "Position with opacity for content appearing or leaving; scale with opacity for cards, modals and " +
            "notifications; position with scale for selected or focused items; rotation with scale for " +
            "celebrations; position with rotation for organic transitions; colour with scale for state emphasis. " +
            "The primary property carries meaning, the secondary adds polish.",
        },
        {
          id: "property-by-goal",
          title: "Property by goal",
          text: "Primary, secondary and what to avoid for common goals.",
          fields: {
            entrance: "position; opacity; avoid rotation",
            exit: "position; opacity; avoid scaling up",
            "button-press": "scale; colour; avoid position",
            hover: "scale or colour; opacity; avoid position",
            success: "scale; colour and opacity; avoid position",
            error: "position (shake); colour; avoid scale",
            loading: "rotation; opacity; avoid position",
            toggle: "position; colour; avoid rotation",
            notification: "position and scale; opacity; avoid rotation",
            delete: "scale and opacity; position; avoid growing",
            selection: "scale; colour, opacity; avoid rotation",
            progress: "position or scale; colour; avoid opacity",
            "depth-feel": "scale with shadow; parallax position",
          },
        },
        {
          id: "simplicity-threshold",
          title: "Simplicity threshold",
          text:
            "Animate the minimum number of properties: one is direct, two is polished and the sweet spot, three " +
            "or more risks overwhelming the viewer.",
        },
        {
          id: "opacity-never-alone",
          title: "Opacity is never enough alone",
          text: "An important state change carried only by opacity is easy to miss; pair it with position or scale.",
        },
      ],
    },
    {
      id: "quality-checklist",
      title: "Quality checklist",
      entries: [
        {
          id: "quality-visual",
          title: "Visual quality",
          text:
            "Moving elements are larger than 40px and detailed ones larger than 100px; the motion reads at full " +
            "speed; there is a clear primary action with supporting layers only where useful; counter-motion " +
            "balances where needed; paths arc unless deliberately mechanical; the one-third rules for distance and " +
            "density hold.",
        },
        {
          id: "quality-technical",
          title: "Technical quality",
          text:
            "No linear easing on spatial moves; duration matches element type and scales with distance; entrances " +
            "ease out and exits ease in; entrances last at least as long as exits; important state changes are not " +
            "opacity-only; total stagger stays under 500ms; child elements follow through 50-150ms behind.",
        },
        {
          id: "quality-emotional",
          title: "Emotional quality",
          text:
            "The target emotion was named before properties were chosen; the archetype fits the brand; there is a " +
            "setup, action and resolution; intensity matches importance; the same interaction always gets the same " +
            "motion; it still works on the hundredth viewing.",
        },
        {
          id: "quality-performance",
          title: "Performance quality",
          text:
            "Primary motion uses transform and opacity; fewer than 20 animated elements per viewport; no " +
            "layout-triggering properties animated; elements staggered rather than simultaneous; 60fps held, 30fps " +
            "accepted for ambient.",
        },
        {
          id: "quality-accessibility",
          title: "Accessibility quality",
          text:
            "A reduced-motion alternative exists; vestibular triggers have alternatives; interactions animate " +
            "consistently; critical information is not motion-only; animations longer than 5 seconds can be paused.",
        },
        {
          id: "severity-critical",
          title: "Critical failures",
          text:
            "Linear easing on spatial movement; opacity-only important states; breaking the one-third screen rule; " +
            "a missing primary layer; stagger over 500ms; layout-property animation causing jank.",
          tags: ["severity"],
        },
        {
          id: "severity-high",
          title: "High-severity failures",
          text:
            "A secondary layer missing when the brief requires one; duration mismatched to element type; wrong " +
            "directional easing; inconsistent personality; no follow-through; no reduced-motion alternative.",
          tags: ["severity"],
        },
        {
          id: "severity-medium",
          title: "Medium-severity failures",
          text:
            "An ambient layer missing when the brief requires one; no anticipation; overshoot that does not fit " +
            "the personality; paths that could arc better; missing counter-motion.",
          tags: ["severity"],
        },
      ],
    },
    {
      id: "troubleshooting",
      title: "Troubleshooting",
      entries: [
        {
          id: "fix-robotic",
          title: "Looks robotic",
          text:
            "Replace linear easing with ease-out or ease-in-out; add a 10-20px arc at the path midpoint; stagger " +
            "50-100ms instead of uniform timing; offset starts and stops by 50-150ms; add a secondary reaction.",
        },
        {
          id: "fix-too-slow",
          title: "Feels too slow",
          text:
            "Bring durations back to the element-type budget; prefer ease-out over ease-in-out, which feels " +
            "faster; cut anticipation to about 10% or remove it; keep total stagger under 500ms; raise damping on " +
            "long overshoot settles.",
        },
        {
          id: "fix-too-fast",
          title: "Feels too fast or jarring",
          text:
            "Respect minimums (modals 300ms or more, pages 400ms or more); add at least an ease-out; add a " +
            "50-100ms settle; give large moves a 100-200ms wind-up.",
        },
        {
          id: "fix-cheap-flat",
          title: "Feels cheap or flat",
          text:
            "Add secondary and ambient layers; pair opacity with position or scale; vary the curve between primary " +
            "and secondary; trail child elements by 50-150ms; add 3-10% overshoot.",
        },
        {
          id: "fix-distracting",
          title: "Too distracting",
          text:
            "Apply the one-third rule; reduce amplitude to the minimum; keep one hero per moment and dim the rest; " +
            "slow ambient down to 10-20% amplitude; leave 100-200ms of breathing room between beats.",
        },
        {
          id: "fix-no-personality",
          title: "No personality",
          text:
            "Replace default easing with the archetype's signature curve, use the duration palette instead of one " +
            "duration, define one entrance for the project and keep 90% or more of motion in one archetype.",
        },
        {
          id: "fix-inconsistent",
          title: "Inconsistent feel",
          text:
            "Standardise easing and duration per motion type, use one entry origin everywhere and apply overshoot " +
            "rules consistently.",
        },
        {
          id: "fix-dropped-frames",
          title: "Dropped frames",
          text:
            "Animate transforms instead of width, height or margin; keep under 20 moving elements per viewport; " +
            "simplify or pre-render heavy shadows and filters; stagger to spread the load.",
        },
        {
          id: "quick-diagnostic",
          title: "Ten-point quick diagnostic",
          text:
            "No linear spatial moves; duration fits element type; primary and secondary layers present; one " +
            "personality; directional easing correct; one-third screen rule; one-third element rule; " +
            "follow-through present; every motion has a purpose; fine on the hundredth viewing.",
        },
        {
          id: "personality-mistakes",
          title: "Personality mistakes",
          text:
            "Playful breaks past 25% overshoot, when everything bounces, or when short durations meet bouncy " +
            "curves and glitch. Premium fails when it is so subtle it is invisible, so slow it feels like " +
            "waiting, or reduced to no motion. Corporate fails when it is boring, uses playful curves that erode " +
            "trust, or makes everything identical. Energetic fails at maximum everywhere, with too many particles " +
            "or with no settle.",
        },
      ],
    },
  ],
  checks: [
    {
      id: "motion-design.stagger-total",
      kind: "hard",
      level: "shot",
      measure:
        "Spread from the first to the last start time within one staggered group of routine interface-style " +
        "motion (narrative sequences with their own declared budget are excluded).",
      metric: { id: "stagger-total-ms", unit: "ms" },
      threshold: { op: "<=", value: 500 },
    },
    {
      id: "motion-design.unbroken-travel",
      kind: "hard",
      level: "shot",
      measure:
        "Longest single uninterrupted travel segment (no intermediate keyframe, direction or speed change) as a " +
        "fraction of the frame or container dimension along that axis.",
      metric: { id: "unbroken-travel-ratio", unit: "ratio" },
      threshold: { op: "<=", value: 1 / 3 },
    },
    {
      id: "motion-design.simultaneous-motion",
      kind: "hard",
      level: "shot",
      measure:
        "Peak fraction of animated elements in active (non-ambient) motion at the same instant, measured when " +
        "at least three elements animate.",
      metric: { id: "simultaneous-motion-ratio", unit: "ratio" },
      threshold: { op: "<=", value: 1 / 3 },
      params: { minAnimatedElements: 3 },
    },
    {
      id: "motion-design.animated-element-count",
      kind: "hard",
      level: "shot",
      measure: "Peak number of animated elements visible in one frame or viewport.",
      metric: { id: "animated-elements-per-frame", unit: "count" },
      threshold: { op: "<", value: 20 },
    },
    {
      id: "motion-design.exit-entrance-ratio",
      kind: "hard",
      level: "shot",
      measure: "Duration of an element's exit divided by the duration of its paired entrance.",
      metric: { id: "exit-entrance-duration-ratio", unit: "ratio" },
      threshold: { op: "between", min: 0.65, max: 0.75 },
    },
    {
      id: "motion-design.follow-through-offset",
      kind: "hard",
      level: "shot",
      measure: "Start offset of each child or trailing part behind its parent's motion.",
      metric: { id: "follow-through-offset-ms", unit: "ms" },
      threshold: { op: "between", min: 50, max: 150 },
    },
    {
      id: "motion-design.eased-spatial-motion",
      kind: "evidence",
      level: "shot",
      measure:
        "The reviewer inspects every spatial move (position, scale, travel along a path) for its easing.",
      judges: ["ai", "human"],
      evidence: ["clip", "frame-strip"],
      pass: "No spatial move runs on linear easing; linear appears only on rotation, progress bars and timers.",
    },
    {
      id: "motion-design.directional-easing",
      kind: "evidence",
      level: "shot",
      measure: "The reviewer classifies each move as entrance, exit, on-screen or loop and checks its curve.",
      judges: ["ai", "human"],
      evidence: ["clip", "document"],
      pass: "Entrances decelerate, exits accelerate, on-screen moves ease both ends and loops are sine-eased.",
    },
    {
      id: "motion-design.state-change-legible",
      kind: "evidence",
      level: "shot",
      measure: "The reviewer finds every important state change and what carries it.",
      judges: ["ai", "human"],
      evidence: ["clip"],
      pass: "No important state change is carried by opacity alone; each pairs opacity with position or scale.",
    },
    {
      id: "motion-design.single-hero",
      kind: "evidence",
      level: "scene",
      measure: "The reviewer names the hero motion of each moment and whatever competes with it.",
      judges: ["ai", "human"],
      evidence: ["contact-sheet", "clip"],
      pass: "Each moment has exactly one hero motion and ambient motion never pulls focus from it.",
    },
    {
      id: "motion-design.personality-consistent",
      kind: "evidence",
      level: "video",
      measure:
        "The reviewer compares easing, duration palette, overshoot and entrance pattern across the piece.",
      judges: ["ai", "human"],
      evidence: ["clip", "document"],
      pass: "One archetype governs about 90% of motion and every borrowed moment is deliberate and named in the motion brief.",
    },
    {
      id: "motion-design.reduced-motion-variant",
      kind: "evidence",
      level: "video",
      measure:
        "For deliverables that play inside an interface, the reviewer reads the motion spec's reduced-motion plan.",
      judges: ["ai", "human"],
      evidence: ["document"],
      pass:
        "A reduced-motion variant replaces spatial movement, springs and auto-playing loops with fades or static " +
        "states, or the spec records why the deliverable never plays in an interface.",
    },
    {
      id: "motion-design.feel-sign-off",
      kind: "evidence",
      level: "video",
      measure: "The user watches the motion and says what it makes them feel.",
      judges: ["human"],
      evidence: ["clip"],
      pass: "What the user names matches the emotional target recorded in the motion brief.",
    },
  ],
};
