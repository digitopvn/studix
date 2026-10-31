# AGENTS.md

Rules for coding agents working in this repository.

## Multix CLI

Studix runs image, video, lip-sync and upscale jobs through the Multix CLI (`mrgoonie/multix-cli`).
When a Studix task needs a bug fixed or a feature added in Multix, fix it upstream yourself:

1. Open an issue on `mrgoonie/multix-cli`. Search for an existing one first.
2. Implement the change in the Multix checkout, open a PR that closes that issue, and get it merged.
3. Bring the fix into Studix. Update the pinned commit or version (`MULTIX_COMMIT` in `Dockerfile`, see
   `docs/DEPLOYMENT.md`) once a release or tag contains it.

Do not patch around a Multix defect inside Studix when the fix belongs upstream.

Local checkouts of Multix:

- Windows: `D:\www\oss\multix-cli`
- macOS: `/Volumes/GOON/www/oss/multix-cli`
