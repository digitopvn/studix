# @studix/marketing

Marketing site for Studix, served by a small Cloudflare Worker with static assets.

> The page content is a placeholder. The real content and design will replace it later; only the
> bootstrap and the deploy pipeline are in scope here.

## Layout

- `src/index.ts`: Worker. Serves `/healthz` and `/config.json`, adds security headers, injects the app
  URL into every `<a data-app-link>` and falls back to the static assets.
- `public/`: static site (`index.html`, `css/`, `favicon.svg`).
- `wrangler.jsonc`: Worker config. The app URL is the `STUDIX_APP_URL` var.

## Develop

```sh
pnpm --filter @studix/marketing dev     # wrangler dev
pnpm --filter @studix/marketing build   # dry-run bundle into dist/
```

## Deploy

Provide credentials through the environment (never commit them):

```sh
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
pnpm --filter @studix/marketing deploy
```

To point the CTA at another app URL, change `STUDIX_APP_URL` under `vars` in `wrangler.jsonc`.
