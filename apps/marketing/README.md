# @studix/marketing

Marketing site for Studix, served by a small Cloudflare Worker with static assets.

> The page is the Motion MCP landing (content and brand kept as-is); only the app links point at
> Studix. It ships in two languages: Vietnamese at `/`, English at `/en/`. All media is served from
> `public/assets`; only fonts come from Google Fonts, and the Worker's CSP allows nothing else.

## Layout

- `src/index.ts`: Worker. Serves `/healthz` and `/config.json`, adds security headers, injects the app
  URL into every `<a data-app-link>` (and its `/mcp` into `[data-app-mcp-url]`) and falls back to the
  static assets.
- `public/index.html` (VI) and `public/en/index.html` (EN): the same markup with translated copy. Keep
  the two in sync when either changes.
- `public/js/content-vi.js`, `public/js/content-en.js`: copy the page script renders (showcase, steps,
  compare, chat, tools, pricing, FAQ, UI labels). Same keys in both; each page loads its own.
- `public/js/site.js`: behaviour shared by both pages. It reads the app URL from the rewritten
  `data-app-link` CTAs for the links it renders itself.
- `public/css/site.css`: styles; `:lang(vi)` gives display headings room for Vietnamese diacritics.
- `public/assets/`: static media, grouped by use. Add new files to the matching folder and reference
  them by absolute path (`/assets/...`); Cloudflare caps a single asset at 25 MiB.
  - `img/`: logo mark and screenshots (`mark.svg`, `dashboard.webp`).
  - `films/`: showcase films, `<key>.mp4` plus its `<key>.webp` poster (`key` as in `films` in
    `site.js`). They also join the gallery wall, tagged through `FILM_TAGS` in `site.js`.
  - `gallery/`: filter-gallery clips, `<slug>.mp4`. The wall runs edge to edge with ~290px cards and
    repeats its items so each column holds about four.
- `public/` is excluded from Biome: it is the ported template, kept close to its source.
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
