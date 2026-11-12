# Issue #436: product UI kit and brand kit for motion-graphic

Status: in progress. Branch `claude/bold-newton-y2frj6`, base `dev`.

## Outcome

- Five new layout devices the storyboard can pick per beat, drawn and animated by the HyperFrames renderer:
  `chat` (chat window, the user's prompt typed in), `tool-call` (tool card with a running status, then done),
  `pipeline` (job pipeline of steps), `player` (preview player with an Approve button), `meter` (usage meter
  with a cap).
- Brand kit for `motion-graphic`: the brief accepts `brandUrl` (the brand's website), `brandLogo` (an https
  URL or an uploaded image data URL) and `brandColors`. A new `motion-graphic.brand` stage reads the site
  through an SSRF-guarded fetcher (name, theme colours, logo), stores the logo in tenant storage, and the
  compose stage draws a logo lockup (logo and name) on the hook and CTA cards.

## Constraints

- The worker never fetches arbitrary URLs unguarded: public https only, pinned DNS, every redirect hop
  re-validated, byte and time caps.
- A brand site that cannot be read never fails the job: the stage records a `warning` and continues.
- Old IRs and briefs stay valid (all new fields optional).

## Acceptance

- Schemas, JSON schemas, renderer markup and motion, storyboard prompt, storyboard review words, docs.
- Unit tests for the new layouts, the brand page parser and the brand stage; `pnpm check` green.
- A real render of the new layouts and the lockup checked by eye (frames).
