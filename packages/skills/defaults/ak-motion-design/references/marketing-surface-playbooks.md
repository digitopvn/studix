# Marketing Surface Playbooks

## Hero section entrance
- Personality: match brand archetype (SaaS = Corporate/Premium; DTC = Playful/Energetic).
- Choreography: headline first (staged), subhead 100–150ms after, CTA last with subtle overshoot.
- Total budget < 800ms; do not delay above-the-fold CTA visibility beyond 400ms.
- Scroll-triggered secondary content: use ease-out at 20–40px offset; parallax bg only ≥1024px.

## CTA feedback loop
- Hover: scale 1.02–1.05, <100ms (see `../patterns/state-feedback.md`).
- Press: personality-matched squash + release overshoot.
- Post-submit: crossfade spinner → checkmark (200ms) + color-to-green (200ms) + text fade (200ms, 100ms delay). Total success ≤ 500ms.
- Error: horizontal shake 2–3 cycles, ±10–15px, 300–400ms, no overshoot (see `../patterns/state-feedback.md`).

## Promo / campaign entry (modal, banner, popover)
- Backdrop dims 200ms, container scales 95→100 + fades in 300ms with 50ms delay.
- Dismiss = 65–75% of entrance duration; exit direction matches entrance origin.
- Autoplay looping promos: sine ease-in-out, ≥2000ms/cycle; must pass `prefers-reduced-motion` (fall back to opacity fade only).

## Landing page choreography
- Section entrance stagger: 50–100ms between elements; total stagger < 500ms per viewport (see `../director/choreography.md`).
- Hero → social proof → feature → CTA: same easing family across sections, varying only duration and amplitude.
- Data / stats reveal: draw from 0 with `ease-out`; number count-up ≤ 1200ms; single hero metric.

## HTML5 display ads (IAB constraints)
- Total animation duration ≤ 15s per IAB spec; max 3 loop iterations.
- Initial-load weight within the unit's IAB k-weight budget (150 KB gzip for
  300×250; some units allow 200–300 KB); push heavier assets to subload
  (≤ 2 MB) after page load. Google Ads uploaded HTML5 is stricter (150 KB).
- Animate only `transform` + `opacity` (compositor-only, no layout/paint) and
  target 60fps rendering; IAB does not mandate a frame rate — legacy display
  guidance measured animation at up to 24 fps.
- Ambient budget ≤ 20% of primary energy so the CTA still owns attention.

## Email / newsletter previews
- CSS-only, no JS: rely on `@keyframes` + `animation-play-state` fallbacks.
- Static-first fallback for Outlook/Gmail app: primary meaning must land without motion.
- Cinemagraph / short-loop GIF: 800–1500ms loop, ≤ 500 KB, ease-in-out sine.

## Scroll-driven storytelling (long-form landing / product page)
- One primary reveal per fold; ambient counter-motion for depth.
- Never parallax text; keep foreground ≤ 100px displacement (see `../patterns/ambient-continuous.md`).
- Respect `prefers-reduced-motion`: swap parallax for opacity crossfade.
