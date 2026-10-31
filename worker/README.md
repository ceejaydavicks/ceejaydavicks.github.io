# `worker/` — the AfterDark catalogue Worker (verbatim copy)

A **separate** Cloudflare Worker app, stored here exactly as published.
**Start with [SETUP.md](SETUP.md)** — it walks through KV, the three secrets,
deploy and the webhook in 5–10 minutes.

## Provenance

| | |
| --- | --- |
| Source | <https://raw.githubusercontent.com/Nior122/Afterdark/main/worker/worker.js> |
| Repo | <https://github.com/Nior122/Afterdark> (`main`, pushed 2026-10-31) |
| Git blob SHA-1 | `cafe351c751637275f40d679c5d5e7d43c727f33` (175,550 bytes, 4,352 lines) |
| Copied | 2026-10-31, unmodified — no edits, no reformatting |

> **Licence: the source repository declares no licence.** With no licence, the
> default is *all rights reserved*: redistributing this file in a public repo is
> not covered by any permission from the author. If this repository stays public,
> ask Nior122 for permission (or a licence) first — or keep the copy in a private
> repo. Nothing here changes the licence of the rest of the site.

## What it is

A single-file Worker that owns its own catalogue:

- **Storage: Workers KV** (`VIDEOS`), not D1. Video records, drafts, settings,
  view counters and the feed memo all live in KV.
- **Its own routes:** `POST /telegram/webhook`, `GET /api/videos`,
  `POST /api/videos/:id/view`, `GET /api/videos/:id/stream.mp4`,
  `GET /api/videos/:id/thumb.jpg`, `GET /api/settings`, `/api/admin/*`
  (`Authorization: Bearer ADMIN_TOKEN`), `GET /health`.
- **Its own behaviour:** review cards before publishing, page scraping, an AI
  caption/hashtag agent (optional), a streaming proxy with Range support, view
  counting, ad slots and rebuild triggers.

It does **not** read the site's D1 database and does not serve the Pages site.
The two apps are independent.

**It is headless.** `worker.js` contains no dashboard page — the `/admin` UI
belongs to the AfterDark site, which this repo does not copy. You operate this
Worker entirely from Telegram (`/start`, send a video, send a link → ✅ Publish,
`/videos`, `/pending`, `/rename`, `/remove`); `/api/admin/*` is available for
scripts with `Authorization: Bearer ADMIN_TOKEN`.

## Required Cloudflare setup

| Kind | Name | Needed |
| --- | --- | --- |
| KV namespace | `VIDEOS` | **Yes** |
| Secret | `BOT_TOKEN` | **Yes** — token from @BotFather |
| Secret | `WEBHOOK_SECRET` | **Yes** — any long random string |
| Secret | `ADMIN_TOKEN` | Yes, for `/api/admin/*` |
| Secret | `GITHUB_TOKEN`, `CLOUDFLARE_BUILD_HOOK` | Only for rebuild triggers |
| Var | `ALLOWED_USER_IDS` | Recommended — otherwise the first `/start` claims ownership |
| Var | `ALLOWED_CHANNEL_IDS` | Optional — channel posting |
| Var | `SITE_URL` | Optional — a link back to the dashboard |
| Binding | `AI` | Optional — captions only |

```sh
cd worker
npx wrangler kv namespace create VIDEOS     # paste the id into wrangler.toml
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy                         # note the *.workers.dev URL
```

Full walkthrough, verification steps and troubleshooting: **[SETUP.md](SETUP.md)**.
For local runs, copy `.dev.vars.example` to `.dev.vars` (gitignored).

Then point **this worker's own bot** at it:

```sh
curl "https://api.telegram.org/bot<WORKER_BOT_TOKEN>/setWebhook" \
  -d "url=https://<worker>.workers.dev/telegram/webhook" \
  -d "secret_token=<WEBHOOK_SECRET>" \
  -d 'allowed_updates=["message","channel_post","edited_message"]'
```

Check it with `https://<worker>.workers.dev/health` and
`https://api.telegram.org/bot<WORKER_BOT_TOKEN>/getWebhookInfo`.

## Two rules before you deploy this

1. **Use a second bot.** Telegram allows exactly **one webhook per bot token**.
   Registering this Worker with the bot the Pages site already uses silently cuts
   the site's bot off (`/api/telegram/setup` on the site will then show a webhook
   mismatch). Create a new bot with @BotFather for the Worker.
2. **Nothing carries over by itself.** The site's videos live in D1 (`videos`
   rows: `title`, `thumbnail_url`, `video_url`, `embed_url`, `duration`, `tag`…).
   This Worker reads KV records (`id`, `title`, `kind`, `thumbFileId`,
   `durationSec`, `sourceUrl`, `site`, …). There is no shared storage and no
   importer included here, so a cutover needs one of:
   - re-ingest the videos through the Worker's own bot/admin, or
   - a one-off script that reads `GET /api/videos` (site) and writes the mapped
     records into KV, or
   - keep the site as the catalogue and use the Worker only as a second property.

## Relationship to the current site

The live site keeps working exactly as it did: Pages Functions + D1, the scraper
in `functions/_lib/scrape.js`, and the bot in `functions/_lib/telegram.js`. This
folder is inert until someone runs `wrangler deploy` inside it — nothing in the
Pages build compiles or serves it. Wiring the site's front end to this Worker's
feed is a separate, opt-in change (see step 6 of SETUP.md).

Two small protections are in place:

- `.assetsignore` lists `/worker`, so the Cloudflare Pages deployment does not
  publish this source as a static asset.
- If this repository stays public, GitHub Pages will still serve the file at
  `/worker/worker.js` (it contains no secrets — only the app source).
