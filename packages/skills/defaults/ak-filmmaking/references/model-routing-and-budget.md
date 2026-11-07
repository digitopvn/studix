# Model routing and budget

Route by job, not brand loyalty. Provider names, models, prices, duration
limits and features change often; any value used for a decision must come from
live evidence (the installed generation skill, the provider's current docs or
pricing page, the user's account) and be recorded with its source and date.
Never quote remembered numbers as current fact.

## Budget modes (`project.json` `budget_mode`)

| Mode | Policy |
|---|---|
| `low` | Cheapest model for previs and ordinary shots; premium only for HERO; fewer retries; dedicated lipsync only on HERO close framings |
| `balanced` | Mid-tier for character shots, economy B-roll, premium HERO; dedicated lipsync on CHARACTER_CRITICAL and HERO close framings |
| `quality` | Best reference-aware models for character footage; more retries; dedicated lipsync on every visible speaking shot of STANDARD and above |

## Tiers

`film.py route` maps each shot's render class and the budget mode to a tier and
lists the capabilities the shot needs:

| Class | low | balanced | quality |
|---|---|---|---|
| PREVIS | economy | economy | economy |
| CHEAP_BROLL | economy | economy | standard |
| STANDARD | economy | standard | standard |
| CHARACTER_CRITICAL | standard | standard | premium |
| HERO | premium | premium | premium |

Capabilities come from the graph: `multi_reference` (several conditioning
images), `start_frame` (approved keyframe), `audio_reference` and
`native_lipsync` (visible dialogue), plus any declared `model_requirements`
such as `end_frame`, `long_take`, `physics`, `camera_control` or `extend`.

## Choosing a provider for a tier

1. Discover the installed generation skills and what the user can access.
2. For the candidate models, collect current evidence on the dimensions that
   matter for the shot: reference consistency, number of reference images,
   audio-reference and lipsync support, motion and physics quality, max
   duration, resolution, start/end frame, extend, latency and cost per second.
3. Pick the cheapest option that meets the shot's capabilities and tier; use
   a short test generation when evidence is thin.
4. Record `provider`, `model`, `seed`, `prompt_version`, `references` and
   `cost` (with its evidence source) on the generation entry.

Examples of current providers (Seedance, Veo, Runway, Kling, LTX for video; Sync
and similar tools for lipsync) are illustrations, not assumptions about what is
installed or what they support today.

## Cost tracking

- `estimate` on each shot: expected generation seconds (including retries) and
  cost, with the evidence source.
- Each generation and lipsync pass records its actual cost; audio cues record
  theirs.
- `film.py costs` totals estimated versus recorded spend per render class and
  per stem, plus generated, selected and discarded seconds and attempt counts.
  It never converts currencies or fills in missing prices: foreign-currency
  and unpriced items are listed separately.
- A shot exceeding its `retry_budget` is a signal to re-plan the shot (simpler
  action, different coverage, better keyframe), not to keep rolling.
