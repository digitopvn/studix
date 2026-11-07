# Dashboard redesign: Option C (Darkroom)

Status: draft, waiting for DoD sign-off. The user chose Option C on 2026-11-07. Design source:
[option-c.html](option-c.html). Worktree: `D:\worktrees\studix\atlas-journal-cas-3329ce` (shared).

## Outcome

The dashboard becomes the Darkroom prototype: three places (Create, Projects, Settings), an Activity
sheet behind the tally pill and a Connect agent dialog. A project shows its takes, the storyboard
developing shot by shot, the agent's tool calls and a sticky "New take" box. Nothing the dashboard
can do today is lost.

## Non-goals

- No video editor and no new dashboard widgets. The timeline only shows shots and seeks.
- No API, MCP or database change, except where a phase below says so and syncs the docs.
- No TanStack migration here. Plan section C of
  [the skill runtime plan](../261107-1127-skill-runtime-store-tanstack/plan.md) runs afterwards, on
  the smaller route set.

## Data the redesign uses (already in the API)

- Takes are `ProjectReview.versions`. Each take lists the jobs (runs) that built it, with runtime,
  model, effort, spend and stages from the job API.
- The storyboard is `ProjectReview.storyboard.scenes[].shots[]`, with `startMs`, `endMs` and
  `render` (`rendered | outdated | not_rendered`). A shot that is `not_rendered` shows the
  "developing" blur.
- Shot frames and project posters come from the latest render, seeked with a media fragment
  (`#t=<seconds>`). No thumbnail API is needed.
- Revise uses `api.sendFeedback` (with `shotId` for a shot-only revise). Retry and stop use
  `api.retryJob` and `api.cancelJob`. The tool-call stream reuses `useAgentRun` and `BlockView`
  from `agent-chat-page.tsx`.

## Route map (old URLs keep working)

| Old route                                       | New place                                            |
| ----------------------------------------------- | ---------------------------------------------------- |
| `/`, `/chat/:id`                                | Create (`/`), thread at `/chat/:id`                  |
| `/create`                                       | Create, with its options as brief chips              |
| `/projects`                                     | Projects grid                                        |
| `/projects/:id`, `/projects/:id/review`         | Project view (`/projects/:id`, `?take=n`)            |
| `/jobs`                                         | Activity sheet, "All activity" opens `/activity`     |
| `/jobs/:id`                                     | Its project take, or a standalone run view           |
| `/api-keys`, `/connectors`, `/connected-apps`   | `/settings/agents`, and the Connect agent dialog     |
| `/providers`                                    | `/settings/models`                                   |
| `/skills`, `/skills/:id`                        | `/settings/skills`, `/settings/skills/:id`           |
| `/storage-media`                                | `/settings/media` and `/settings/storage` (managers) |
| `/account`                                      | `/settings/account`                                  |

## Phases

Phase 1 runs first and alone. Phases 2 to 5 then run in parallel sessions in disjoint files.
Phase 6 runs last. Each phase puts its CSS in its own file imported by its page, so only phase 1
and phase 6 touch `styles.css`.

### 1. Tokens and shell

- Files: `src/styles.css`, `src/app.tsx`, `src/ui.tsx`, `index.html`, new `src/shell/*`
  (`top-bar.tsx`, `activity-pill.tsx`, `theme.ts`).
- Darkroom tokens from `option-c.html` (colour, type, spacing, radius, motion). Dark by default,
  light by toggle, stored in localStorage behind try/catch.
- Map the old token names (`--muted`, `--border`, `--accent` and others) to the new ones, so pages
  that are not yet redesigned still look right.
- Self-host Be Vietnam Pro (400 to 700) and JetBrains Mono with `@fontsource` packages. Do not use
  a Google Fonts link.
- Top bar: brand, Create, Projects, Settings, the tally pill (count of running jobs), Connect agent,
  the theme toggle and an avatar menu with the workspace switcher, account and sign out. At 720px
  and below, the nav becomes a bottom tab bar.
- Redirect every old route in the table above.

### 2. Create

- Files: `pages/agent-chat-page.tsx`, `pages/create-video-page.tsx`, new `pages/create.css`.
- Owner today: the agentic-chat-ui session. Start after it has committed.
- "Make a video." composer with attachments. Format, length, voice and look are chips that hold the
  Advanced create options. Show the runtime label (runtime, model, effort) and the runtime picker.
- Add starter prompts and a Recent filmstrip. The thread view keeps section E behaviour: streaming,
  tool-call cards, stop, inline player and follow-up revise.

### 3. Project view

- Files: `pages/project-detail-page.tsx`, `pages/project-review-page.tsx`,
  `pages/job-detail-page.tsx`, new `pages/project-view/*`.
- Player with a timeline split by shot (click to seek), takes tabs and the storyboard.
- The agent log with tool calls that expand, the sticky revise box (whole take, or the selected
  shot) and "New take".
- A side column holding:
  - the take summary: runtime, model, effort, spend and stages, from the job detail page;
  - approvals and comments, from the review page;
  - "Continue in your own agent".
- The job detail page becomes the run panel of a take. A job without a project keeps a standalone
  run view.

### 4. Projects and Activity

- Files: `pages/projects-page.tsx`, `pages/jobs-page.tsx`, `pages/job-list-filters.ts`, new
  `shell/activity-sheet.tsx`, new `pages/projects.css`.
- Owner today: the jobs-sort-filter session. Start after it has committed.
- Projects: a grid of poster cards, filters for All, Running, Review and Failed, a search field, a
  "+ New video" tile and an empty state.
- The Activity sheet lists running, failed, review and done runs.
  - A failed run says what broke and offers inline fixes: Add key, Retry and Copy for agent.
  - The full filtered and sorted list from the jobs page moves to `/activity`.

### 5. Settings and Connect agent

- Files: new `pages/settings-page.tsx`, new `shell/connect-dialog.tsx`, and the existing settings
  pages and sections. Those keep their logic and become the bodies of the sections.
- Owner today: the multix-model-picker session (`workspace-multix-section.tsx`,
  `multix-model-*`). Start after it has committed.
- One page with a subnav:
  - Agents: API keys, Connectors, Connected apps and Claude features.
  - Models: Providers, provider models and Multix.
  - Media: media keys.
  - Skills.
  - Storage: managers only.
  - Account.
- Connect agent dialog: tabs for Claude Code, Claude.ai, ChatGPT, Cursor, and API & CLI. Each tab
  shows copy blocks built from `me.mcpUrl`, plus a suggested first prompt.

### 5b. Review and feedback toolkit

- Files: new `pages/project-view/review-*`, the feedback contract in `packages/core` (studio types and
  service), `apps/mcp-server` routes and the `studix_feedback` tool, and `docs/MCP_API.md`.
- A review mode on the player. Pause, then annotate the frame:
  - a box region, a pin, an arrow, and a freehand pen sketch;
  - a time point or a range, set from the playhead or by dragging on the timeline;
  - a note, an intent (change, remove, keep, add) and a priority;
  - a frame snapshot: the frame plus the drawing, captured from the video to a PNG;
  - references: an uploaded image or video, or a URL, with a note on what to take from each.
- Notes collect into a review batch. "Send to agent" sends one structured feedback packet. Each note
  carries:
  - its target (shot, scene or time range), a normalized region `{x,y,w,h}` in the range 0 to 1,
    and the drawing as SVG paths;
  - the snapshot asset id, the references, the intent, the priority and the text;
  - the base version id.
- The agent gets the packet as text and images, so it sees exactly where and what to change.
  The same packet comes from `studix_feedback` (`notes[]`) and from "Copy for agent", which keeps the
  MCP, API and UI in sync.

### 6. Copy for agent and cleanup

- Files: new `src/copy-for-agent.tsx`, `src/styles.css`, docs.
- One `CopyForAgent` component copies the exact MCP call: `studix_get_project`, `studix_get_job`,
  `studix_feedback` or `studix_retry_job`, with real ids. Use it on projects, takes and failed runs.
- Remove the old token aliases and dead CSS.
- Update the dashboard docs or user guide wherever they describe navigation.

## Definition of done

1. The nav is Create, Projects and Settings, plus the tally pill and Connect agent. Every old URL
   in the route map lands on its new place.
2. Tokens, fonts, dark default and the light theme match `option-c.html`. The theme toggle
   persists.
3. Every feature reachable today is still reachable. Check this against the route map.
4. The project view shows takes, the storyboard with developing shots, the tool-call log, a
   shot-only revise and the take summary with spend. The job detail data is not lost.
5. "Copy for agent" exists on a project, a take and a failed run, and copies a valid MCP call.
6. At 375px there is no horizontal scroll and the bottom tab bar works. Keyboard focus is visible,
   touch targets are at least 44px, and `prefers-reduced-motion` disables the blur and the sweep.
7. `pnpm check` and `pnpm build` pass.
8. Click through in the browser: every screen in dark and light, on desktop and at 375px, with
   screenshots attached to the PR.

## Risks

- Other sessions edit dashboard files now. Each phase starts only after that file's owner has
  committed, and sessions announce restarts of the dev API (8797).
- Seeking a render for shot frames costs a video load per card. Use `preload="metadata"`, lazy
  loading, and one shared `<video>` element per project view. If that is still too slow, add a
  thumbnail field to the API in a follow-up and sync `MCP_API.md`.
- Rollback: each phase is its own commit or PR. Revert the phase. Phase 1's token aliases keep the
  old pages working.
