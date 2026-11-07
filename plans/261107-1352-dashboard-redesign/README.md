# Dashboard redesign directions

Design only. No dashboard code changes until the user picks one. Open the HTML files in a browser:
each one is clickable, responsive, and switches between light and dark.

Round 1 (`option-a.html`, `option-b.html`) was rejected. Round 2 is `option-c.html` and
`option-d.html`.

## Shared decisions

- The 11 nav items collapse to three places: create, projects, settings. Activity and Connect agent
  are one click away.
- Projects and Jobs merge. A job is a take (version) of a project, and its stages, runtime, model,
  effort and cost show on the project page.
- Advanced create is gone. Its options are part of the brief: format, length, voice, look and agent.
- API keys, Connectors and Connected apps merge into one "Connect agent" surface with copy-paste setup
  for Claude Code, Claude.ai, ChatGPT, Cursor and the API.
- AI & Providers, Skills, Storage & Media and Account become sections of one Settings page.
- Every object has a "Copy for agent" action that copies the exact MCP call. The UI uses the MCP tool
  names, so MCP, WebMCP, API, CLI and the app stay in sync.
- A failed run says what broke and offers the fix in place, for example "Add key", "Retry" and "Copy
  for agent".
- Both options show the same videos, so the comparison is about the app, not the content.

## Option C: Darkroom

- Idea: a grading suite for AI video. The room is dark so the picture reads true.
- Signature: the storyboard develops. Each shot frame starts blurred and comes into focus as the agent
  composes it, so the tool-call stream is something you watch, not a log you read.
- Art: Be Vietnam Pro, which was designed for Vietnamese, and graphite neutrals. The only accent is the
  red tally light, which means "the agent is working". Primary buttons use inverse ink, not colour.
- Screens:
  - Create: one sentence and option chips.
  - Project: the player with a timeline segmented by shot, takes (versions), the storyboard, the agent
    thread with expandable tool calls, and a sticky "New take" box. Click a shot to revise only that
    shot.
  - Projects: a filterable grid.
  - Activity: a side sheet behind the tally pill.
  - Settings: one page.
  - Connect: a dialog.
- Best for: creators and marketers who judge by the picture, and for a premium, "studio" impression.

## Option D: Script

- Idea: a video is a document. The agent writes the script, and the video is rendered from it.
- Signature: edit a spoken line like text and only that scene re-renders. Tool calls sit as margin
  notes next to the scene they built. A highlighter shows what the agent just wrote, then fades.
- Art: Archivo with a wide display cut and condensed scene numbers, plus Newsreader for spoken lines.
  The background is a cool white. Cobalt is used only for action and selection. It is light by
  default, with a matching dark mode.
- Screens:
  - Home: the brief written as one sentence, where each setting is a clickable word.
  - Project: the script, with the preview, takes and agent handoff on the right.
  - Activity: a table that includes runs started from Claude or ChatGPT.
  - Connect: setup cards.
  - Settings: one page.
- Best for: teams and agent-heavy users. Text is what agents read and write best, so this direction
  gives the fewest tokens and mistakes per revision.

## Recommendation

**Option D (Script)**, borrowing C's developing storyboard frames for the preview while a take renders.

- It best fits the product philosophy. Editing words is something everyone already knows, so there is
  no video editor to learn, and per-scene re-render is the fastest and cheapest revision loop.
- The script is the same object the MCP exposes, so the UI and the agent work on one shared document.
  That gives the best agent experience (AX) and keeps UI, MCP and API in sync by construction.
- The margin notes show every tool call and cost in context without adding a separate dashboard.

Choose C if the first impression and a cinematic feel matter more than the editing loop.
