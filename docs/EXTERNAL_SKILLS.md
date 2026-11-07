# Skills: GitHub imports and zip uploads

Studix stores [Agent Skills](https://agentskills.io) (a directory with a
`SKILL.md`) imported from public GitHub repositories or uploaded as zip
archives. Every file of a skill is stored, scripts and assets included, so a Pi
task can run it in the [skill sandbox](decisions/0018-skill-sandbox.md). For the
host agent a skill stays untrusted reference text: Studix never runs its
scripts on the server or worker host, never installs what it mentions and never
lets its text change grants, budgets, approvals or tenant context.

Decision records: [ADR-0017](decisions/0017-external-github-skill-store.md),
[ADR-0019](decisions/0019-full-skill-store-uploads-and-risk-gate.md).
Tool contract: [MCP_API.md](MCP_API.md#imported-github-skills).

## Workflow

1. Add skills:
   - `studix_skill_discover` with `repositoryUrl` (optionally `ref`, `path`)
     lists every `SKILL.md` at one commit and writes nothing. Then
     `studix_skill_import` imports the valid skills (all, or `skillPaths`). Pass
     `expectedCommit` from the discover result to import exactly what you
     reviewed, and `idempotencyKey` to make a retry safe.
   - `studix_skill_upload` with `archiveBase64` (up to 10 MiB) stores a zip.
     For a larger zip, call it with `action: "url"`, PUT the archive to the
     returned `uploadUrl` with the given headers within 15 minutes, then call it
     again with the `uploadId`. `SKILL.md` must be at the archive root or in its
     one top-level folder. Uploading a skill with the same name again adds a
     new version; identical content changes nothing.
2. `studix_skill_list` and `studix_skill_get` read them. `list` shows this
   workspace's skills and every platform skill with the active version's
   `activeRiskLevel`. `get` returns metadata, license status and notices, the
   **risk report**, the stored file list and a bounded slice of one stored file
   (`SKILL.md` by default; page with `offset`/`limit`; a binary file returns its
   size only).
3. `studix_skill_update` with `action`: `check` (compare upstream with the
   active version, never changes it), `import` (store upstream content as a new
   version), `activate` (make a stored version the one readers get) or
   `enable`. `check` and `import` apply to GitHub skills only; an uploaded skill
   gets a new version by uploading again. `studix_skill_disable` stops serving a
   skill and keeps its data; `studix_skill_delete` removes the skill, every
   version and every stored file and cannot be undone.

The dashboard **Skills** page does the same: list, GitHub import, zip upload,
risk report, versions, enable and disable (with the high-risk confirmation),
and delete. `studix_inspect` reports `importedSkills` so an agent can find the
store from the handshake.

## What is stored

| Content                                                       | Handling                                                 |
| ------------------------------------------------------------- | -------------------------------------------------------- |
| Every regular file (text, scripts, assets, binaries)          | Stored by SHA-256 under the version, executable bit kept |
| Symlinks, submodules and special files                        | Skipped and listed with the reason                       |
| Paths with `..`, absolute paths, drive letters, control chars | GitHub: dropped. Zip: the whole archive is rejected      |
| Zip: duplicate paths, ZIP64, encryption, zip bombs            | The archive is rejected                                  |

Versions are immutable and content-addressed. The first version of a skill is
active (unless it is high risk, see below); later versions are served only after
an explicit `activate`. Two skills with the same name get different ids;
`import` reports `nameCollisions`. A disabled skill answers `CONFLICT` on `get`
for readers; people who can enable it may still review it.

## Risk report

Every version is scanned when it is stored. The report has a `level` (`low`,
`medium` or `high`) and findings with rule, severity, path, line and excerpt.

| Severity | Rules                                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| high     | `remote-exec` (`curl … \| sh`, `iex`), `secret-harvest`, `credential-request`, `prompt-injection`, native executables, obfuscated code combined with eval |
| medium   | hidden text, `obfuscated-code`, `dynamic-eval`, `shell-exec`, other binaries, `symlink`                                                                   |
| low      | `network-call`, `install-command`, `script-present`                                                                                                       |

The scanner helps a reviewer; it is not a filter, and a `low` report is no
guarantee. Versions stored before the scanner existed get a report derived from
their `securityNotes`.

**High risk needs a person.** A high-risk first version starts disabled
(`riskConfirmationRequired: true`). Enabling a high-risk skill, or activating a
high-risk version of an enabled skill, needs `confirmHighRisk: true` from a user
with the admin, owner or operator role; an API key cannot confirm. The audit
event carries `highRiskConfirmed`, the level and the version.

## Scopes

- `workspace` (default): the skill belongs to one workspace.
- `platform`: visible to every workspace. Only platform operators import,
  upload, enable, disable, activate or delete platform skills; they are stored
  in the platform workspace (`STUDIX_PLATFORM_WORKSPACE_ID`) when it is set.

## Agent runtime

`createSkillBundleSource` in `@studix/skills` returns, for a tenant, the active
files of every enabled workspace and platform skill:
`{ name, description, scope, version, files: [{ path, content, executable? }] }`.
Skills whose name is not a lowercase directory name are skipped.

## Limits

Defaults live in `packages/skills/src/external/import-limits.ts`: 50 skills per
call, 500 files and 30 MiB per skill, 10 MiB per file, 60 MiB per import; zip
archives up to 30 MiB, 1000 entries and a compression ratio of 200 per entry;
15 s per request and 90 s per operation, three redirects, two bounded retries.
A rate-limited GitHub answers `RATE_LIMITED` with the reset time.

## Permissions

`skill:read` (every role, OAuth `studix:read`) for `list` and `get`.
`skill:write` (editor and above, OAuth `studix:write`) for `discover`, `import`,
`upload`, `update`, `disable` and `delete` of workspace skills. Platform skills
need a platform operator. Imports, uploads, version changes, status changes and
deletes are audited (`external_skill.*`) and mutating tool calls appear in the
activity trail.

## Configuration

Object storage (`S3_BUCKET`) is required; without it the tools answer
`UNAVAILABLE`. Upload URLs are presigned PUTs on the same bucket. The dashboard
uploads through `/api/skills/upload`, so the bucket needs no CORS rule for it.
`STUDIX_GITHUB_TOKEN` is optional and only raises the GitHub API rate limit for
public repositories; it is sent to `api.github.com` and never to another host,
and it is redacted from logs. Private repositories are not supported.

## Refs and trust

- A full 40-hex commit SHA is accepted as `ref` only if it is reachable from the
  repository's default branch; otherwise use a branch or tag name.
- `list`, `discover` and `get` all carry a `trust` block marking the content as
  untrusted; names and descriptions in listings are clipped to 300 characters.
