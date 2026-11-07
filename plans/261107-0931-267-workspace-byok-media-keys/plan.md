# Workspace BYOK media keys (#267, BYOK part)

Status: in progress. R2 rotation from the dashboard is covered by PR #265 and is out of scope here.

## Outcome

A workspace admin stores the workspace's own Multix vendor keys (Sume, Atlas Cloud, ElevenLabs, Fish,
MiniMax, OpenRouter). Media calls of that workspace's jobs run on its key instead of the platform key, the
spend is recorded with `funding: "workspace"` (recorded, not charged, ADR 0016), and no other workspace can
see or spend the key.

## Design

- Storage: reuse `provider_connections` (sealed with `STUDIX_SECRETS_KEY`, AAD bound to workspace and row)
  with provider id `media-<vendor>`, owner `workspace`, `runtimes: []`. An empty runtime list means agent
  runtimes can never resolve the row; the AI & Providers list hides media rows. No migration needed.
- Service: `ProviderConnectionService` gains `listMediaKeys`, `saveMediaKey` (create or rotate),
  `removeMediaKey` and `resolveMediaKeys(ctx)` (worker side, env-name map of the caller's workspace only).
  Writes need `member:manage`; values never leave the service except to `resolveMediaKeys`.
- Multix provider: optional `workspaceCredentials(ctx)`; `generate` and `resume` run the child with the
  workspace key layered over the platform key and tag results and `MediaChargedError` charges with
  `funding: "workspace"` when the request's vendor key came from the workspace.
- `stored-media` passes `funding` to the provider execution row and the usage line.
- API: `GET/PUT/DELETE /api/workspace/media-keys[/:vendor]`; dashboard section on the Storage & Media page
  for workspace admins.

## Not in scope

- Capability discovery stays platform-wide: a vendor with no platform key is still not advertised even if a
  workspace has its own key (follow-up).
- Live vendor test of a workspace key (rows are `unverified`).

## Acceptance

- Unit/integration tests: isolation between workspaces, RBAC, hidden from agent runtimes and list,
  child env precedence and funding tag.
- `pnpm check`, `pnpm test:integration` green (except known environmental failures).
