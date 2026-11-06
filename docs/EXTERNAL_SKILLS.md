# External skill store

A workspace can import Agent Skills (a folder with a `SKILL.md`) from public GitHub repositories and read
them back through MCP. Skills are stored as **data**. Studix never executes a script, installs a skill into
the host agent, or follows instructions inside a skill. The host agent reads a skill and applies its guidance
itself while writing the brief or VideoIR it sends to `studix_create_video`.

Tool arguments and results are in [MCP_API.md](MCP_API.md#external-skill-tools). This page covers the model,
limits and operations.

## Flow

1. `studix_skill_discover` lists valid and invalid skills in a repository, pinned to one commit. Nothing is stored.
2. `studix_skill_import` fetches the chosen folders at that commit (pass `expectedCommit` to refuse a moved branch).
3. `studix_skill_list` and `studix_skill_get` read the workspace copy. Reads never reach GitHub.
4. `studix_skill_update` compares with upstream (`check`), stores a new version (`import`) or switches the
   active version (`activate`). `studix_skill_disable` stops offering a skill without deleting versions.

## Versions

- A version is immutable and identified by the commit plus a hash of its file contents.
- The first import is activated automatically. A later import of a changed upstream adds a version that stays
  inactive until you activate it.
- Importing the same commit and content again changes nothing.
- If the upstream folder disappears, the skill is marked `missing` upstream; stored versions stay readable.

## Storage

Metadata lives in Postgres (`external_skills`, `external_skill_versions`), scoped to organization and
workspace. File bytes live in object storage under `external-skills/blobs/<sha256>`, so identical files are
stored once. Scripts are recorded as metadata only (path, size, hash); their bytes are never fetched or stored.
Without object storage configured, the tools return `UNAVAILABLE`.

## Permissions

Reading needs `skill:read`, importing and changing needs `skill:write`. OAuth clients request the matching
`skill:read` and `skill:write` scopes. Tools that reach GitHub are marked open-world.

## Limits

The importer enforces these defaults (`DEFAULT_GITHUB_SKILL_LIMITS` in `packages/skills`):

| Bound                            | Default             |
| -------------------------------- | ------------------- |
| Folder depth                     | 12                  |
| Skills read per discovery        | 100                 |
| Files per skill                  | 200                 |
| One supporting file              | 1 MiB               |
| `SKILL.md`                       | 256 KiB             |
| One skill                        | 5 MiB               |
| One import call                  | 25 MiB              |
| HTTP requests per call           | 1000                |
| Request / total timeout          | 15 s / 120 s        |
| Retries (5xx, network)           | 2, exponential      |
| Same-host redirects              | 2 (cross-host: none) |

Only public GitHub hosts are contacted. Anything over a bound is skipped or rejected with a reason in the result.

## Configuration

`STUDIX_GITHUB_TOKEN` is optional. Without it Studix uses unauthenticated GitHub requests, which have a low
rate limit; a read-only token for public repositories raises it. The token is outbound only and is never
returned by a tool. See [SECURITY.md](SECURITY.md#external-skills) for the trust model.
