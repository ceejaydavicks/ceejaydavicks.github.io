# Deploy this Worker (5–10 minutes)

This turns `worker/worker.js` into your own running bot with its own catalogue.
It is **headless** — there is no `/admin` web page inside `worker.js` (that page
belongs to the AfterDark site, which this repo does not copy). You run it from
**Telegram**: send a video or a link, tap ✅ Publish.

Your existing Pages site (`/admin`, D1, `functions/`) is a separate app and is
not affected by anything here.

---

## 0. What you need

- Node.js 18+ on the machine you deploy from (or the Cloudflare dashboard, but
  Wrangler is faster)
- A **new bot** from [@BotFather](https://t.me/BotFather) — **not** the bot your
  Pages site already uses. Telegram allows one webhook per bot token, so reusing
  it will silently cut the site's bot off.
- Nothing paid. Workers KV's free allowance (100k reads / 1k writes per day,
  1 GB) is far above a small catalogue and needs no billing profile.

---

## 1. Create the KV namespace

```sh
cd worker
npx wrangler login
npx wrangler kv namespace create VIDEOS
```

Copy the printed `id` into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "VIDEOS"
id = "the-id-you-just-got"
```

## 2. Set the secrets

```sh
npx wrangler secret put BOT_TOKEN        # the NEW bot's token from @BotFather
npx wrangler secret put WEBHOOK_SECRET   # any long random string (letters + digits)
npx wrangler secret put ADMIN_TOKEN      # any long random string — only used by /api/admin
```

`ADMIN_TOKEN` is optional: without it `/api/admin/*` always answers 401. The bot
itself does not need it.

Optional but recommended, in `wrangler.toml` under `[vars]`:

```toml
[vars]
ALLOWED_USER_IDS = "your-telegram-user-id"
```

If you skip it, **the first person to send `/start` becomes the owner** — fine if
that is you, but don't leave the bot unclaimed in a chat with strangers.

## 3. Deploy

```sh
npx wrangler deploy
```

Wrangler prints the URL, e.g.
`https://bootymansion-catalogue.<your-subdomain>.workers.dev`. Open
`.../health` — it should read `AfterDark Telegram bot worker: ok`.

## 4. Point the bot at it

Use the **new** bot's token and your actual worker URL:

```sh
curl "https://api.telegram.org/bot<NEW_BOT_TOKEN>/setWebhook" \
  -d "url=https://bootymansion-catalogue.<your-subdomain>.workers.dev/telegram/webhook" \
  -d "secret_token=<WEBHOOK_SECRET>" \
  -d 'allowed_updates=["message","channel_post","edited_message","callback_query"]'
```

`callback_query` is what makes the ✅ Publish / Edit buttons work — leave it in.

Verify:

```
https://api.telegram.org/bot<NEW_BOT_TOKEN>/getWebhookInfo
```

The `url` must match exactly and `pending_update_count` should fall to 0.

## 5. Smoke test in Telegram

| Action | Expected |
| --- | --- |
| `/start` | claims ownership (first run) and prints the help menu |
| send a video (≤ 20 MB) | published immediately |
| send a page link | scraping starts → a review card with ✅ Publish / ✏️ Edit / 🏷 Category / ❌ Cancel |
| `/videos` or `/list` | everything published, with Rename / Delete |
| `/pending` | drafts waiting for review |
| `/remove <id>`, `/rename <id> <title>` | unpublish / rename |
| `/id` | your Telegram user id |
| `/caption` | whether the AI caption agent is on |

`GET /api/videos` on the worker should then list the published items.

## 6. How your site would read it (not wired up yet)

The feed is public and CORS-enabled (`Access-Control-Allow-Origin: *`), so your
site can fetch it cross-origin — but the field names differ from the D1 rows
`index.html` currently maps, and playback goes through the worker's proxy:

| Worker feed | Your site expects |
| --- | --- |
| `thumbUrl` | `thumbnail_url` |
| `streamUrl` | `video_url` |
| `sourceUrl` (embeds only) | `embed_url` |
| `durationSec` (number) | `duration` (`"m:ss"` string) |
| `views` (number) | `views` (string) |
| `category` / `tags` | `tag` |

Nothing in the site points at the worker today. If you want the site to render
this catalogue instead of D1, that is a small change behind a config constant
(defaulting to the current behaviour) — ask and I'll wire it.

## 7. Behaviour worth knowing

- **Bots can only download 20 MB.** Videos larger than that are registered but
  not published to the feed; the bot tells you when it happens. Scraped links are
  different: they are *referenced*, never uploaded, so size does not matter.
- **No storage cost.** Scraped files play through the worker's streaming proxy
  from wherever they already live.
- **Workers AI is optional.** Without the `[ai]` binding the worker publishes with
  its built-in fallback caption instead of an AI-written one.
- **Accounts the bot may publish from:** anything in `ALLOWED_USER_IDS`, plus
  channel posts from `ALLOWED_CHANNEL_IDS` when added.

## 8. If something is wrong

| Symptom | Check |
| --- | --- |
| `/health` 404 | you opened the wrong host, or the deploy failed |
| Bot silent | `getWebhookInfo` → `last_error_message`; a `401` means the `secret_token` in `setWebhook` doesn't match `WEBHOOK_SECRET` |
| "Send /start first" | ownership was never claimed — send `/start` |
| Feed looks stale | the feed is memoised for 60 s (`FEED_MEMO_MS`); publishes invalidate it, view counts can lag |
| Buttons do nothing | `setWebhook` was missing `callback_query` in `allowed_updates` |
