# AGENTS.md

Rules for coding agents working in this repository.

## Product philosophy

- Insanely simple: users and their AI agents know how to use Studix without thinking.
- One goal: create and edit AI video projects as conveniently as possible, with the highest output
  quality, the fastest render, the most convenient agent use, the fewest mistakes and the fewest tokens.
- MCP, WebMCP, API, CLI and docs always stay in sync.
- AX and UX matter most. Studix takes the complexity onto itself so the user and their agent get a
  perfect experience.
- Stay general enough, and easy to change later.
- The MVP ships fast: keep tests few and focused, and keep tests and CI as fast as possible.

## Working habits

- Before ending a turn, review the runs in the current session. Propose improvements that make the
  next run better, faster, less error-prone and cheaper in tokens, while keeping the highest
  effectiveness and the best output quality.
- Always dogfood the product to find bugs and poor AX/UX, then propose improvements.
- Always take the place of the user and the user's agent. Work out what they need from Studix to be
  more satisfied, then propose it or apply it directly while you work, following the product
  philosophy above.

## Working in parallel

Several agent sessions work on this repository at once, and a scheduled routine starts on every issue
labelled `ai-handle`.

- Labels track an issue: `in progress`, then `blocked`, `in review`, `done` (PR open) and `shipped`
  (merged). Before you start an issue, read its labels, assignees, comments and linked PRs. If it already
  has `in progress` or a later label, or an open PR, another session owns it: leave it alone, or comment
  there if you found something it needs.
- While you work an issue, keep it current: when you start, assign the GitHub user you run as
  (`gh issue edit <n> --add-assignee @me`) and add `in progress`. At each change of state, swap in the
  matching label (`blocked`, `in review`, `done`, `shipped`) and remove the one it replaces, so the issue
  always carries exactly one status label.
- A new issue that you label `ai-handle` starts its own session. Either let that session fix it, or leave
  the label off and fix it yourself. Never do both.
- A hotfix merged straight into `main` goes back into `dev` in the same session: merge `origin/main` into a
  branch from `dev`, keep the tests of both sides passing, and open a PR into `dev`. Otherwise the next
  `dev` → `main` release conflicts, and a session whose branch starts at `main` cannot push work built on
  `dev`.
- Before you merge, fetch `dev` again. If someone already merged the same fix, close your PR as superseded
  instead of merging over theirs.

## Definition of done

- Use `pnpm`. Before reporting done, run `pnpm check` (lint, typecheck, QA and unit tests).
- CI also runs `pnpm test:integration` and `pnpm build`. Integration tests need
  `docker compose up -d --wait postgres minio`, then `docker compose run --rm minio-init`, and the
  `DATABASE_URL` / `S3_*` values from `.env.example`.
- Biome also formats Markdown: run `pnpm lint:fix` after editing docs.

## Costly actions

- `pnpm test:live` (`STUDIX_LIVE=1`) and `pnpm --filter @studix/mcp-server smoke` call paid providers.
  Run them only when the task needs a live check.
- Migrations: generate them with `pnpm db:generate`. Never edit, renumber or re-timestamp a committed
  migration; fix forward with a new one. Keep migrations expand-then-contract
  ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#rollback)).
- TOSE: the workspace hosts other production projects, so touch only `studix-` resources. Select its key
  explicitly, because the local default key belongs to another workspace. Route:
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#tose-access).

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
