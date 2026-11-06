# 0018. Platform credentials managed in the dashboard

- Status: Accepted
- Date: 2026-11-06

## Context

The object-storage key and the media vendor keys were environment variables, so
a rotation, or finding out that a key was wrong, meant a redeploy and a guess.
They are platform infrastructure shared by every workspace, not workspace data.

## Decision

- **Operator only.** A new `platform:manage` permission is held by the `operator`
  role, and only by a signed-in user: API keys, OAuth tokens, agents and system
  actors never carry it. Agents get no route to these credentials.
- **One vault.** Values are sealed with the existing `SecretBox` and
  `STUDIX_SECRETS_KEY` into `platform_secrets`, with associated data
  `platform:<name>`. No second vault, no free-form environment editor: a fixed
  allowlist of the storage key pair and six vendor variables.
- **One source at a time.** A stored value overrides the environment variable;
  revoking it returns to the environment. Nothing is copied from the environment.
- **Live, without restart.** The app and the worker read the table through
  `createPlatformSecretSource` every 15 seconds. Multix receives the overlaid
  environment on each call; the S3 client takes a credential provider whose
  identity expires just past the SDK's refresh window.
- **Verify before replacing.** A new storage key must pass put, get, head and
  delete before it is stored. Vendor checks are informational.
- **Endpoint is not editable.** Endpoint, bucket and region stay in the
  environment, so the page cannot redirect uploads.

## Consequences

- Rotation needs no redeploy; a running job keeps the credential it started with
  and its next call uses the new one.
- App and worker must share `STUDIX_SECRETS_KEY` and the database to agree.
- Without `STUDIX_SECRETS_KEY` the page is read-only and the environment is used.
- Per-workspace keys (bring your own) remain out of scope.

## Alternatives considered

- Environment editor on the page: arbitrary variables, no allowlist; rejected.
- Restart-to-apply: simpler, but interrupts running jobs; rejected.
