# 0023. Workspace storage profiles override the platform choice

- Status: Accepted
- Date: 2026-11-07

## Context

[ADR-0020](0020-storage-profiles.md) let only the platform operator choose
where new objects go. Studix is multi-tenant, and workspaces asked to bring
their own bucket, as they can already bring their own media vendor keys. The
platform choice must stay the default for every workspace that sets nothing.

## Decision

- **Scope column:** `storage_profiles.workspace_id` is null for a platform
  profile and set for a workspace's own profile. A partial unique index on
  `coalesce(workspace_id, '')` keeps one active profile per scope.
- **Who:** workspace owners and admins (`member:manage`, user actors only)
  manage their workspace's profiles under `/api/workspace-storage`. The
  operator keeps `/api/platform`. A profile from another scope reads as
  `NOT_FOUND`. Workspace changes are audited to the workspace.
- **Resolution:** new objects go to the workspace's active profile, else the
  platform's active profile, else `env`. In a workspace, `env` means "follow
  the platform" and is listed as **Platform default**.
- **Router:** the snapshot carries each workspace's active profile. The router
  never uses a workspace profile for another workspace, for writes or reads.
- **Recorded profile:** the insert-time default resolves per workspace, so
  existing objects keep their recorded profile and stay readable after a
  switch.
- **Dashboard:** **Storage & Media** is shown to owners, admins and the
  operator. It holds the workspace storage card and the workspace media keys;
  the operator also sees the platform defaults.

## Consequences

- A workspace can move its new objects to its own bucket and back without the
  operator.
- The same probe-first save and SSRF guard apply to workspace endpoints, so a
  workspace admin can make the server connect only to public HTTPS hosts.
- Copying objects between buckets stays out of scope.

## Alternatives considered

- **A separate table for workspace profiles:** rejected; it duplicates the
  sealing, probe and router code for one extra column.
- **Owners only:** rejected; admins already manage workspace media keys.
