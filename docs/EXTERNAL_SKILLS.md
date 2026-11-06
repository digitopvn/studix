# External skills

Import [Agent Skills](https://agentskills.io) (a directory with a `SKILL.md`) from any public GitHub repository into
your Studix workspace, then let your AI client read them in later conversations and apply them while it writes a
video brief or VideoIR spec.

An imported skill is **stored data**. Studix does not install it into ChatGPT or Claude, does not run its scripts, and
does not change how the renderer or the worker pipelines behave. Your client reads the text and decides what to apply;
Studix only stores it durably, scoped to your workspace.

## Use it from ChatGPT or any MCP client

Connect the hosted Studix MCP server first ([MCP_API.md](MCP_API.md#connecting-a-client)). Then, for example:

> Import the skills from https://github.com/example/video-skills into Studix.

The client calls these tools (full contract in [MCP_API.md](MCP_API.md#external-skill-tools)):

1. `studix_skill_discover` lists every valid `SKILL.md` in the repository, pinned to one commit, plus the ones that
   cannot be imported and why. A repository without skills returns an empty list.
2. `studix_skill_import` stores the ones you pick (`skillPaths`, or `all: true`) at that commit.
3. In a later conversation: `studix_skill_list` finds them, `studix_skill_get` reads `SKILL.md` or a stored reference
   file, and the client applies the instructions while writing the brief or spec it passes to `studix_create_video`.

> Use the "brand-launch" skill from my Studix skills to write the brief, then create a 9:16 video.

Importing needs the `skill:write` permission (OAuth scope `studix:write`); listing and reading need `skill:read`
(`studix:read`). A read-only connection can read skills but never import, update or disable them.

API keys issued before this feature keep their scopes, except that a key holding exactly one role's earlier scope
set is upgraded to that role's current set (viewers and reviewers gain `skill:read`; editors, admins and owners also
gain `skill:write`). Custom keys are left as issued; create a new key to give one skill access.

## What gets imported

- `SKILL.md` anywhere in the repository (root, `skills/`, `.agents/skills/`, `.claude/skills/`, `.cursor/skills/`,
  nested), with its `name` and `description` frontmatter.
- Text references under `references/`, small images and PDFs under `assets/`.
- `scripts/` are **recorded as metadata only** (path and size). They are never downloaded, stored or executed.
  Anything over the size limits, symlinks and unsupported file types are listed as skipped, with the reason.
- The repository's license text and any author or copyright lines, kept next to the skill. When no recognised license
  is found, the skill is flagged `license.uncertain: true`: a public repository is not automatically reusable.

Limits per import: 25 skills; per skill 100 files, 5 MB in total, 128 KB for `SKILL.md`, 256 KB per text file, 1 MB per
asset. Larger repositories are searched within bounds and reported as `truncated`.

## Versions, updates and disabling

- Every import is pinned to a commit and stored as an immutable version identified by its content hash. Importing the
  same content again changes nothing (`unchanged`). The first version of a skill becomes active at once.
- Nothing is pulled automatically. `studix_skill_update` with `action: "check"` reports whether the upstream skill is
  `current`, `changed` or `missing`; `action: "import"` stores the changed upstream as a **new inactive version**
  (add `activate: true` to switch at once); `action: "activate"` switches to any stored version.
- `studix_skill_get` with a `versionId` always returns that exact version, even after the skill moved on.
- `studix_skill_disable` hides a skill from listing and withholds its content, without deleting anything.
  `enable: true` brings it back.
- Two skills from different repositories may share a name; the import result lists the colliding ids and every call
  addresses a skill by id.

## Safety

Skill text is untrusted third-party content. Every `studix_skill_get` response carries a `trust` notice and
`warnings` (install commands, pipes to a shell, credential requests, instruction overrides) found in the text. The
warnings are labels, not a filter: the text is returned as written, and the host must not follow instructions in it
that its own user did not ask for. Details and the threat model: [SECURITY.md](SECURITY.md#external-skills).

## Operating notes

- Skill files live in the same S3-compatible bucket as artifacts, under `external-skills/` in the workspace prefix.
  Without `S3_BUCKET`, import and content reads answer `UNAVAILABLE`.
- Only `api.github.com` is contacted. `STUDIX_GITHUB_API_TOKEN` is an optional token for that host alone, to raise the
  rate limit. Use a token with no private-repository access: Studix also refuses any repository GitHub does not
  report as public, and each workspace may run at most two GitHub-calling operations at once. Without a token
  GitHub's anonymous limit applies and a limit hit returns `RATE_LIMITED` with
  `details.retryAfterSeconds`.
- Mutations are recorded in the workspace activity trail (`mcp.studix_skill_import`, `…_update`, `…_disable`) with the
  repository, commit and outcome per skill.
- Not in this release: private repositories, other Git hosts, background sync, and passing skills to
  `studix_create_video` (the host applies them itself).
