# 0017. External GitHub skill store

- Status: Accepted
- Date: 2026-11-06

## Context

Hosts want to reuse public Agent Skills from GitHub when briefing a video, but a
skill repository is untrusted: it can carry scripts, symlinks, huge files and
text written to steer an agent. Fetching an arbitrary user-supplied URL from the
server would also be an SSRF path.

## Decision

- **Fixed egress.** Only `api.github.com` and `raw.githubusercontent.com` are
  ever fetched. The user's URL is parsed for `owner/repo/ref/path` and never
  requested. Redirects are followed manually inside the same allowlist.
- **Data only.** `SKILL.md`, text references, licenses and small text assets are
  stored. Scripts and binaries are described by git sha and never downloaded;
  symlinks and submodules are skipped. Nothing is executed or installed.
- **Pinned and immutable.** Every import resolves the ref to a commit. A version
  is a content-addressed manifest; objects live under
  `external-skills/<versionId>/<sha256>`. Unique `(skill_id, content_hash)` and a
  row lock on the skill make concurrent and repeated imports converge on one
  version.
- **Explicit activation.** The first version is active; later ones are served
  only after `activate`, so upstream changes never alter what an agent reads.
- **Workspace scoped.** Skills and versions carry the tenant columns; ids are the
  identity, names may collide and are reported.
- **Untrusted on read.** `get` returns a `trust` block and heuristic
  `securityNotes` (install commands, remote execution, credential requests,
  instruction overrides, scripts). Notes help a reviewer; they are not a filter.
- **New permissions.** `skill:read` and `skill:write`, mapped from the OAuth
  scopes `studix:read` and `studix:write`.

## Consequences

Private repositories, non-GitHub hosts, script execution and automatic upstream
sync are out of scope. A new skill-bearing repository needs no deployment
change; the optional `STUDIX_GITHUB_TOKEN` only affects rate limits.

## Alternatives considered

- Cloning with `git`: runs attacker-influenced git code and fetches the whole
  history. Rejected.
- Auto-updating the active version: lets upstream change agent input silently.
  Rejected.
- Executing skill scripts in the worker sandbox: needs a separate threat model.
  Deferred.
