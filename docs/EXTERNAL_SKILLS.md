# Imported skills (GitHub)

A workspace can import [Agent Skills](https://agentskills.io) (a directory with a
`SKILL.md`) from **public GitHub repositories** and let its agents read them
over MCP. This is separate from the built-in workflow templates and knowledge
packs, which stay in code. Imported skills are reference material the agent
reads; Studix never runs them.

Out of scope: private repositories, running skill scripts, and activating
imported skills inside the worker pipeline.

## Flow

```text
studix_skill_discover  ->  studix_skill_import  ->  studix_skill_list  ->  studix_skill_get
```

1. `studix_skill_discover { repositoryUrl, ref?, path? }` lists the valid skills
   at the pinned commit and why invalid ones were skipped. It changes nothing.
   A repository without skills returns an empty list, not an error.
2. `studix_skill_import { repositoryUrl, expectedCommit?, skillPaths?, idempotencyKey?, activate? }`
   stores each skill. Pass the `commitSha` from discover as `expectedCommit` to
   import exactly what was reviewed.
3. `studix_skill_list { query?, repository?, enabled?, limit?, cursor? }` shows
   the workspace's skills. `studix_inspect { include: ["importedSkills"] }` shows
   the first enabled ones.
4. `studix_skill_get { skillId, versionId?, path?, offset?, maxChars? }` returns
   `SKILL.md` (or a stored reference file) in pages. Follow `next[]` while
   `content.truncated` is true. Every result carries a notice that the content
   is third-party data.
5. Use the guidance when writing a brief for `studix_create_video`.

`studix_skill_update { skillId, action }` with `check` (is upstream newer?),
`import` (fetch a newer commit), `activate` (serve a given `versionId`) or
`enable`. `studix_skill_disable { skillId }` stops serving the content; versions
are kept.

## Versions and idempotency

- A skill is identified by repository and directory. Importing it again with the
  same content returns `unchanged`; changed content becomes a new, immutable
  version pinned to its commit sha.
- A new version of a skill that already has an active one is stored but not
  served until you pass `activate: true` or call `skill_update` `activate`. The
  first version is active immediately.
- Concurrent imports of the same source are serialized, so one skill and
  consecutive version numbers result.
- Skills with the same `name` from different sources coexist. Select by `skillId`;
  results list `nameCollisions`.

## Limits

| Limit                         | Value       |
| ----------------------------- | ----------- |
| `SKILL.md`                    | 256 KB      |
| One reference or asset file   | 128 KB      |
| Bundle per skill              | 2 MB        |
| Files per skill               | 100         |
| Skills per import             | 50          |
| Directory depth               | 10          |
| Per request / whole operation | 10 s / 60 s |

Oversized or unsafe files are listed under `skipped` or make that skill
`rejected` with the reason; the rest of the import continues.

## Permissions

`skill:read` (discover, list, get, `update check`) is part of every role.
`skill:write` (import, disable, `update import/activate/enable`) is part of
editor, admin and owner. OAuth `studix:read` grants `skill:read`;
`studix:write` adds `skill:write`. Imports, updates and disables are audited
with the repository, commit and `idempotencyKey`.

Existing API keys that match a role's earlier scope set are upgraded by
migration so they keep their role; custom keys are unchanged.

## Configuration

Object storage (`S3_BUCKET`) must be configured; without it the tools answer
`UNAVAILABLE`. `STUDIX_GITHUB_TOKEN` is optional and only raises GitHub's
unauthenticated rate limit (60 requests/hour). Hitting the limit returns
`RATE_LIMITED` with the reset time; import fewer skills per call or set a token.

## Safety

See [SECURITY.md](SECURITY.md#imported-skills) for the threat model: fixed
GitHub hosts, no redirects, path and symlink checks, size caps, and risk flags
(`riskFlags`) that warn about install commands, piped scripts, instruction
overrides and credential requests.

Licences are reported, never assumed: each version records the skill's declared
licence, the repository licence and a `licenseNotice`. Check that the licence
permits your use before copying content into your own work.
