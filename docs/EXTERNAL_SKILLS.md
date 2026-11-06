# Imported GitHub skills

Studix can import public GitHub [Agent Skills](https://agentskills.io) (a
directory with a `SKILL.md`) into a workspace and serve them back to the host
agent as **reference text**. Imported skills are data. Studix never runs a
script from them, never installs anything they mention and never lets their
text change grants, budgets, approvals or tenant context.

Decision record: [ADR-0017](decisions/0017-external-github-skill-store.md).
Tool contract: [MCP_API.md](MCP_API.md#imported-github-skills).

## Workflow

1. `studix_skill_discover` with `repositoryUrl` (optionally `ref`, `path`).
   Lists every `SKILL.md` at one commit, valid or not, and what would be stored
   or only described. Writes nothing.
2. `studix_skill_import`. Imports the valid skills (all, or `skillPaths`). Pass
   `expectedCommit` from the discover result to import exactly what you
   reviewed, and `idempotencyKey` to make a retry safe.
3. `studix_skill_list` and `studix_skill_get` read them. `get` returns metadata,
   license status and notices, `securityNotes`, the stored file list and a
   bounded slice of one stored file (`SKILL.md` by default; page with
   `offset`/`limit`).
4. `studix_skill_update` with `action`: `check` (compare upstream with the
   active version, never changes it), `import` (store the upstream content as a
   new version), `activate` (make a stored version the one readers get) or
   `enable`. `studix_skill_disable` stops serving a skill and keeps its data.

`studix_inspect` reports `importedSkills` (count, a few names and the tool names)
so an agent can find the store from the handshake.

## What is stored

| Content                                                       | Handling                                               |
| ------------------------------------------------------------- | ------------------------------------------------------ |
| `SKILL.md`, text references, license files, small text assets | Stored in object storage by SHA-256 under the version  |
| Scripts, binaries, oversized or non-UTF-8 files               | Listed with their git sha and reason, never downloaded |
| Symlinks and submodules                                       | Skipped                                                |
| Paths with `..`, absolute paths, backslashes, control chars   | Dropped                                                |

Versions are immutable and content-addressed. The first version of a skill is
active; later versions of the same source are stored but only served after an
explicit `activate`. Importing identical content again changes nothing. Two
skills with the same name get different ids; `import` reports `nameCollisions`.
A disabled skill answers `CONFLICT` on `get`.

## Limits

Defaults live in `packages/skills/src/external/import-limits.ts`: 50 skills per
call, 100 files and 2 MiB per skill, 256 KiB per file, 20 MiB per import,
15 s per request and 90 s per operation, three redirects, two bounded retries.
A rate-limited GitHub answers `RATE_LIMITED` with the reset time.

## Permissions

`skill:read` (every role, OAuth `studix:read`) for `list` and `get`.
`skill:write` (editor and above, OAuth `studix:write`) for `discover`, `import`,
`update` and `disable`. Imports, version changes and disable/enable are audited
(`external_skill.*`) and mutating tool calls appear in the activity trail.

## Configuration

Object storage (`S3_BUCKET`) is required; without it the tools answer
`UNAVAILABLE`. `STUDIX_GITHUB_TOKEN` is optional and only raises the GitHub API
rate limit for public repositories; it is sent to `api.github.com` and never to
another host, and it is redacted from logs. Private repositories are not
supported.
