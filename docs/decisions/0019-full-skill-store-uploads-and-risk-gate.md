# 0019. Full skill store: zip uploads, risk reports and platform skills

- Status: Accepted
- Date: 2026-11-07
- Supersedes: the "Data only" part of [ADR-0017](0017-external-github-skill-store.md)

## Context

[ADR-0018](0018-skill-sandbox.md) gives Pi tasks a sandbox that can run a skill's
scripts. A skill such as `motion-video` is useless there without its scripts and
assets, but ADR-0017 stored only text. Teams also keep skills that are not on
GitHub, and operators want a few vetted skills available to every workspace.
Storing executable content makes the review of each version matter more.

## Decision

- **Every regular file is stored.** Scripts, assets and binaries go to object
  storage under `external-skills/<versionId>/<sha256>`, with the executable bit
  kept. Symlinks, submodules and special files are skipped and listed. Limits:
  500 files, 10 MiB per file, 30 MiB per skill, 60 MiB per import. Manifests
  written this way have `schemaVersion: 2`.
- **Zip uploads.** `studix_skill_upload` takes base64 (up to 10 MiB) or an
  `uploadId` from a presigned PUT into Studix's own bucket; the server never
  fetches a user URL. The dashboard posts the raw zip. A custom reader parses the
  central directory, rejects absolute paths, `..`, drive letters, control
  characters, duplicate paths, ZIP64 and encryption, and stops zip bombs with an
  entry limit, a compression-ratio limit and `maxOutputLength` on inflation.
  Uploading the same skill name again adds a version.
- **A risk report per version.** A rule scanner rates each version `low`,
  `medium` or `high` with findings (remote execution, secret harvesting,
  credential requests, prompt injection, obfuscation with eval, native
  executables, symlinks; shell, network and install calls lower). Versions from
  before this ADR get a report derived from their `securityNotes`.
- **High risk needs a person.** A high-risk first version starts disabled.
  Enabling a high-risk skill, or activating a high-risk version of an enabled
  one, needs `confirmHighRisk: true` from a user with the admin, owner or
  operator role; API keys cannot confirm. The audit event records the
  confirmation, the level and the version.
- **Scopes.** `workspace` (default) or `platform`. Platform skills live in the
  platform workspace (`STUDIX_PLATFORM_WORKSPACE_ID`), are visible to every
  workspace, and only platform operators write, enable, disable or delete them.
- **Bundle port.** `createSkillBundleSource` returns the active files of every
  enabled skill a tenant can see, in the shape the agent runtime defines
  (`{ name, description, scope, version, files: [{ path, content, executable? }] }`).
  Names that cannot be a directory are skipped.
- **Delete.** Deleting removes the rows (versions cascade), audits
  `external_skill.deleted`, then removes the objects.

## Consequences

Skill files are still untrusted text for the host agent and are executed only in
the ADR-0018 sandbox, never on the server or worker host. The scanner is a
review aid, not a filter: a `low` report is not a guarantee. One migration adds
`external_skills.scope` and `external_skill_versions.risk`; both are additive.

## Alternatives considered

- Fetching a zip from any URL: an SSRF path. Rejected for presigned uploads.
- A zip library: a large dependency for a small, security-critical reader with
  limits we want to own. Rejected.
- Blocking high-risk skills entirely: legitimate skills run shell and network
  code. Rejected for an audited human confirmation.
