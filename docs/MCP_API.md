# MCP API

The northbound contract AI clients see at one Streamable HTTP endpoint:
`${STUDIX_APP_URL}/mcp` (production: `https://app.studix.digitop.ai/mcp`, dev:
`https://dev-app.studix.digitop.ai/mcp`).

Source of truth for exact field shapes: the zod schemas in
`packages/shared/src` (envelope, `ErrorCode`), `packages/video-ir/src`
(briefs, specs, IR) and the tool registrations in `apps/mcp-server/src`.
`studix_inspect` returns the live JSON Schemas at runtime. This page records the
intent and the stable rules; it does not duplicate field lists.

## Transport and auth

- Transport: MCP Streamable HTTP, served with `@modelcontextprotocol/server` v2
  on Express 5 ([ADR-0004](decisions/0004-mcp-in-mcp-gateway-trust-boundary.md)).
- Auth: `Authorization: Bearer stx_<env>_<random>`, a workspace API key created
  in the dashboard. The key resolves to exactly one workspace; every tool call
  runs in that tenant. Missing, unknown or revoked keys fail with
  `UNAUTHENTICATED`; a key without the needed scope fails with `FORBIDDEN`.
- Auth, OAuth: AI clients that support MCP authorization connect with only the
  URL. `/mcp` publishes protected resource metadata
  (`/.well-known/oauth-protected-resource/mcp`) and answers `401` with a
  `WWW-Authenticate: Bearer ... resource_metadata="..."` challenge; the client
  discovers the authorization server (`<app URL>/api/auth`), registers, and
  runs authorization code + PKCE. The user signs in, picks a workspace and
  approves `studix:read` and optionally `studix:write`. The access token is
  bound to the `/mcp` resource and a workspace; a token missing `studix:read`
  fails with `403 insufficient_scope`. OAuth tokens never decide approvals or
  hold publish, API-key or member-management permissions. Users revoke a connection
  from the dashboard's Connected apps page
  ([ADR-0006](decisions/0006-auth-and-oauth-client-compatibility.md)).
- Requests whose `Host`/`Origin` is not derived from the configured
  `STUDIX_*_URL` values are rejected.

## Output envelope

Every tool returns the same envelope as structured content:

```text
{
  status,          // outcome of this call
  data,            // tool-specific payload (typed per tool)
  next[],          // suggested follow-up actions (tool + arguments hint)
  error?: { code, message, retryable, suggestedAction },
  traceId          // correlates with dashboard traces
}
```

Rules:

- `next[]` is always present; an empty list means nothing further is expected.
- `error` is present only on failure. Clients branch on `error.code`, never on
  `message` text.
- `retryable: true` means the same call may succeed later unchanged; follow
  `suggestedAction` otherwise.
- Media is returned as signed URLs or asset refs, never inline binary.

### Error codes

| Code                  | Meaning                                                                   | Typical retryable |
| --------------------- | ------------------------------------------------------------------------- | ----------------- |
| `VALIDATION`          | Input failed schema or business validation                                | no                |
| `NOT_FOUND`           | Resource absent in this workspace (also used for other tenants' ids)      | no                |
| `UNAUTHENTICATED`     | Missing, unknown or revoked API key                                       | no                |
| `FORBIDDEN`           | Key or grant lacks permission; denied connector tool                      | no                |
| `CONFLICT`            | Idempotency or version conflict                                           | no                |
| `BUDGET_EXCEEDED`     | Job or workspace budget would be exceeded                                 | no                |
| `TIMEOUT`             | Operation exceeded its deadline                                           | yes               |
| `CANCELLED`           | Job or call was cancelled                                                 | no                |
| `RATE_LIMITED`        | Workspace or upstream rate limit; out of quota or credit is not retryable | yes, except quota |
| `PROVIDER_OVERLOADED` | Upstream model provider overloaded after Studix backed off                | yes               |
| `PROVIDER_ERROR`      | Model, media or downstream MCP provider failed                            | depends           |
| `UNAVAILABLE`         | Dependency temporarily unavailable                                        | yes               |
| `APPROVAL_REQUIRED`   | Action needs a recorded human approval                                    | no                |
| `INTERNAL`            | Unexpected server error; quote `traceId`                                  | depends           |

The union is `ErrorCode` in `packages/shared`; the `retryable` column is a
guide, the per-error value is authoritative.

When a schema check fails inside Studix (for example a stage builds a Video IR
that breaks a limit), the error is `INTERNAL` with a one-line message naming the
first failing path and constraint, such as
`Schema check failed at /audio: Too big: expected array to have <=64 items`.
`details` carries `{ kind: "schema", issueCount, issues: [{ path, code, constraint?, message }] }`
with at most five issues (`path` is a JSON pointer, `constraint` the failed
zod check such as `too_big`), and `suggestedAction` says it is a Studix defect to
report with the job id. When a size limit tripped, it also suggests a shorter
or simpler brief until the fix lands.

## P0 native tools

| Tool                      | Purpose                                                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `studix_inspect`          | Capabilities handshake: server and schema versions, templates, formats, limits, constraints and JSON Schemas for inputs such as the creative spec. Call this first.                                                                                    |
| `studix_create_video`     | One goal -> async workflow. Accepts a brief (natural language, Vietnamese or English) or a validated spec from the host; an optional idempotency key makes retries safe. Returns `projectId`, `jobId`, `stage` and `next` quickly.                     |
| `studix_get_job`          | Job stage, progress, recommended next action, and signed preview/final URLs when ready. `waitSeconds` (max 50) holds the call until the status changes, with progress notifications (see [Job notifications](#job-notifications)).                     |
| `studix_webhook`          | Get, set or delete the workspace job webhook (see [Job notifications](#job-notifications)). Setting needs owner or admin.                                                                                                                              |
| `studix_get_project`      | Project, versions, latest job and renders with signed URLs.                                                                                                                                                                                            |
| `studix_cancel_job`       | Cancel a queued or running job; a running stage is aborted and the job ends `cancelled`.                                                                                                                                                               |
| `studix_retry_job`        | Requeue a `failed` job after its cause is fixed (see [Retrying a failed job](#retrying-a-failed-job)).                                                                                                                                                 |
| `studix_attach_media_job` | Attach an Atlas prediction found by an operator to a failed job's media call stuck in `submitting`, so a retry collects it (see [Retrying a failed job](#retrying-a-failed-job)).                                                                      |
| `studix_approve`          | Record a decision on a pending approval (for example `video.publish`). Only a human user may approve; an API key gets `FORBIDDEN`.                                                                                                                     |
| `studix_feedback`         | Feedback on one target of the current version: `shotId`, `sceneId`, `assetId`, `characterId` (a film character's voice), or `startMs` with `endMs`. Always stored as a comment. With a `patch`, it makes a new version and queues a render job. Async. |
| `studix_render`           | Queue a render of the current version, or of a given `versionId`, at a `renderPreset`. Returns `jobId`; poll `studix_get_job` for the MP4 URL. Async.                                                                                                  |

Every tool that touches a project returns its ids, `next[]` and `reviewUrl`
(`${STUDIX_APP_URL}/#/projects/<projectId>/review`), the dashboard page where a
person reviews and approves the storyboard. Signed preview URLs are included
when a finished render exists (`studix_get_job` `video.url`, `studix_get_project`
`renders[].url`, and `studix_feedback` `previewUrl` for a comment without a patch).

Behavior notes:

- Passing a host-authored spec skips internal planning; Studix does not pay a
  creative model a second time.
- Without a spec, one `DecisionRouter.decide("video.brief")` call turns the
  prompt into a brief draft (route set by `DECISION_ROUTES`, e.g.
  `video.brief=openrouter>rules`; the rules fallback is free and deterministic),
  then the brand-intro template builds the IR without a second model call
  ([ADR-0003](decisions/0003-jev-decision-provider-adapter-and-routing-fallback.md)).
- `studix_create_video` inputs: `prompt` or `brief` (one is required), `spec`,
  `title`, `idempotencyKey`, `budgetCents`, `deadlineSeconds` (10 s to 7 days;
  past it the job fails with `TIMEOUT`; without it a job gets 30 minutes, and a
  `skill-agent` job gets 60 minutes counted from its first claim, so queue time
  does not count), `renderPreset`, `planner`,
  `workflowTemplate`, `agentMode` (`harness` or `host`, see the agent stage
  handoff tools below) and `agent`.
- `brief.voiceover: false` asks for a voiceless video: no spoken voice-over, no
  captions read from it and no sound accent, so no speech provider is needed.
  `motion-graphic` and `marketing-video` honour it (marketing ads keep their
  music and SFX); `brand-intro` has no voice-over either way. It defaults to
  true.
- `agent: {runtime, providerConnectionId, model?, reasoningEffort?}` picks the
  runtime of the job's agent stages: `pi`, `claude` or `codex`. The connection
  must belong to the workspace (or be yours), be usable and be enabled for that
  runtime; otherwise the call fails with `VALIDATION`, `FORBIDDEN` or
  `NOT_FOUND`. `model` must be one the runtime runs on that connection: a Pi
  catalog model of the connection's provider, a Codex model (`gpt-5.1` to
  `gpt-5.5`, default `STUDIX_CODEX_MODEL`) or a `claude-*` id.
  `reasoningEffort` is `off`, `minimal`, `low`, `medium`, `high` or `xhigh`
  (Claude gets it as `--effort`, `minimal` as `low`, `off` as its default); a value
  other than `off` on a model without reasoning support is `VALIDATION`. The
  selection is stored on the job and in its model snapshot, so every attempt
  runs the same runtime, model and effort, with no fallbacks.
  A `pi` agent without `model` runs on the caller's `default` model preference:
  a user (or an OAuth client acting for one) sees their personal default first,
  a workspace API key sees only the workspace default. When none applies the
  call fails up front with `UNAVAILABLE` (`details.reason: "no_model_selected"`)
  unless the job runs in `host` mode or under a `planner`. An admin's pick in
  Settings → AI model is the workspace default once the workspace has a workspace-owned Pi key.
  The same refusal applies to a job created with no `agent` at all on a
  workflow that has an agent stage without a template fallback (`skill-agent`,
  `anime`, `long-form-film`) when the caller has no `default` model preference
  of either runtime. Host mode, a `planner`, a ready `spec`, and packs that fall
  back to a template (such as `motion-graphic`) are never refused.
  `studix_list_agent_runtimes` lists the usable choices. `planner: {runtime:
  "claude", providerConnectionId}` stays as an alias of a Claude `agent`.
- A `codex` agent needs `STUDIX_SANDBOX=docker` on the worker: `codex exec`
  runs inside the task's skill sandbox. A ChatGPT login is paid by the
  subscription (cost 0); an OpenAI key is billed by OpenAI.
- A `claude` agent runs a stage that asks for tools (the `skill-agent` pack's
  run stage) with the Claude Code CLI inside the same sandbox, with its full
  tool set and the stage's caps; other stages stay tool-less on the worker.
- `skill-agent` output contract ([ADR-0022](decisions/0022-agentic-video-authoring.md)): 1080p at the
  brief's aspect ratio, duration within 0.5 s of the brief, audible voice-over, -16 LUFS +/-2 with
  true peak <= -1 dBTP. The server re-checks the file and fails the job with `VALIDATION` (listing
  each problem) on a miss. The agent's visual QA passes land in the version metadata as `qaRounds`.
- `roles: {director?, builder?, qa?}` (`skill-agent`; `motion-graphic` takes `director`; each an `agent` object from any catalogue
  runtime and model, e.g. `pi` + `deepseek-v4.1-flash` as builder): the director writes the script and
  direction first; the builder makes the video (default: the job's `agent`); QA watches each render,
  scores taste, motion, brief and audio 0-10 and sends it back with notes below 7, at most 3 rounds.
  Scores land in the version metadata as `review` and on the job page
  ([ADR-0024](decisions/0024-client-authoring-and-agent-roles.md)). `motion-graphic` takes `director`
  only: the premium director tier (see the `motion-graphic` entry below). Any other role, or roles on
  another template, fail with `VALIDATION`.
- A stage that finished on its template instead of its agent shows `stages[].fallback` with the
  reason on `studix_get_job`; it is never silent. A job that names its `agent` (or `planner`) never
  falls back: an agent that cannot run fails the job with `UNAVAILABLE`.
- A stage that skipped an optional part instead of failing the job shows `stages[].warning`, for
  example the motion-graphic SFX accent or music bed when the media provider has no model or key for it.
- Each stage on `studix_get_job` carries `stages[].run`, summed from its attempt's usage lines:
  - `runtime`: `claude`, `codex` or `pi` for an agent run; `host` for the MCP client's own agent; `planner` for the legacy planner's model calls; `function` for plain code such as `brief`, `compose` or `finalize`.
  - The `model`, `reasoningEffort` and `connectionLabel` it ran on.
  - `costCents`, `inputTokens`, `outputTokens` and `turns`.
  - A stage books its spend when it ends, so a running stage has no `run` yet. The dashboard shows the cost, tokens and turns the runtime streams (`GET /api/jobs/:jobId/events`) until then.
  - Claude Code reports its cost only when the run ends.
  - A connection is named by its label, never by its id or key.
- Time spent parked is not counted against the deadline. While a job waits at a human gate
  (`waiting_approval`) or for a host agent task (`waiting_host`), the deadline
  is paused: what is left of it is kept and starts counting again when a worker
  claims the job after the approval or host submission. A job created already
  waiting at a gate starts its deadline at its first claim. A review can take
  as long as the approval stays valid (7 days) without failing the job with
  `TIMEOUT`; a stage that runs past the remaining budget still does. A job
  created without its own `deadlineSeconds` or `deadlineAt` also starts its
  default window at its first claim, and a retried job starts its window again
  at its next claim, so time spent queued behind another job never expires it; a
  deadline the caller sets stays an absolute time from creation. Retry backoff
  still counts. While paused, the job view has no
  `deadlineAt` and reports the budget left as `deadlineRemainingMs`. When
  deploying, drain old workers before new ones park jobs: an old worker claims
  a paused job without re-arming its deadline.
- A `queued` job view from `studix_get_job` (and a replayed create) carries `queue`: `position` (1 is next to run), `running` (jobs holding a worker slot, all
  workspaces; counts only) and a plain `reason`. A job waiting for a scheduled retry has no `position` and names
  its start time. The worker runs few jobs at once, and a long agent job holds its slot until it ends or reaches
  its deadline, so a job behind it waits; read `queue` before assuming it is stuck.
- `workflowTemplate` is a pack id from the registry in `@studix/skills`
  (`studix_inspect` lists them under `skills`); it defaults to `brand-intro`.
  An unknown id fails with `VALIDATION` before anything is stored, with
  `error.details.available` listing the registered ids. Adding a pack needs
  only `registerPack`; the server does not change. A Claude `planner` (or
  `agent`) combines with any pack: the pack's pipeline runs and its agent stages
  (for example the motion-graphic storyboard) run on that Claude connection and
  model; with the default pack the Claude planner writes the IR.
- A length or aspect ratio stated only in `brief.prompt` for the whole video
  ("a 60-second 16:9 video", "1920x1080", "video dọc, tổng 1p30") fills
  `brief.durationMs` / `brief.aspectRatio` when they are unset; the explicit
  field always wins. A part's length ("each 5 seconds"), a timecode, a decade
  or an asset's pixel size is not read. `motion-graphic` and `marketing-video`
  clamp the length to their own range; `anime`, `long-form-film` and
  `skill-agent` make the stated length. `brand-intro` reads the prompt in its
  own brief draft and clamps to 6–15 s.
- `workflowTemplate: "marketing-video"` makes one ad per `brief.directions[]`
  entry (1 to 6); a brief without directions makes one ad whose hook is its
  first key message (else the brand name), and a brief with neither is refused
  with `VALIDATION` before any job is created. All ads share the brief's brand,
  language, format and length (default 20 s, 9:16). The create job writes the
  script, generates one
  storyboard frame per beat and stops with the project `in_review`; it runs no
  image-to-video, voice or music. Frame prompts describe the scene only. Beats
  derived from a direction never carry its hook or messages, and the brand name
  and tagline are removed from every frame prompt, because the HyperFrames
  overlay sets the logo, wordmark and copy. Feedback with a patch that changes an
  image shot's `alt` (the frame description) regenerates the frame of that shot
  only, stores it as the next version and returns the project to review;
  unchanged shots keep their frames and review state. Each ad's voice-over must fit about three
  words a second of its length (a Vietnamese syllable is a word; an English
  word or brand name counts by its syllables, about two thirds of a word
  each), or the job fails with `VALIDATION` before any paid call. After a person approves the storyboard, `studix_render` animates
  the frames, adds voice-over, music and SFX, then renders, QA-gates and
  uploads one file per ad (`renders[]`). Any image-to-video or audio stage
  without an approved storyboard fails with `APPROVAL_REQUIRED`.
- `workflowTemplate: "motion-graphic"` builds a kinetic HTML/GSAP graphic
  (6 to 60 s, default 15 s 9:16; a length or aspect ratio written in the prompt,
  such as "a 60-second 16:9 intro", is used when the brief omits it) in the
  style profile that best matches the brief,
  with a generated voice-over, about one card every five seconds (3 to 12)
  when the agent writes the storyboard, one soft whoosh (generated once) on every cut except the one into the CTA card, one SFX accent where
  the CTA card lands and burned captions, then renders, QA-gates and uploads it in one job. It has no
  image-to-video; a music bed is added only when the agent's storyboard asks
  for one. The bed is composed as intro, build and a drop on the CTA card, dips
  under the voice, and its beats are found locally: cuts move onto a near
  downbeat (or beat) wherever every card keeps room for its line. Each card's
  headline and layout enter on the words the voice says them with (ElevenLabs
  word timestamps, else estimated); `metadata.beatSync` and `metadata.wordSync`
  report what was synced. Each storyboard beat may name a typed `layout` (a prompt being typed,
  code lines, chips wired to a hub, a checklist, a rolling counter, a row of
  cards, colour swatches, a stat, or a product UI device: a chat window typing a
  prompt and its reply, a tool-call card spinning on "running" then done, a job
  pipeline lit up to its running stage, a preview player pressed to Approve, a
  usage meter filling to its cap) that the card draws under its headline; the
  `visual` field stays a description. On a 16:9 frame headlines are set at
  display size and layouts drawn larger, so a card fills the frame. Burned
  captions are 44 px at a 1080 px short edge, and a layout is centred above
  them. Every card moves a camera (`push-in`, `pull-back`, `pan-left`,
  `pan-right`, `parallax` or `static`; a beat may pick its own `camera`, and two
  adjacent cards never share one), draws the style's depth planes (grid, glow,
  grain, vignette behind; corner brackets or bokeh in front) and carries one motif
  shape along the frame edge from card to card: the hook hard-cuts into the
  first message on a match cut, the other cuts vary through the style's
  transitions (`fade`, `slide`, `wipe`, `zoom`, `iris`, `whip`). Cards share the style profile's
  background; a high-energy profile fills the call-to-action card with its
  accent. A style profile (70 presets) locks the palette (without a brand kit),
  the type (bundled fonts; a brand kit's fonts win), the pacing (entrances one
  beat of its tempo) and the juice (the entrances a card may use, its exit and
  cut transition). `directions[0].visualStyle` naming a profile id or name (such
  as `glass-keynote` or `cinematic-product-launch`) locks that profile over the
  agent's pick. Premium director tier: `roles: {director}` runs the storyboard on
  that stronger agent with larger caps, and it may hand-write HTML for up to 3
  hero cards (never the call to action); a host agent may too, inline or as a
  file written with `studix_composition_write` and named as
  `hero: {compositionId, path}`. Every hero passes a lint (no scripts, images,
  links, `@` rules or external `url()`), a check (it shows the beat's on-screen
  line) and a visual QA before any paid stage (the renderer lints the composition
  and captures each hero to find content outside the frame or its 3% margin,
  over the captions, clipped text or a blank card). A hero that fails is drawn as
  a built-in card, listed in the storyboard stage's `warnings` or the compose
  stage's `heroQa`. A script derived from the brief (hook, messages, call to action) is
  fitted to the length: message cards go from the last one back, then the
  longest spoken lines are shortened. The hook and call-to-action cards and the
  on-screen text are kept, but their spoken text may be shortened, the call to
  action last. With `brief.voiceover: false` it needs no speech
  provider and makes on-screen text only. A missing SFX model or key skips the
  accent with a warning; a voice-over that cannot be generated still fails the
  job. Every voice take is measured before it is laid: a line longer than its
  card re-cuts the cards (same total length; captions, whooshes and the accent
  move with them), a line no re-cut can fit is voiced once more, brisker (a line
  that fits its card read up to 1.12x faster is voiced again only when the
  graphic still needs the time), and only speech that cannot fit the whole video fails with `VALIDATION`
  naming the lines past their cards and by how many milliseconds (`details.lines`). The storyboard agent gives every message
  card a layout device and each spoken line one idea in one sentence. After the
  render a vision model reviews a contact sheet (one hold frame per card) and
  scores each card 0 to 10 for `blank`, `too-small`, `illegible`, `repetitive`,
  `off-brief` or `headline-only`; failed cards (an issue, or a score below 6)
  go back to the storyboard agent, which redesigns only those cards (their
  voice-over and timing kept), and the graphic renders again: at most two
  rounds, only while the job budget holds a review, a redesign and a render.
  The job result carries the scores as `visualQa` (`status`: `passed`, `fixed`,
  `failed` or `skipped`, with a `reason`, and `rounds[].cards[]`). The review
  never fails the job: it is skipped with a reason in host mode, without an
  agent, when the agent's model cannot read images, or when time before the job
  deadline runs short; a failed redesign or re-render keeps the last good render.
- Brand kit for `motion-graphic`: `brief.brandUrl` (the brand's https site),
  `brief.brandLogo` (an https URL or a base64 `data:image/png|jpeg|webp|svg+xml`
  URL, at most 200,000 characters, about 146 KB of image; pass a larger logo as an https URL) and `brief.brandColors` (1 to 4 hex
  colours, most important first). The `motion-graphic.brand` stage reads the
  site's name (`og:site_name`, `application-name`, else the title), colours
  (`theme-color`, tile and mask-icon colours; greys dropped) and logo (SVG icon,
  apple-touch-icon, `og:logo`, JSON-LD `logo`, other icons) through the
  SSRF-guarded fetch, and stores the logo (the uploaded one wins; PNG, JPEG,
  WebP, GIF or SVG checked by its bytes; an SVG with script, event handlers or
  outside loads, or a raster over 4096 px on an edge or of unreadable size, is
  refused). The page is
  read with a linear tag scan, so a hostile page cannot hold the worker, and a
  base64 logo never reaches any agent's input. The brand's name, else the site's,
  and its logo are drawn as a lockup on the hook and CTA cards. The first
  colour becomes primary and accent, the second secondary; `brandColors` wins
  over `brand.palette`, and site colours are used only when the brief sets
  neither. A site or logo that cannot be read never fails the job: the stage
  reports a `warning` and the graphic goes on without it.
- `workflowTemplate: "anime"` and `"long-form-film"` make a narrative film
  (default 15 s and 60 s; 16:9 unless the brief says otherwise). The create job
  pauses twice for a signed-in person, on the approval mechanism: G0 (action
  `creative.gate`, scope `gate:G0`) after the scope agent has written the series
  bible and the tiered beat sheet, and G1 (`gate:G1`) after one model sheet per
  character and one frame per set. Each pause makes a review board the
  project's current version, so the dashboard review page shows what is being
  signed. An API key cannot approve a gate. After G1 the storyboard agent writes
  one panel per shot, every shot gets a keyframe conditioned on its lead
  character's approved sheet, and the job stops with the project `in_review`.
  Rejecting a gate fails the job with `FORBIDDEN`. At G1 the reviewer can also
  request changes on named designs instead (see the next section): the job
  redraws only those sheets or set frames, with the note added to the prompt and
  the bible's anchors kept, publishes the revised board as a new version and
  asks G1 again. Each redraw is billed once. If the reviewer requests changes
  on storyboard shots, `studix_render` on the current version redraws only
  those keyframes, with each shot's note added to the prompt and the same sheet
  conditioning. It then publishes the result as a new version that is back
  `in_review`, keeps the old frames as history and renders nothing. Each shot is
  redrawn at most twice; a third request fails with `VALIDATION` before any
  paid call. After a person approves the
  storyboard, `studix_render` records the dialogue first. Each speaking character has one voice
  for the whole film, cast in the bible as `voice.voiceRef`
  (`<voice>`, `<vendor>:<model>` or `<vendor>:<model>@<voice>`, for example
  `openrouter:google/gemini-3.8-flash-tts@Leda`). A brief can name it. To cast it later, send
  `studix_feedback` with `characterId` and a patch under that character's
  `/metadata/film/production/characters/<i>/voice`; a shot, scene or time-range target refuses
  that path. A named model overrides the
  language's speech route. Two speakers left with the same voice, including both uncast, fail with
  `VALIDATION` before any line is paid for. Every line is read with direction built from the
  character's voice, the line's delivery, the shot and the film's tone. The render then turns T2/T3 shots into
  480p image-to-video clips and T0/T1 shots into film-engine scenes, lip-syncs
  every shot with a visible speaker on the recorded line, adds one score cue per
  scene and the SFX, checks continuity (G3), then renders, QA-gates (G4) and
  uploads the film. A scope that breaks the pack's rules (tier mix, lip-sync
  routing, words per second, continuity chain, at most 16 audio tracks, SFX cues
  in English) fails with `VALIDATION` before G0 is requested. SFX cues describe
  the sound heard, in English, because the effect model reads a cue in another
  language aloud. A scope stored before this rule fails at the score stage,
  before any music or SFX is paid for. When the worker runs with
  `STUDIX_SPEECH_GATE=true` (QA image `speech`), every effect is also checked for
  a human voice before it joins the mix: a voiced effect is generated once more,
  and a second voiced take fails the job with `VALIDATION` naming the shot and the
  cue (see [QA.md](QA.md#chặn-tiếng-nói-trong-sfx)). A cue whose human voice is intended (a
  crowd, laughter) is also listed in the shot's `voicedSfx` and skips that check. To rewrite cues, send
  `studix_feedback` on the shot, its scene or a time range over it, with a
  patch under `/metadata/film/scope/scenes/<i>/shots/<j>/sfx` (or `.../voicedSfx` to mark a cue as intentionally voiced).
- A film render pays only for the media whose request changed. Each line, clip,
  lip-sync pass, score cue and effect is keyed by what produces it: provider,
  kind, model (the provider's default when none is named), prompt, parameters
  and the sha256 of its input files. Job, stage and asset ids are not part of
  the key. A request with the key of an output the workspace already paid for,
  whose stored object still has the recorded sha256, reuses that output. The
  stage estimate counts it as free, and the usage line has `quantity` 0,
  `costCents` 0 and `metadata.reused: true` with `reusedFromJob`. A new SFX cue
  therefore buys one effect, not the film's lines, clips and lip-sync again. The
  marketing and motion-graphic packs reuse their clips, music, SFX and
  voice-over the same way.
- `planner: {runtime: "claude", providerConnectionId}` is opt-in. The worker
  then plans the VideoIR with the Claude Agent SDK, billed to that Anthropic API
  key ([ADR-0011](decisions/0011-claude-agent-runtime-and-provider-auth.md)).
  Connection ids are listed in the dashboard under **AI & Providers**.
  - Refused with `VALIDATION` together with `spec`, because a spec is not planned.
  - Refused at creation with `UNAVAILABLE` when the operator has not enabled
    `STUDIX_CLAUDE_PLANNER`, or when the connection is missing, revoked or in
    another workspace; `FORBIDDEN` when it is someone else's personal key.
    A job created with an `stx_` key can use workspace keys only. An AI client
    connected through OAuth acts for its user, so it can run that user's
    personal keys and defaults, but only a signed-in user can add, change or
    remove them.
  - There is no fallback: if Claude cannot plan (rejected key, budget, invalid
    output), the job fails with that error instead of using the default planner.
- Publishing is gated: a publish job waits in `waiting_approval` until a human
  approves it in the dashboard.
- Re-sending `studix_create_video` with the same idempotency key in the same
  workspace returns the original job instead of a new one.

### Retrying a failed job

A `failed` job is terminal for the worker, but `studix_retry_job` (`POST /api/jobs/:jobId/retry` on the dashboard API) requeues it as the same job once the cause is fixed, for example a storage bucket that was missing after the provider had already charged for the media.

- Stages that succeeded keep their outputs and are not run again.
- The failed stage reuses its media job journal: asynchronous upstream jobs (for example Sume and Atlas image and video) that completed are collected, not submitted again, and a call that is still in flight is resumed by its upstream id. Synchronous outputs (some audio routes) are reused from the stage's media directory, which belongs to the job and not to the attempt (`<workRoot>/<jobId>/media/<stage>`; only the media provider writes there and stages never clear it), so a retry on the same worker finds the file and does not pay again. After a move to another worker that local file is gone and the call runs again; the journal only records the upstream job, not the file.
- Usage events keep their `dedupeKey`, which is tied to the upstream job, so the resume bills no call twice.
- Gates already decided on the job (approved, or consumed) are read from the database and are not asked again.
- The job gets a fresh allowance of 3 attempts, and a deadline starts again with the window the caller asked for when the job was created (stored with the job, so a job that waited at a gate gets the same window, not a longer one). The budget is not reset: spend so far still counts against `budgetCents`.
- Only a `failed` job can be retried (any other status returns `CONFLICT`). `video.publish` jobs cannot (`VALIDATION`: a publish is not idempotent, so start a new one), and neither can a job whose `job.start` approval was expired, rejected or never granted by a person (`APPROVAL_REQUIRED`). Agent stages are not retried automatically, but a manual retry re-runs a failed agent stage and its spend is billed again.
- The caller needs the `job:retry` permission (owner, admin and editor roles; API keys need the scope). Migration `0012` adds the scope to keys issued before it existed whose scopes were exactly the editor, admin or owner set, so they keep their role label; a key with any other scope set is `custom` and needs a new key that includes `job:retry`.
- A retried render job only moves its project to `in_review` while the project is still `rendering`, so a later status set by anything else (a newer review decision, an archive) is not overwritten.
- A job whose Atlas call is stuck in `submitting` (the error says the request "may already have been charged") is not unblocked by a retry alone, because Studix cannot tell whether Atlas accepted the run. Find the prediction in `multix history` or the Atlas Cloud console, then call `studix_attach_media_job` with the job id, the stage, the `idempotencyKey` from the error details and the `predictionId` (`POST /api/jobs/:jobId/media-jobs/attach` on the dashboard API, body `{ stage, idempotencyKey, predictionId }`). It needs the `job:recover` permission, which only the platform `operator` role holds: Atlas runs every tenant's calls on the platform's one key, so nothing upstream proves which workspace a prediction belongs to, and a tenant owner or admin could otherwise pull another tenant's output into their job. No API or dashboard flow assigns `operator`; set it on the member row in the database, and only operators can mint keys with the scope (migration `0020` removes it from every key issued while owners and admins held it). Before writing, Studix reads the prediction with `atlas status` (the app needs `MULTIX_BIN` and the Atlas key; without them attaching is `UNAVAILABLE`) and refuses it with one `VALIDATION` error, whatever the reason, unless Atlas knows it, it runs the record's model, and it was created after the record was submitted (2 minutes of clock skew allowed). It also refuses a prediction id that any media record already refers to (`CONFLICT`), works only while the job is `failed` (otherwise `CONFLICT`) and only on a `submitting` record (`NOT_FOUND` for an unknown stage or key, `CONFLICT` for any other state), and is audited as `job.media_job_attached`. The retry that follows collects that prediction instead of submitting again. If Atlas never ran the request, there is no prediction to attach; start a new job.
- The dashboard job page shows a **Retry job** button for a `failed` job that is not a publish.
- A failed job keeps its attempt work directories so the retry can reuse synced media; the worker removes a job's directory once nothing has written to it for `WORKER_WORK_DIR_RETENTION_HOURS` (default 168, checked at startup and hourly; activity is the newest write under the job directory). Past that, a retry regenerates that media.
- The action is audited as `job.retried`. A failed job's `next` list suggests the tool.

### Feedback, render and storyboard approval

- `studix_feedback` takes an optional `annotation` that pins a note to a
  paused frame: `intent` (`change`, `fix`, `remove`, `add`, `keep`),
  `priority` (`must`, `should`, `nice`), `frameMs`, and marks as fractions
  (0 to 1) of the frame: `region`, up to 20 `pins`, up to 30 pen or arrow
  `strokes` of 2 to 120 points, a PNG, JPEG or WebP `snapshot` data URL (at
  most 100 000 characters) and up to 6 `references` (http(s) URLs, or image
  data URLs of at most 30 000 characters). The dashboard review toolkit writes
  these notes and keeps each request under the 256 KB API body limit.
- `studix_get_project` with `includeFeedback: true` adds `feedback[]`, the
  open notes on the current version. Images do not travel as base64 text:
  each snapshot and attached reference image is an image content block, and
  the note names it by content index (`snapshotImage`, `references[].image`;
  index 0 is the text block). At most 8 images are returned; `imagesOmitted`
  counts the rest. Pen strokes come back as their start, end and point count.
- `studix_feedback` with no `patch` stores a comment and returns
  `allowedPaths`: the JSON pointers a patch for that target may touch (the
  shot, the scene with `/timeline`, the asset, the shots overlapping the time
  range, or a film character's `voice` in the production bible). In a film, the
  SFX cues of the targeted shots in the scope are allowed too, with their `voicedSfx` list. `next[]` suggests the call with a
  patch.
- A `characterId` target is a character of the film's production bible
  (`NOT_FOUND` for any other id, or for a video without one). Its `shots` are
  the shots the character speaks in. The patch changes no scene or shot, so the
  storyboard approvals stay as they are, and the render the patch queues
  records the character's lines with the new voice.
- A `patch` is a JSON Patch (`ops[]`) on the VideoIR with absolute pointers. An
  op outside `allowedPaths` fails with `VALIDATION`, with `details.outside` and
  `details.allowedPaths`, and nothing is stored. A valid patch becomes a new
  immutable version that is current from then on. Only the nodes that depend on
  the change are invalidated, and they are returned as `invalidated`
  (`shot:<id>`, `scene:<id>`, ...). The render job reuses cached stage work for
  everything else.
- A comment without a `patch` on an `assetId` the current version shows, while
  a job of the project waits at a creative gate, requests changes on that gate
  (the API key needs `project:write`). The approval comes back as
  `changes_requested` with `changes: {targets, note, invalidated}`, where
  `invalidated` lists every node of the reviewed board that depends on the
  asset; `next[]` suggests polling the job. A request is not an approval: the
  gate is asked again after the redraw, and only a signed-in person can approve
  it. On the dashboard, `POST /api/approvals/:approvalId/decision` takes
  `{decision: "changes_requested", targets: [assetId, ...], comment}` for the
  same decision; `approved` and `rejected` are unchanged.
- `baseVersionId` is optional. When it is not the current version, the call
  fails with `CONFLICT`, so feedback is never applied to a newer version than
  the one it was written for.
- With an `idempotencyKey`, `studix_feedback` is safe to retry. The key is
  stored on the new version together with the comment id, so a call that
  stopped after the version was stored is completed by the retry (comment,
  revisions, job), even when `baseVersionId` is no longer current. Retries,
  including concurrent ones, return the same version, comment and job, with
  `replayed: true`.
- A comment without a patch creates no version or job, so its key is stored on
  the comment itself (unique per project). A retry returns the stored comment
  with `replayed: true`; the same key with a different comment or with a patch
  is `CONFLICT`.
- `studix_render` renders a stored version, and that version becomes current.
  A film storyboard redraw (above) is the exception: its job's new version
  becomes current only once it is committed, back in review.
  Both tools accept `idempotencyKey` and `budgetCents`. A budget above the
  approval threshold parks the job in `waiting_approval`.
- Permissions: a patch or a render needs `project:write`. A comment needs
  `project:write` or `approval:decide`. Other tenants' projects are `NOT_FOUND`.
- Approving the storyboard, its scenes and its shots is a human gate. It is
  done in the dashboard at `reviewUrl` and is not exposed as an MCP tool.
  Stages that generate per-shot media from the plan, such as image-to-video,
  run only after the storyboard is `approved`. Otherwise the job fails with
  `APPROVAL_REQUIRED`. A patch that changes a shot puts that shot, its scene
  and the storyboard back in review. "Rendered" never means "approved".

### Review app (MCP Apps)

`studix_create_video` and `studix_get_job` carry tool `_meta` that links them
to the MCP App `ui://studix/review.html` (`_meta.ui.resourceUri` for MCP Apps
hosts such as Claude, `openai/outputTemplate` for ChatGPT). The resource is
served with MIME type `text/html;profile=mcp-app`, and its CSP allows media only
from the storage origins. Hosts without MCP Apps ignore the `_meta` and show the
JSON result as before.

The app plays the newest render and shows the storyboard as a timeline and a
shot list. The user pauses, optionally drags a region on the frame, and sends a
note. The note becomes a `studix_feedback` call on the selected shot, or on the
time range with `annotation: {frameMs, region}`. **Approve** calls
`studix_approve` for a pending approval; an API key gets `FORBIDDEN`, and the
app then opens `reviewUrl`, where a person approves the storyboard.
**Re-render** calls `studix_render`. The app reads its data through
`studix_review` `{projectId}`, which returns the storyboard, timeline, newest
video and open notes. That tool has `_meta.ui.visibility: ["app"]`, so MCP
Apps hosts keep it away from the model.

### Job notifications

Polling `studix_get_job` always works. Three ways avoid it:

- **Wait in the call.** `studix_get_job` with `waitSeconds` (at most 50) holds
  the call until the job changes status or finishes. If the request carries
  `_meta.progressToken`, Studix sends `notifications/progress` meanwhile
  (`progress` 0 to 100, `message` the status and stage).
- **Subscribe to the job resource.** `studix://jobs/{jobId}` (a resource
  template; `resources/read` returns the job as `studix_get_job` does). Open a
  `subscriptions/listen` stream (protocol 2026-07-28) that names the URI, and
  each status or stage change sends `notifications/resources/updated`; then read
  the resource. The `/mcp` endpoint is stateless, so 2025-era clients cannot
  hold a `resources/subscribe` session and keep polling. Notifications are
  per API replica: each replica watches job changes itself.
- **Webhook.** One per workspace: `studix_webhook` `{action: "get" | "set" |
  "delete", url?}`, or `GET|PUT|DELETE /api/webhook` (`{url}`). Setting it needs
  `apikey:manage` (owner or admin) and returns the signing secret `whsec_…`
  once. The URL must be https and resolve to public addresses
  (`STUDIX_WEBHOOK_ALLOW_LOCAL=true` allows http and private hosts in local
  development). Each status or stage change is a POST with body
  `{type: "job.status", eventId, jobId, projectId, status, stage, progress, at}`
  and headers `studix-event-id` and `studix-signature: t=<unix>,v1=<hex>`,
  where `v1` is HMAC-SHA256 of `<t>.<raw body>` with the secret. Delivery is at
  least once with no retry; dedupe on `studix-event-id` and poll when a post
  was missed.

MCP Tasks are not offered: the SDK in use (`@modelcontextprotocol/server`
2.4, protocol 2026-07-28) has dropped them.

### WebMCP in the dashboard

A signed-in dashboard registers `studix_create_video`, `studix_get_job`,
`studix_get_project`, `studix_feedback`, `studix_render`, `studix_cancel_job`
and `studix_retry_job` with the browser's `modelContext` when the browser
supports WebMCP. Names, descriptions and input schemas come from
`GET /api/webmcp/tools`, and calls go to `POST /api/webmcp/tools/:name`. Both
use the same tool definitions as `/mcp`, with the session's workspace.

The reply to a call is the same `CallToolResult` as `/mcp`: the envelope as
text and `structuredContent`, the image blocks, and `isError` on failure.

### Agent stage handoff tools

A creative agent stage (for example `brand-intro.script`) runs in one of two
modes under the same contract: the stage's input schema, output schema and
limits ([ADR-0015](decisions/0015-agent-stage-caps-and-host-handoff.md)). The
job payload's `agentMode` picks the mode; `studix_create_video` sets it from its
`agentMode` argument. `harness` (the default) runs the
Claude agent inside the worker under hard caps. `host` hands the stage to the
MCP client's own agent: the job moves to `waiting_host`, and `studix_get_job`
returns `next[]` pointing at `studix_list_agent_tasks`.

| Tool                       | Arguments                               | Returns                                                                                           |
| -------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `studix_list_agent_tasks`  | `jobId?`, `limit?`, `cursor?`           | Tasks waiting for a host output: `id`, `jobId`, `stage`, `attempt`, `status`, `expiresAt`.        |
| `studix_get_agent_task`    | `taskId`                                | `instructions`, `input`, `outputSchema` (JSON Schema), `limits` and the `attempt` to submit with. |
| `studix_submit_agent_task` | `taskId`, `attempt`, `output`, `usage?` | `{task, replayed}`. An accepted output requeues the job, which continues from the next stage.     |
- `limits` holds `maxTurns`, `maxTokens`, `maxCostCents`, `timeoutMs` and
  `tools`, the allowlist of tool names the agent may call. Only the time limit
  is enforced in host mode: the task expires at `expiresAt`. The other limits
  are the budget the harness would have; respect them.
- `output` is checked against the task's `outputSchema`, the same schema the
  worker applies when the job resumes. A stage that wraps its agent (such as
  `motion-graphic.storyboard`) adds its own fields itself; the host sends only
  what `outputSchema` lists. A mismatch fails with `VALIDATION`, `details.reason:
  "invalid_output"` and `details.issues`, and nothing is stored, so fix the
  output and submit again. Secrets in the output are redacted before it is
  stored.
- Submissions are idempotent per attempt. The same output again returns
  `replayed: true`; a different one is `CONFLICT` with
  `details.reason: "already_submitted"`. A wrong `attempt` is `CONFLICT`
  `stale_attempt`, a job that stopped waiting is `CONFLICT` `not_waiting`, and a
  task past `expiresAt` is `TIMEOUT` `expired`.
- `usage` (`turns`, `inputTokens`, `outputTokens`, `model`, `reasoningEffort`)
  is optional and is recorded on the task with zero cost. Studix pays nothing for
  host work. A `model` written as `provider/modelId` must be in the workspace
  catalog, and a `reasoningEffort` other than `off` needs a model with reasoning
  support; either mismatch is `VALIDATION`.
- `agent: {runtime?, model?, reasoningEffort?}` is the same declaration in the
  shape of `studix_create_video`'s `agent`: the host says which runtime, model
  and effort it used. It is checked against the catalog like `usage` and merged
  into it.
- `studix_list_agent_runtimes` (no arguments, `project:read`) returns, per
  runtime, the connections you may use (`id`, `provider`, `label`, `owner`,
  `authMethod`, `status`) and the models each one runs (`id`, `reasoning`).
  Secrets and key hints are never in it.
- Reading needs `project:read`; submitting needs `project:write`. Other
  workspaces' tasks are `NOT_FOUND`.
- When a stage reaches a limit (any cap in the harness, the time limit in host
  mode), the job does not fail. It parks in `waiting_approval` with an
  `agent.overrun` approval. A person approving it in the dashboard grants one
  more run with every limit doubled; rejecting it fails the job with
  `FORBIDDEN`.

### Imported GitHub skills

Agent Skills (`SKILL.md`) imported from public GitHub repositories or uploaded
as zip archives, at `workspace` (default) or `platform` scope. Every file is
stored and each version has a risk report; content stays untrusted. Guide:
[EXTERNAL_SKILLS.md](EXTERNAL_SKILLS.md).

| Tool                    | Returns                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `studix_skill_discover` | Pinned source.commitSha and every SKILL.md found.               |
| `studix_skill_import`   | Per skill: outcome, ids, license, risk, nameCollisions.         |
| `studix_skill_upload`   | An upload URL (action: "url") or the stored item and its risk.  |
| `studix_skill_list`     | Skills with scope, activeRiskLevel and manageable.              |
| `studix_skill_get`      | Metadata, license, risk report, files and a bounded text slice. |
| `studix_skill_update`   | The updated skill and, for check/import, the upstream result.   |
| `studix_skill_disable`  | The disabled skill, or `turnedOffHere` for a platform skill.    |
| `studix_skill_delete`   | deleted and filesRemoved. Cannot be undone.                     |

Arguments:

- `discover`: `repositoryUrl`, `ref?`, `path?`.
- `import`: as `discover`, plus `skillPaths?`, `expectedCommit?`,
  `idempotencyKey?`, `activate?`, `scope?`.
- `upload`: `action?` (`upload` or `url`), `archiveBase64?` or `uploadId?`,
  `fileName?`, `activate?`, `idempotencyKey?`, `scope?`, `confirmHighRisk?`.
- `list`: `limit?`, `cursor?`, `status?`, `q?`, `owner?`, `repo?`, `scope?`
  (`visible` by default, `workspace` or `platform`).
- `get`: `skillId`, `versionId?`, `path?`, `offset?`, `limit?`,
  `includeVersions?`. A binary file returns its size only.
- `update`: `skillId`, `action` (`check`, `import`, `activate` with
  `versionId`, or `enable`), `confirmHighRisk?`. It never changes the active
  version on its own.
- `disable` and `delete`: `skillId`.

Rules:

- `discover` and `import` read from GitHub (`openWorldHint`); nothing from a
  repository is executed. Only `github.com` repository URLs are accepted, other
  hosts, IPs and schemes are `VALIDATION`.
- Reading needs `skill:read`; `discover`, `import`, `upload`, `update`,
  `disable` and `delete` need `skill:write`, and platform skills need a platform
  operator. Other workspaces' skills are `NOT_FOUND`; a disabled skill is
  `CONFLICT` on `get` for readers who cannot enable it.
- A high-risk version starts disabled. `enable` or `activate` of a high-risk
  version without `confirmHighRisk` is `CONFLICT`; with it from an API key or a
  role below admin it is `FORBIDDEN`. Confirmations are audited.
- `upload` with `uploadId`: first PUT the zip to `uploadUrl` within 15 minutes
  (`Content-Type: application/zip`, at most 30 MiB). Archive problems (no
  `SKILL.md`, unsafe paths, zip bombs, too large) are `VALIDATION`. The dashboard
  uses the same service through `/api/skills` (list, discover, import, raw-zip
  `upload`, get, update, disable, delete).
- Errors: `NOT_FOUND` (repository not public, path or skill missing),
  `CONFLICT` (`expectedCommit` mismatch), `RATE_LIMITED` (with the reset time),
  `UNAVAILABLE` (no object storage).
- `studix_inspect` returns `importedSkills` (`shown` names) when the caller may read them.
- A full commit SHA `ref` must be on the default branch. `update` `check` compares
  with the active version only and may report `unknown`; reading a non-active
  `versionId` needs `skill:write`. `list`/`discover` results carry `trust`.

### Media exec (ffmpeg / ffprobe)

`studix_media_exec` runs `ffmpeg` or `ffprobe` with raw arguments as an async
worker job in an offline sandbox container. It needs the `media:exec` permission
(editor role and up; OAuth scope `studix:write`) and `STUDIX_SANDBOX=docker` on
the worker. Threat model: [SECURITY.md](SECURITY.md#media-exec).

`media:exec` needs the Docker backend. On a worker with `STUDIX_SANDBOX=sidecar` (TOSE,
[ADR-0025](decisions/0025-sidecar-skill-runner.md)) the sandbox is not offline, so `studix_media_exec` is
unavailable and returns an error that names the backend; use `studix_composition_run` instead, which works on both
backends. The sidecar backend also runs agent tools and compositions only for workspaces on the worker's
allowlist (which the operator may set to every workspace); any other workspace gets `FORBIDDEN`.

| Argument         | Notes                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `tool`           | `ffmpeg` or `ffprobe`.                                                                           |
| `args`           | argv, no shell (max 500, 8000 chars each). Files only as `{in:<name>}` and `{out:<name>}`.       |
| `inputs`         | `name -> {assetId}`, `{url}` (public https, SSRF-guarded) or `{base64}` (2 MB each, 4 MB total). |
| `outputs`        | `[{name, contentType?}]`; every output must be referenced. ffmpeg needs at least one.            |
| `timeoutSeconds` | Default 300, max 1800.                                                                           |
| `budgetCents`    | Job budget; compute time is metered per started minute.                                          |
| `idempotencyKey` | The same key returns the earlier job (`replayed: true`).                                         |

Names match `[A-Za-z0-9][A-Za-z0-9_.-]*`. Absolute, Windows, home and `..`
paths, URLs, protocol prefixes (`concat:`, `file:`, `subfile,`) and the options
`-protocol_whitelist`, `-protocol_blacklist` and `-safe` are `VALIDATION`.
Studix adds `-hide_banner -nostdin` and `-protocol_whitelist file,pipe` itself.

The tool returns `{jobId, status, replayed}`; poll `studix_get_job`. A finished
job's `result` holds `exitCode`, `killed`, `durationMs`, truncated `stdout` /
`stderr`, `json` (parsed ffprobe output when stdout is JSON) and `outputs` with
`assetId`, `name`, `contentType`, `bytes`, `sha256` and a signed `url`. A
non-zero exit fails the job with `VALIDATION` and the stderr tail in
`error.message` (`details.exitCode`, `details.stderrTail`). A tool the sandbox
killed (`details.killed: true`, `details.exitCode: 124`) fails instead: with
`TIMEOUT` (not retryable; raise `timeoutSeconds` or lighten the work) when it ran
for its whole `timeoutSeconds`, or with `UNAVAILABLE` (retryable; run it again)
when it was killed earlier because the sandbox stopped. The time is still billed. Jobs show on the dashboard Jobs page as kind `media.exec`.

```json
{
  "tool": "ffmpeg",
  "args": ["-i", "{in:a.mp4}", "-vf", "scale=iw/2:-2", "-c:a", "copy", "{out:small.mp4}"],
  "inputs": { "a.mp4": { "assetId": "ast_..." } },
  "outputs": [{ "name": "small.mp4" }]
}
```

```json
{
  "tool": "ffmpeg",
  "args": [
    "-i",
    "{in:one.mp4}",
    "-i",
    "{in:two.mp4}",
    "-filter_complex",
    "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]",
    "-map",
    "[v]",
    "-map",
    "[a]",
    "{out:joined.mp4}"
  ],
  "inputs": { "one.mp4": { "assetId": "ast_1" }, "two.mp4": { "url": "https://example.com/two.mp4" } },
  "outputs": [{ "name": "joined.mp4" }]
}
```

```json
{
  "tool": "ffmpeg",
  "args": ["-i", "{in:v.mp4}", "-vn", "-c:a", "libmp3lame", "{out:audio.mp3}"],
  "inputs": { "v.mp4": { "assetId": "ast_..." } },
  "outputs": [{ "name": "audio.mp3" }]
}
```

```json
{
  "tool": "ffmpeg",
  "args": ["-ss", "0.5", "-i", "{in:v.mp4}", "-frames:v", "1", "{out:thumb.png}"],
  "inputs": { "v.mp4": { "assetId": "ast_..." } },
  "outputs": [{ "name": "thumb.png" }]
}
```

```json
{
  "tool": "ffprobe",
  "args": ["-v", "error", "-of", "json", "-show_format", "-show_streams", "{in:v.mp4}"],
  "inputs": { "v.mp4": { "assetId": "ast_..." } }
}
```

### Composition workspaces (client-authored video)

The client AI can author the video itself instead of delegating to a job
([ADR-0024](decisions/0024-client-authoring-and-agent-roles.md)). A composition is a file tree in
object storage; Studix checks only the outputs a run asks it to check.

| Tool                               | Does                                                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `studix_composition_write`         | Omit `compositionId` to create one. `files: [{path, text} or {path, base64, contentType?}]` (8 MB each, 50 per call), `delete: [paths]`. Returns the file list. |
| `studix_composition_run`           | Async job `composition.run`: `command` runs under `sh` in the composition root inside the skill sandbox. Returns `{jobId}`; poll `studix_get_job`.              |
| `studix_composition_attach_render` | Register a rendered MP4 as a playable render of a project (see below).                                                                                          |
| `studix_composition_read`          | Without `path`: the file list. With `path`: a signed URL, text inline, and png/jpeg/webp/gif up to 1.5 MB as an image block (frames, contact sheets).           |

`studix_composition_attach_render` takes `{compositionId, path, projectId, preset?}`. It copies the MP4 under
`renders/` and records it as the project's render with an asset (kind `render`) and version, so
`studix_get_project` and the dashboard play it (the run job itself has no project, so `studix_get_job`
does not show it). The project needs a current version, and repeating the call for the same file, preset
and version returns the same render (`replayed: true`).

The run sandbox has network, Node, Python, ffmpeg, Chromium, the HyperFrames and Remotion CLIs,
`multix generate` with the workspace's media keys (images, TTS, BGM, SFX via ElevenLabs and others)
and the enabled skills under `/skills`. `timeoutSeconds` defaults to 900
(max 3600); compute is billed per started minute against `budgetCents`. It needs `media:exec`
(write needs `project:write`) and `STUDIX_SANDBOX=docker` on the worker.

#### What persists between runs

Every run is an ephemeral sandbox. Nothing survives it except the composition's stored files, so a
second run sees exactly the file list `studix_composition_read` returns, never the first run's
container, home directory, global installs or `node_modules`.

- **Copied in:** every stored file, at the same relative path under the working directory
  (the composition root).
- **Stored back:** each regular file under the root whose modification time is newer than the start
  of the command, listed in the job result's `changed[]` (`path`, `bytes`, `sha256`,
  `contentType`). A file the command only read is not stored again. Files that keep their original
  timestamps (`tar -x`, `unzip`, `cp -p`, `rsync -a`) and symlinks are not stored; `touch` extracted
  files if they must persist.
- **Skipped silently:** anything under `node_modules`, `.git`, `.cache`, `.npm`, `__pycache__` or
  `.venv`; files of 1 GiB or more; paths outside the root (`~`, `/tmp`); and any path that is not a
  valid composition path: at most 240 characters, and every segment starts with an ASCII letter,
  digit or `_` and then uses only ASCII letters, digits and `_ . @ + -` (so hidden names, spaces and
  accented names are dropped without an error).
- **Count limits:** a run stores at most 200 files (it keeps 200, in no guaranteed order, and the log
  says how many it skipped). A run that would take the composition over 400 files fails with
  `VALIDATION` and does not add its files to the file list.
- **Deletes do not persist:** removing a file in a run leaves its stored copy, and it is back in the
  next run. Delete stored files with `studix_composition_write` and `delete: [paths]`.
- **Persist a generated project** by creating it inside the root, for example
  `npx hyperframes init my-video` (the directory lands at `my-video/` and is stored back), or move it
  there before the command ends. A project initialised in `~` or `/tmp` is gone when the run ends. Its
  dependencies are not kept: run the install again at the start of the next command
  (`cd my-video && npm install && npx hyperframes render ...`).
- **Limits on writes** through `studix_composition_write` are separate: 8 MB per file, 50 per call.
  Larger media must be generated or downloaded inside a run.

`check: {path, width?, height?, durationMs?, durationToleranceMs?, audio?, loudnessLufs?, frames?}` probes a file after
an exit 0: a miss (or a non-zero exit) fails the job with `VALIDATION` and `details` holding the
exit code, the tail of the combined log (`logTail`), changed files and the check result. The files it wrote are kept either way.
A command killed before it exits (`exitCode: null`) stores none of its files, since they may be truncated. It fails with
`TIMEOUT` when it ran for the whole `timeoutSeconds` (not retryable as is: raise `timeoutSeconds`, render at a lower
resolution or fps, or split the render), otherwise with `UNAVAILABLE` (the sandbox lost the session; run it again).

`audio: true` requires an audible audio track (`loudnessLufs` implies it). `frames: {samples?, safeMarginPct?,
motion?, vietnamese?}` also looks at the picture: it decodes `samples` frames (2-12, default 5) at evenly spaced
times and fails on a black or a blank (single flat colour) frame. The rest is opt-in, because a deliberate hold or a
full-bleed photo is legitimate: `safeMarginPct` flags content inside that outer band of the frame (it assumes a
background that is plain at the edge), `motion` flags consecutive samples that look identical, and `vietnamese`
requires a font with Vietnamese coverage in the render sandbox (glyphs themselves are not read from pixels). The
check always stores a contact sheet at `qa/<file>-contact-sheet.jpg` and returns its path as `check.contactSheet`;
read it with `studix_composition_read` to see the frames.

```json
{
  "compositionId": "cmp_...",
  "command": "npx hyperframes render index.html -o out/video.mp4 && ffmpeg -i out/video.mp4 -vf fps=1/2,scale=480:-1,tile=4x2 out/sheet.png",
  "check": {
    "path": "out/video.mp4",
    "width": 1920,
    "height": 1080,
    "durationMs": 10000,
    "loudnessLufs": -16
  }
}
```

## P0 meta-tools (MCP-in-MCP)

Third-party tools registered in the workspace are reached only through these
three tools; they never appear in `tools/list`.

| Tool                  | Arguments                    | Returns                                                                                               |
| --------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `studix_tool_search`  | `query`, `server?`, `limit?` | Permitted tools as qualified names (`server.tool`) with compact summaries. Denied tools are absent.   |
| `studix_tool_inspect` | `tool`                       | The tool's actual input schema, annotations, permission and availability.                             |
| `studix_tool_execute` | `tool`, `arguments`          | Routed result or typed error, `traceId`, `next`. Large results are truncated or stored as asset refs. |

Every execute is re-authorized at call time; a grant revoked after search
returns `FORBIDDEN`. See [SECURITY.md](SECURITY.md#mcp-in-mcp-connectors).

## Listing jobs (dashboard API only)

`GET /api/jobs` returns `{ items, nextCursor? }` for the caller's workspace, newest created first.
It needs `project:read`. Every param is optional and checked against an allowlist; an unknown param,
sort field or enum value fails with `VALIDATION`.

| Param                                                  | Meaning                                                                                                                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sort`, `order`                                        | `createdAt` (default), `updatedAt`, `status`, `kind`, `stage`, `projectId`, `progress`, `spentCents`, `agent` (runtime) or `model`; `asc` or `desc` (default). |
| `status`, `kind`, `stage`                              | Comma-separated values; a job matches any of them.                                                                                                             |
| `agent`, `model`                                       | Comma-separated agent runtimes (`claude`, `codex`, `pi`, `host`, `planner`, `none`); case-insensitive substring of the agent model id.                         |
| `id`, `project`                                        | Case-insensitive substring of the job id or project id. `projectId` matches one project exactly.                                                               |
| `createdFrom`, `createdTo`, `updatedFrom`, `updatedTo` | ISO 8601 instants with an offset, inclusive.                                                                                                                   |
| `progressMin`, `progressMax`                           | Progress bounds from 0 to 1, inclusive.                                                                                                                        |
| `spentMin`, `spentMax`                                 | Spend bounds in whole cents, inclusive.                                                                                                                        |
| `limit`, `cursor`                                      | Page size (1-100, default 20) and the `nextCursor` of the previous page.                                                                                       |

Each item, and the job returned by `studix_get_job`, carries `agent: { runtime, provider?, model?, reasoningEffort? }`, read from the job's payload.
`host` means the MCP client's own agent (`agentMode: "host"`), `planner` the legacy fixed Claude planner, and `none` a job with no Studix agent, such as one driven over MCP by an external tool.
It never carries a connection id or a secret.

Pages are keyset on (sort column, id), so they neither skip nor repeat a job while the list is paged.
A cursor is only valid with the sort it came from; reusing it under another sort fails with `VALIDATION`.

## Live agent events (dashboard API only)

The dashboard root (`#/`) is a chat: each message creates a `skill-agent` job (`POST /api/projects` with `workflowTemplate: "skill-agent"` and `agent`), and the page follows that job's agent while it works.

- `GET /api/agent-runtimes` returns the same data as `studix_list_agent_runtimes`: each runtime (`claude`, `codex`, `pi`) with the caller's usable connections and their models. A runtime with no connection cannot run.
- `GET /api/jobs/:jobId/events` is a Server-Sent Events stream that needs the `project:read` permission.
  - `event: agent` carries one normalized agent event: `message` and `reasoning` deltas, `tool_start` (`id`, `name`, `args`), `tool_end` (`id`, `name`, `ok`, short `result`), `usage` (turns, tokens, `costCents`), `status` (`running`, `succeeded`, `failed`, with runtime and model) and `artifact` (a file name in `/work/out`).
  - `event: job` carries the job's status, stage, `spentCents` and `budgetCents` whenever they change.
  - `event: end` is sent once the job has finished and every event has been sent.
  - Each agent event has an SSE `id`. Pass `?after=<id>` or `Last-Event-ID` to replay only what came later, so a reload resumes where it stopped.

The worker stores these events with the job as `agent.event` activity rows. They are redacted before they are stored, and large tool arguments keep only a preview, so no secret is streamed. Claude Code and Codex report whole blocks rather than token deltas, so their text arrives a block at a time. Pi streams tokens.

## Platform settings (dashboard API only)

Storage and media settings are not MCP tools: agents and API keys cannot read
or change them. They are dashboard session routes for the `operator` role
(anything else gets `403 FORBIDDEN`; no session gets `401`). Responses are
`Cache-Control: no-store` and never carry a key value.

- `GET /api/platform/storage-media`: Redacted R2 status, media executable status, vendor key metadata.
- `POST /api/platform/storage/test` (body: `{}`): Put/get/head/delete result with a diagnosis and a suggested action.
- `PUT /api/platform/storage/key` (body: key pair): Probe result; the pair is stored only if the probe passes.
- `DELETE /api/platform/storage/key`: `204`; `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` apply again.
- `POST /api/platform/media/test` (body: `{}`): Safe `multix check` result; `paidCalls` is always `false`.
- `POST /api/platform/media-keys/:name/test` (body: `{}`): Free vendor lookup; `verdict` is `available`, `invalid` or `unverified`.
- `PUT /api/platform/media-keys/:name` (body: `{ value }`): Credential metadata with a last-four hint. Name must be allowlisted.
- `DELETE /api/platform/media-keys/:name`: Metadata after removal; the environment value, if any, applies.

Storage profiles (same rules; the id is `env` or `stp_…`):

- `GET /api/platform/storage/profiles`: The `env` profile, then stored profiles
  with hints, reference counts and the last test.
- `POST /api/platform/storage/profiles` (body: `{ name, providerType, endpoint?, bucket, region, forcePathStyle?, keyPrefix?, accessKeyId, secretAccessKey }`):
  `201` with the profile. The probe runs first: a `VALIDATION` error for a
  refused endpoint, or the probe's diagnosis when it fails. Nothing is stored
  on failure.
- `PUT /api/platform/storage/profiles/:id` (same body, key pair optional but
  both or neither): Re-probes, with the stored pair when no pair is given.
- `POST /api/platform/storage/profiles/:id/activate` (body: `{}`): New objects
  go to this profile; `env` reverts to `S3_*`.
- `POST /api/platform/storage/profiles/:id/test` (body: `{}`): Probe result,
  recorded as the last test.
- `DELETE /api/platform/storage/profiles/:id`: `204`. `CONFLICT` when the
  profile is active or still referenced by assets.

Workspace owners and admins have the same routes under
`/api/workspace-storage/storage/profiles` for their workspace's own profiles
([ADR-0023](decisions/0023-workspace-storage-profiles.md)). There `env` is
**Platform default** (`providerType: "platform"`): activating it makes the
workspace follow the platform choice again, and it cannot be tested.

### Workspace media keys (BYOK)

A workspace may bring its own key for every key Multix reads: one `vendor` per
provider (`sume`, `atlas`, `gemini`, `openai`, `fal`, ...), plus one per further
required key (`cloudflare-api-token`). The list is generated from Multix
(`multix catalog providers`). These are dashboard session
routes too, `Cache-Control: no-store`, and never return the key. Any member
may read; only workspace admins (`member:manage`) may write.

| Route                                         | Body         | Returns                                                                                                                          |
| --------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/providers/media-keys`               | none         | `{ storage, canManage, keys: [{ vendor, name?, keyName, testable, source, keyHint? }] }`                                         |
| `PUT /api/providers/media-keys/:vendor`       | `{ apiKey }` | The vendor's view; stores or rotates the workspace key.                                                                          |
| `DELETE /api/providers/media-keys/:vendor`    | none         | `source: "platform"`: media calls use the platform key again.                                                                    |
| `POST /api/providers/media-keys/:vendor/test` | `{}`         | `{ vendor, at, verdict, httpStatus?, note? }`: a free account lookup at the vendor (admins only); `unverified` when it has none. |

### Provider connections: rename and ChatGPT sign-in

Dashboard session routes, `Cache-Control: no-store`. They never return a key or
a token.

| Route                                           | Body            | Returns                                                                                                  |
| ----------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------- |
| `PATCH /api/providers/connections/:id`          | `{ label }`     | The connection's view with the trimmed label (1 to 80 characters). Audited with the old and new label.   |
| `POST /api/providers/connections/chatgpt/start` | `{ owner? }`    | `{ flowToken, userCode, verificationUrl, intervalSeconds, expiresAt }` of a ChatGPT device-code sign-in. |
| `POST /api/providers/connections/chatgpt/poll`  | `{ flowToken }` | `{ status: "pending", intervalSeconds }` or `{ status: "connected", connection }`.                       |
- Renaming needs the same role as managing the connection (`member:manage` for
  a workspace connection, the owner for a personal one); someone else's personal
  connection is `NOT_FOUND`. The secret and version do not change.
- The sign-in creates (or rotates) an `openai` connection with `authMethod:
  "oauth_subscription"`, `billing: "subscription"` and `runtimes: ["codex"]`.
  A workspace-owned login needs `member:manage`; a personal one `project:write`.
  Only the user who started a flow can poll it, and a flow token expires after
  15 minutes. Without a ChatGPT client the start route is `503 UNAVAILABLE`.

## Roadmap tools

Not implemented; do not depend on them. Capabilities are added to the contract
before new tools are created.

| Tool                 | Intent                                                    | Phase        |
| -------------------- | --------------------------------------------------------- | ------------ |
| `studix_edit_video`  | Revise a version from free-form feedback without a patch  | P1           |
| `studix_list_assets` | List workspace assets                                     | P1           |
| `studix_search`      | Search projects, scenes, assets                           | P1-P2        |
| `studix_publish`     | Publish an approved final; fails closed without approval  | P2           |
| `studix_code`        | Sandboxed Code Mode over the gateway, feature-flagged off | P2, optional |

## Connecting a client

You need the MCP URL. Clients with MCP authorization (Claude and ChatGPT
connectors, Claude Code's `/mcp` login) need nothing else: they open the
dashboard sign-in and ask for approval. Header-based clients and automation use
a workspace API key (`stx_...`) from the dashboard. Treat the key as a
password: do not paste it into a chat message.

### Claude Code

Sign in with OAuth (no key):

```bash
claude mcp add --transport http studix https://app.studix.digitop.ai/mcp
```

Then run `/mcp` in Claude Code, pick `studix` and choose **Authenticate**. The
browser opens the Studix sign-in; sign in, pick the workspace if you belong to
several, and approve the scopes. Claude Code stores and refreshes the token.
Revoke it from the dashboard's Connected apps page; the next call answers `401`
and `/mcp` offers to sign in again.

Or use a workspace API key:

```bash
claude mcp add --transport http studix https://app.studix.digitop.ai/mcp \
  --header "Authorization: Bearer stx_..."
```

Then run `/mcp` in Claude Code to confirm `studix` is connected. Verified
locally with the MCP TypeScript SDK client (registration, PKCE, consent,
`tools/list`, `studix_inspect`); the interactive Claude Code `/mcp` login has not
yet been smoke-tested end to end.

### Claude Desktop and claude.ai custom connectors

Add the MCP URL in Claude's connector settings with no key: Claude discovers
the authorization server, opens the Studix sign-in and consent page, and stores
the token. Hosted connector sign-in has not yet been smoke-tested against the
live clients (see the verification status in ADR-0006). If it does not connect,
use one of:

- **Claude Desktop local config** through a header-capable bridge such as
  `mcp-remote`, in `claude_desktop_config.json`:

  ```json
  {
    "mcpServers": {
      "studix": {
        "command": "npx",
        "args": ["mcp-remote", "https://app.studix.digitop.ai/mcp",
                 "--header", "Authorization:${STUDIX_API_KEY}"],
        "env": { "STUDIX_API_KEY": "Bearer stx_..." }
      }
    }
  }
  ```

- **Claude Code** as above.

### ChatGPT

ChatGPT connectors (developer mode) use OAuth: add the MCP URL and choose
OAuth. Programmatic use also works through the OpenAI Responses API remote MCP
tool, which accepts request headers:

```json
{
  "type": "mcp",
  "server_label": "studix",
  "server_url": "https://app.studix.digitop.ai/mcp",
  "headers": { "Authorization": "Bearer stx_..." },
  "require_approval": "never"
}
```

Verify the current field names against OpenAI's documentation before relying on
this snippet; it is not covered by Studix CI.

### TypeScript SDK

```ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL("https://app.studix.digitop.ai/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.STUDIX_API_KEY}` } },
  }),
);
const job = await client.callTool({
  name: "studix_create_video",
  arguments: { prompt: "Video giới thiệu thương hiệu cà phê Sương Mai, 15 giây, dọc 9:16" },
});
```

The repo's TS client tests (`apps/mcp-server/test/*.integration.test.ts`) are
the executable reference.

### Python SDK

```python
import asyncio, os
from mcp import ClientSession
from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client

async def main():
    headers = {"Authorization": f"Bearer {os.environ['STUDIX_API_KEY']}"}
    async with create_mcp_http_client(headers=headers) as http:
        async with streamable_http_client("https://app.studix.digitop.ai/mcp", http_client=http) as streams:
            async with ClientSession(streams[0], streams[1]) as s:
                await s.initialize()
                print(await s.call_tool("studix_inspect", {}))

asyncio.run(main())
```

Verified with `mcp==2.3.0`
(`apps/mcp-server/test/python/python-sdk-smoke-client.py`, run by the
integration suite through `uv`).

### Example prompt

> Dùng Studix tạo một video giới thiệu thương hiệu cà phê "Sương Mai", dài 15
> giây, khung dọc 9:16, tông màu nâu kem, có logo ở cảnh cuối và câu slogan
> "Đánh thức buổi sáng". Theo dõi tiến độ và gửi tôi link xem trước khi xong.

The client should call `studix_inspect`, then `studix_create_video`, then poll
`studix_get_job` until a preview URL appears.

### Troubleshooting

| Symptom                         | Likely cause                                        | Fix                                                                                    |
| ------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `UNAUTHENTICATED` on every call | Missing `Bearer ` prefix, wrong key, or key revoked | Recreate the key in the dashboard; check the header value                              |
| `FORBIDDEN`                     | Key scope lacks the tool, or connector tool denied  | Adjust key scope or connector grant in the dashboard                                   |
| `401` with `invalid_token`      | OAuth token expired, revoked, or for another URL    | Reconnect the app; check the Connected apps page and that the URL matches the resource |
| `403` `insufficient_scope`      | OAuth grant lacks `studix:read`                     | Reconnect and approve the requested scopes                                             |
| Client shows no tools           | Wrong URL (missing `/mcp`) or blocked by host check | Use the exact URL from the dashboard                                                   |
| Connection drops on long calls  | Proxy buffering or timeout on the client side       | Studix tools return fast; poll `studix_get_job` instead of waiting                     |
| `BUDGET_EXCEEDED`               | Workspace or job budget                             | Lower scope (duration, formats) or raise the budget                                    |
| `APPROVAL_REQUIRED`             | Publish or high-cost step                           | Approve in the dashboard, then retry                                                   |
| Job stuck in one stage          | Worker down or lease recovery pending               | Check `traceId` in the dashboard; operators see [DEPLOYMENT.md](DEPLOYMENT.md#runbook) |
| Search finds no connector tool  | Connector disabled, not refreshed, or tool denied   | Test/refresh the connector in the dashboard                                            |
