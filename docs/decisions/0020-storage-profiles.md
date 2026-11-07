# 0020. Storage profiles: operator-managed buckets with live switch

- Status: Accepted
- Date: 2026-11-07

## Context

Object storage was configured only through `S3_*` in the deployment. Rotating
the key pair could already be done from the dashboard, but moving to another
bucket or provider needed a redeploy, and every existing object had to stay in
the one bucket the environment named. Operators asked to configure storage
fully from **Storage & Media**. The server would then connect to an endpoint
typed into a form, with stored credentials, which is an SSRF surface.

## Decision

- **Profiles:** a `storage_profiles` table holds named profiles. Each profile
  has a provider type, endpoint, bucket, region, path style, a key prefix and
  a sealed key pair. Only operators manage them, every change is audited, and
  a profile is stored only after a write/read/head/delete probe with the
  candidate settings passes.
- **One active profile:** at most one profile is active (a partial unique
  index). The `S3_*` settings remain the `env` profile, which applies when no
  stored profile is active, and the fallback for reads.
- **Profile router:** a `ProfileStorageRouter` implements the storage port in
  the app and the worker.
  - It reloads profiles every 20 seconds, so a switch needs no redeploy.
  - A job attempt keeps the profile of its first write.
  - Writes go to the active profile.
- **Recorded profile:** asset versions and renders record `storage_profile_id`.
  The database sets it from the active profile at insert time, and existing
  rows default to `env`.
  - Reads try the recorded profile first, then the others, so a deactivated
    profile stays readable.
  - Signed URLs are issued for the profile that holds the object.
  - A referenced profile cannot be deleted.
- **SSRF guard:** endpoints must be public HTTPS hosts and R2 hosts must match
  `*.r2.cloudflarestorage.com`. Addresses are checked at save time and again
  on each connection through the client's socket lookup. Local endpoints need
  an explicit development flag.

## Consequences

- An operator can move new objects to another bucket in about 20 seconds and
  roll back by activating the previous profile.
- An object read whose location this process has not seen costs one database
  lookup. A signed URL for such an object also costs a HEAD request.
- During the short window when the app and the worker disagree about the
  active profile, a recorded profile can be wrong. The fallback read order
  covers that case.
- Copying objects between buckets is out of scope. Old objects stay where they
  were written.

## Alternatives considered

- **Allow only key rotation, keep the bucket in `S3_*`:** rejected because a
  move still needs a redeploy.
- **Copy every object on switch:** rejected as slow, costly and not needed,
  since reads can follow the recorded profile.
- **Save-time DNS check only:** rejected because it is open to DNS rebinding.
  The connect-time lookup closes that gap.
