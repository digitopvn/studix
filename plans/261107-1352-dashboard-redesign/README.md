# Dashboard redesign: two directions

Design only. No dashboard code changes until the user picks one. Open the HTML files in a browser;
both are clickable, responsive, and switch between light and dark (◐).

## Shared decisions

- The 11 nav items collapse to 3 destinations: create, projects, settings.
- Projects and Jobs merge. A job is a version of a project, and its Activity and Stages sit on the
  project page.
- Advanced create is gone. Its options become chips in the composer: ratio, length, voice, style and
  runtime.
- API keys, Connectors and Connected apps merge into one "Connect an agent" surface with copy-paste
  commands for Claude, ChatGPT and Cursor.
- AI & Providers, Skills, Storage & Media and Account become sections of one Settings page.
- Every object has a "Copy for agent" action that copies the exact MCP call. The UI uses the same tool
  names as MCP, WebMCP, API and CLI, so they stay in sync.

## Option A: Quiet Studio

- Direction: an editorial, calm, warm paper studio. One composer, no chrome.
- Art: Instrument Serif display type over Inter. Warm paper and ink, with a single vermilion accent.
  It is light-first, with a warm dark mode.
- Tokens: 8-step spacing scale from 4 to 72, radius 6/10/16/pill, motion 120/220 ms on one ease curve.
- IA: top bar with New, Library and Settings, plus "Use with your agent".
- Agents: tool calls appear inline in the chat thread as cards. The agent drawer holds the MCP setup.
- Strengths: it is the simplest option and approachable for non-technical creators. It looks
  premium and stays calm. It fits mobile well.
- Weaknesses: the tool-call stream scrolls away with the chat. Power users get less information at a
  glance.

## Option B: Agent Console

- Direction: a dark-first workspace where the agent is always visible.
- Art: Geist and Geist Mono, near-black panels and an electric lime accent. The light mode uses an
  indigo accent.
- Tokens: spacing from 4 to 40, radius 4 to 12, motion 100/180 ms.
- Layout: three panes.
  - Left: projects listed as threads, like chats.
  - Center: the composer or the player with versions and timestamped revise notes.
  - Right: a persistent agent pane with the live tool calls, the running cost and "continue from
    your own agent".
- IA: New video, project threads, Connect an agent and Settings with tabs. Keyboard shortcuts N and ⌘K.
- Strengths: it shows the most agent experience (AX), because tool calls, cost and MCP handoff are
  always on screen. Projects as threads make revising natural. It feels professional and impressive.
- Weaknesses: it is denser. On small screens the side panes become drawers.

## Recommendation

**Option B (Agent Console)**, with Option A's starter prompts and its restraint in the center pane.

- Agents are first-class in Studix, and B makes the agent's work visible all the time instead of
  burying it in chat scroll. The user sees each tool call and its cost, so mistakes cost less.
- Projects as threads fit the "create, then revise" loop better than a gallery does.
- B maps one-to-one onto the existing agentic chat and the job Activity and Stages, so migrating
  costs less.
- B is still not a complex dashboard or video editor: there are no charts and no timeline, only one
  player and a text revise box.

Choose A if most users are non-technical creators who rarely care about tool calls.
