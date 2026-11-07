---
name: ak-motion-design
description: "Apply motion principles: emotion-to-motion mapping, Disney's 12 principles for UI, Material 3 and Apple HIG easing, stagger and choreography, for CSS, Framer Motion, GSAP, Lottie, Spring or Remotion."
when_to_use: "Use for transitions, micro-interactions, loading states or hero/CTA motion; pairs with frontend-design, banner-design and video."
category: design
keywords: [motion, animation, easing, interaction, principles]
argument-hint: "[element, interaction, or animation brief]"
license: Proprietary; includes MIT-licensed third-party material, see LICENSE.txt
metadata:
  author: agentkit
  version: "1.1.1"
  attribution: "Vendored from LottieFiles/motion-design-skill (MIT)"
  upstream: "github.com/lottiefiles/motion-design-skill"
  upstream_sha: "f9a8a041b85185ee4881b3471d3415e939aac772"
  imported_at: "2026-08-07"
---

# Motion Design Skill

> Adapted from [LottieFiles/motion-design-skill](https://github.com/lottiefiles/motion-design-skill) (MIT). See `LICENSE.txt`.

## When to Apply

Use this skill when:
- Creating UI animations (buttons, cards, modals, page transitions)
- Designing micro-interactions and feedback animations
- Building loading, success, or error states
- Animating illustrations or decorative elements
- Planning scroll-triggered or progress-based animations
- Establishing brand motion identity
- Choreographing multi-element sequences

**Decision tree:**
1. Does it serve a functional purpose (feedback, guidance)? → Timing rules for responsiveness
2. Does it express brand personality? → Motion Personality archetypes
3. Does it tell a story or guide attention? → Disney principles + choreography
4. Is this a complex multi-element scene? → 1/3 Rule + stagger patterns

## Quick Reference: 8-Step Checklist

For new choreography, use the checklist below. For a targeted transition fix, reuse the established personality/timing and inspect only the affected interaction. Verify reduced-motion behavior, visible content, and performance in either path.

1. **Emotional target?** — joy, calm, urgency, elegance
2. **Motion Personality?** — Playful, Premium, Corporate, Energetic
3. **Primary property?** — position, scale, rotation, opacity
4. **Duration?** — see duration table below
5. **Easing family?** — entrance=decelerate, exit=accelerate
6. **Hero element?** — apply staging principles
7. **Secondary + ambient layers?** — add richness
8. **1/3 rules?** — motion distance, simultaneous elements

## Three Pillars for New Choreography

Use these lenses when establishing a motion direction; simple feedback fixes need not invent a narrative or brand personality:

| Pillar | Question | Drives |
|--------|----------|--------|
| **Emotional Intent** | What should the viewer FEEL? | Easing, timing, amplitude |
| **Visual Narrative** | What's the micro-story? | Setup → Action → Resolution |
| **Motion Craft** | How do we make it believable? | Physics, secondary motion, paths |

**Optional motion layers** (add only when they support the brief and attention budget):
- **Primary**: Main action the viewer follows
- **Secondary**: Supporting richness (shadows, icons shifting)
- **Ambient**: Background life (gradients, subtle pulses)

> Deep dive: [director/core-philosophy.md](director/core-philosophy.md)

## Motion Personality

Reuse the project's motion identity. When defining a new one, select an archetype that fits the brand and apply it consistently.

| Archetype | Duration | Easing | Overshoot | Keywords |
|-----------|----------|--------|-----------|----------|
| **Playful** | 150-300ms | ease-out-back | 10-20% | fun, whimsical, bouncy, cute |
| **Premium** | 350-600ms | cubic-bezier(0.4,0,0.2,1) | 0% | elegant, minimal, luxury, sophisticated |
| **Corporate** | 200-400ms | cubic-bezier(0.2,0,0,1) | 0-3% | clean, professional, business, dashboard |
| **Energetic** | 100-250ms | ease-out-expo | 15-30% | dynamic, energetic, bold, exciting |

**Default**: Corporate for UI, Playful for illustrations.

**Brand Motion Identity** — define three constants:
1. **Signature easing**: One curve for 80% of animations
2. **Duration palette**: 3 durations (quick / standard / slow)
3. **Entrance pattern**: One consistent entry style

> Deep dive: [director/motion-personality.md](director/motion-personality.md)

## Property Selection

| Effect Goal | Primary Property | Secondary Properties |
|-------------|------------------|---------------------|
| Entrance/Exit | position | opacity, scale |
| Emphasis/Attention | scale | rotation (subtle), opacity pulse |
| State Change | opacity, color | scale (press feedback) |
| Direction/Flow | position | rotation (follow path) |
| Depth/3D Feel | scale + shadow | position (parallax) |
| Loading/Progress | rotation (spinner) | scale, opacity pulse |
| Success | scale (pop) | color, rotation (checkmark draw) |
| Error/Alert | position (shake) | color, rotation (wobble) |

**Simplicity threshold**: Use the minimum properties needed. One = direct. Two = polished. Three+ = potentially overwhelming.

> Deep dive: [reference/property-selection.md](reference/property-selection.md)

## Duration Table

Starting ranges, not universal limits: tune to distance, device, repetition, and existing motion tokens.

| Element Type | Duration | Rationale |
|-------------|----------|-----------|
| Tooltip / micro-feedback | 80-120ms | Must feel instant |
| Button press / toggle | 120-180ms | Responsive feedback |
| Icon transition | 150-250ms | Clear state change |
| Card enter / exit | 200-350ms | Spatial awareness |
| Modal / dialog | 300-400ms | Focus shift |
| Page transition | 400-600ms | Context switch |
| Dramatic reveal | 600-1200ms | Theatrical build |

**Distance scales duration**: 100px = base. 200px = 1.3x. 400px = 1.6x.

**Enter > Exit**: Entrances 30-50% longer than exits. Users care about what appears.

**Interactive feedback**:
- Hover: <100ms
- Press: <150ms
- Release/settle: 200-300ms
- Error shake: 300-400ms (2-3 oscillations)

> Deep dive: [reference/timing-easing-tables.md](reference/timing-easing-tables.md)

## Easing Selection

Directional easing rules, the industry-standard cubic-bezier table (Material 3, Apple HIG, bounce settle), and material-based duration/overshoot scaling.
Load `references/easing-selection.md` when picking an easing curve or tuning overshoot.

## Common Patterns

Step-by-step recipes for button press (Playful), card entrance (Premium), success state (Playful), and error shake (Corporate).
Load `references/common-pattern-recipes.md` when building one of these standard interactions.

## Choreography Essentials

**Coordinated entry**:
- Lead with the hero — primary element enters first or most prominently
- Spatial consistency — all elements enter from same direction
- Counter-motion — hero moves right → ambient moves left at 20-30% speed

**1/3 Rule (distance)**: No motion travels more than 1/3 of screen without a keyframe change.

**1/3 Rule (elements)**: With 3+ elements, no more than 1/3 in active motion simultaneously.

**Stagger budgets**:

| Pattern | Delay | Total Budget | Use Case |
|---------|-------|-------------|----------|
| Micro cascade | 20-40ms | <200ms | List items, grid cells |
| Standard | 50-100ms | <400ms | Cards, panels, nav |
| Dramatic | 100-200ms | <600ms | Hero sections |
| Wave | 30-60ms | <500ms | Data visualizations |

For routine UI, aim to keep total stagger within 500ms; narrative sequences may need a different budget. Never delay essential interaction for decoration.

> Deep dive: [director/choreography.md](director/choreography.md)

## Emotion-to-Motion Map

| Emotion | Character | Path | Easing | Duration |
|---------|-----------|------|--------|----------|
| Joy | Bouncy, arcs | Curved, upward | ease-out-back | 200-400ms |
| Calm | Smooth, flowing | Gentle curves | sine ease-in-out | 500-1000ms |
| Urgency | Sharp, fast | Straight lines | ease-out | 100-200ms |
| Sadness | Slow, downward | Drooping curves | cubic ease-in-out | 600-1200ms |
| Surprise | Sudden, expanding | Radial outward | ease-out-expo | 150-300ms |
| Elegance | Slow, controlled | Long arcs | (0.4,0,0.2,1) | 400-700ms |
| Playfulness | Bouncy, irregular | Arcs, squiggly | ease-out-back | 200-350ms |

**Path as language**: Angular = tense. Curved = friendly. Spiral = whimsical. Diagonal = purposeful. Vertical = growth/weight. Horizontal = progress.

> Deep dive: [director/emotion-mapping.md](director/emotion-mapping.md)

## Weight Classification

| Weight | Examples | Duration | Overshoot | Easing |
|--------|----------|----------|-----------|--------|
| Heavy | Modals, overlays | 300-500ms | 0% | Gentle, high damping |
| Medium | Cards, panels | 200-350ms | 3-5% | Moderate |
| Light | Tooltips, badges, icons | 80-200ms | 5-15% | Responsive |

## Quality Rules

### CRITICAL — never break
1. **Ease spatial movement** — linear motion reads as mechanical, so reserve it for spinners and progress bars
2. **Pair opacity with position or scale** for important state changes, because an opacity-only change is easy to miss
3. **Break movement across more than 1/3 of the screen** with an intermediate keyframe, so the eye can follow the path
4. Add secondary or ambient layers only when useful; a targeted feedback interaction may need just one layer.

### HIGH — strongly follow
1. Match duration to element type (see tables)
2. Use directional easing (ease-out entrance, ease-in exit)
3. Apply Disney principles (especially anticipation, follow-through)
4. Maintain consistent personality across scene

> Full checklist: [reference/quality-checklist.md](reference/quality-checklist.md)

## Troubleshooting Quick Reference

| Problem | Likely Cause | Fix |
|---------|-------------|-----|
| Looks robotic | Linear easing or no arcs | Add easing curves + arc paths |
| Feels too slow | Duration too long for element type | Check duration table, use ease-out |
| Feels cheap/flat | Missing secondary + ambient | Add shadow motion + background life |
| Too distracting | Too many elements moving | Apply 1/3 rule, reduce amplitude |
| No personality | Generic easing everywhere | Apply personality archetype consistently |

> Deep dive: [reference/troubleshooting.md](reference/troubleshooting.md)

## Route carefully

This skill is an **upstream principles advisor**. It teaches motion decisions;
it does NOT produce assets, code, or renders. Route to a peer for execution:

| If the user needs… | Route to |
|---|---|
| UI implementation code (React components, Tailwind, MUI, shadcn) | `/ak-frontend-design` |
| Static banner/social/ad asset generation | `/ak-banner-design` |
| Video strategy, script, storyboard, thumbnail, Veo or programmatic (Remotion) generation | `/ak-video` |
| Brand identity, logo, CIP, poster, editorial | `/ak-design` |
| Design tokens, component specs, three-layer token architecture | `/ak-design-system` |
| Voice/audio generation | `/ak-elevenlabs` |

Resolve each peer from the live installed catalog before routing. If unavailable, report the execution gap without inventing a capability. Use this skill **before** available peers: choose emotion, personality, timing,
easing, and choreography here — then hand implementation-specific properties
(exact Tailwind class, exact Lottie keyframe, exact Framer Motion prop) to the
peer. If the user asks only "make it move nicely", stay here and produce a
principled brief; if they ask "write the Framer Motion code", route immediately.

## Marketing surfaces

Marketing motion is not decoration — it is conversion craft. Map the principles
above to these recurring marketing surfaces:

Per-surface recipes: hero section entrance, CTA feedback loop, promo/campaign entry, landing page choreography, HTML5 display ads (IAB constraints), email/newsletter previews, and scroll-driven storytelling.
Load `references/marketing-surface-playbooks.md` when animating a specific marketing surface.

### Brand motion identity (define once, reuse everywhere)
- **Signature easing** — one curve for 80% of interactions.
- **Duration palette** — quick / standard / slow (see `director/motion-personality.md`).
- **Entrance pattern** — one archetype for entrance across every surface.
Reuse these from the brand system when available. Establish them only when new brand motion is requested; a local transition fix does not require a system redesign.

## File Reference

**Philosophy** (director/):
- [core-philosophy.md](director/core-philosophy.md) — Three Pillars deep dive
- [decision-framework.md](director/decision-framework.md) — Full decision pipeline
- [disney-principles.md](director/disney-principles.md) — 12 principles, UI-adapted
- [motion-personality.md](director/motion-personality.md) — 4 archetypes + brand identity
- [emotion-mapping.md](director/emotion-mapping.md) — Emotion → motion + color psychology
- [choreography.md](director/choreography.md) — Multi-element coordination
- [narrative-structure.md](director/narrative-structure.md) — Micro-story framework
- [context-adaptation.md](director/context-adaptation.md) — Platform, a11y, performance

**Reference** (reference/):
- [timing-easing-tables.md](reference/timing-easing-tables.md) — Duration + easing lookups
- [property-selection.md](reference/property-selection.md) — Property communication guide
- [troubleshooting.md](reference/troubleshooting.md) — Animation smells + fixes
- [quality-checklist.md](reference/quality-checklist.md) — Evaluation criteria

**Patterns** (patterns/):
- [entrance-exit.md](patterns/entrance-exit.md) — Entrance/exit recipes
- [state-feedback.md](patterns/state-feedback.md) — Success, error, loading, hover
- [ambient-continuous.md](patterns/ambient-continuous.md) — Looping, breathing, parallax
- [multi-element.md](patterns/multi-element.md) — Stagger + choreography recipes
