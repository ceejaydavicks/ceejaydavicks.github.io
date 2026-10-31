# Admin setup — Cloudflare Pages, D1 and the Telegram bot (R2 optional)

This is the phone-friendly setup guide. Everything below can be done in a phone
browser; no terminal is required for the normal path.

You are turning the site from "a list of videos in a file" into "a small app with
a private admin page and a database":

| Piece | What it does |
| --- | --- |
| `admin/index.html` (served at `/admin`) | Private control panel: add / edit / delete videos, upload thumbnails, set featured + pinned, edit settings. `noindex`, not linked anywhere. |
| `functions/` | Cloudflare Pages **Functions** — the server code behind `/api/*`. This is where the password check, database and uploads live. |
| **D1** (binding `DB`) | Stores the video list, the site settings and login-throttle counters. |
| **R2** (binding `MEDIA`) — **optional** | Only for files you upload from `/admin` (or send to the bot as a download). The bot's automatic paths never need it: scraped videos and posters are linked where they already live. R2 is a paid product (a billing profile is required even inside its free allowance), so the whole guide works without it. |
| Telegram bot | Send a link, a photo, or a small video from your phone and it appears on the site. |

**D1 and Pages are free for a site this size, and the Telegram bot needs nothing
else.** R2 needs a billing profile even inside its free allowance, so it is
treated here as optional and is skipped in Part 3 unless you want file uploads.
**There are no payments, subscriptions or checkout anywhere in this project.**

---

## Part 1 — Push the code and let Cloudflare build it

1. Merge this branch into `main` (or push to the branch your Pages project
   watches).
2. Open **dash.cloudflare.com** → **Workers & Pages** → your Pages project.
3. Watch **Deployments**. When the newest deployment says **Success**, the
   Functions in `functions/` are live. The site will still show the bundled
   sample videos until the database exists — that is expected.

> If you have never connected the repo: **Workers & Pages → Create → Pages →
> Connect to Git**, pick the repository, leave the build command **empty**, and
> set the build output directory to `/`.

---

## Part 2 — Create the database (D1) and bind it as `DB`

1. In the Cloudflare dashboard open **Workers & Pages → D1 SQL database**.
2. Tap **Create** (or **Create database**), name it `bootymansion`, and create it.
3. Go back to **Workers & Pages → your Pages project → Settings → Bindings**.
4. Tap **Add → D1 database**.
   - **Variable name:** `DB`  ← exactly this, capital letters
   - **D1 database:** `bootymansion`
5. Add it for **Production** — and repeat it for **Preview** if your project
   offers that tab (branch/preview deployments read their own bindings).

> **Do not put `pages_build_output_dir` in `wrangler.toml`.** Cloudflare's docs
> are explicit: once that key exists, the file becomes the *source of truth* for
> the project and the bindings you add here are no longer applied — the Functions
> then start with no `env.DB`/`env.MEDIA` and `/admin` login answers
> **500**. This repo deliberately leaves the key out so the dashboard stays in
> charge (see the comments at the top of `wrangler.toml`).

You do **not** need to run any SQL. The Functions create the `videos`,
`settings` and `login_attempts` tables automatically on the first request.
(`schema.sql` is the same schema, for anyone who prefers `wrangler d1 execute`.)

---

## Part 3 (optional) — The R2 bucket (`MEDIA`)

> **Skip this part if you do not want R2.** Without the `MEDIA` binding the
> automatic paths keep working — scraped videos are played from the source site,
> channel videos are Telegram embeds, and thumbnails use the page's own image.
> You only lose *file uploads*: the `/admin` upload buttons and downloading a
> ≤ 20 MB video sent to the bot. Everything else is unaffected, and
> `/api/health` simply reports `mediaBinding: false`.

1. Dashboard → **R2 → Overview → Create bucket**.
2. Name it `bootymansion-media` and create it. Keep it **private** — the site
   serves files through `/api/media/…`, so the bucket never needs public access.
3. Back to **Pages project → Settings → Bindings → Add → R2 bucket**.
   - **Variable name:** `MEDIA`
   - **R2 bucket:** `bootymansion-media`
   - Add it for **Production** (and **Preview**, same as the D1 binding).

---

## Part 4 — Add the secrets

**Pages project → Settings → Variables and Secrets → Add.** Add each of these as
type **Secret** (not "Text"), then **Save**:

| Name | Value | Needed? |
| --- | --- | --- |
| `ADMIN_PASSWORD` | The password you will type on `/admin`. Use 16+ random characters. | **Yes** |
| `SESSION_SECRET` | A long random string (32+ characters). Signs the session cookie. If you skip it, `ADMIN_PASSWORD` is used instead. | Recommended |
| `ADMIN_TELEGRAM_IDS` | Your Telegram numeric user id (see Part 6). Comma-separate several. | For the bot |
| `TELEGRAM_BOT_TOKEN` | The token @BotFather gives you. | For the bot |
| `TELEGRAM_WEBHOOK_SECRET` | A random string, letters and numbers only. | For the bot |
| `TELEGRAM_CHANNEL` | Your **public** channel as `@username` (Part 7b). Without it the bot can only publish videos up to 20 MB. | For the bot |
| `SCRAPE_MIRROR` | `on` copies scraped files **and** their posters into R2 instead of linking them (needs the `MEDIA` binding). **Off by default — the bot needs no R2.** | Optional |
| `SCRAPE_MIRROR_MAX_MB` | Only used when `SCRAPE_MIRROR=on`: largest scraped file copied into R2, in MB (default `90`). Bigger files are linked, not copied. | Optional |
| `SCRAPE_ALLOW_PAGE` | `on` also publishes a scraped page whose player could not be read, as an iframe of the page. Off by default. | Optional |

Tip for a random string on a phone: open a password generator, or just mash the
keyboard for ~40 characters. Never reuse your admin password as the webhook
secret.

> **No secret ever reaches the browser.** The page only ever sees `/api/...`
> responses; the password, bot token and session key stay inside the Functions.

---

## Part 5 — Redeploy so the bindings take effect

Settings changes apply to the **next** deployment:

1. **Deployments** tab → the newest deployment → **⋯ → Retry deployment**
   (or push any tiny commit).
2. Wait for **Success**.
3. Open `https://YOUR-SITE.pages.dev/api/health` — this page exists for exactly
   this moment. It reports, without revealing any secret:

   ```json
   {
     "ok": true,
     "deployment": { "environment": "production", "branch": "main",
                     "commit": "b1c2d3e", "url": "https://…boootymansion.pages.dev" },
     "checks": { "adminPassword": true, "sessionSecret": true,
                 "dbBinding": true, "mediaBinding": true, "telegram": false },
     "database": { "reachable": true, "schemaReady": true, "videoCount": 0 },
     "notes": [],
     "error": null, "hint": null
   }
   ```

   `"ok": true` means sign-in will work. If something is `false`, `error` and
   `hint` name the missing binding/secret and where to add it. `deployment` says
   which build answered — production or **preview**, which branch, which commit —
   which is how you confirm a "Retry deployment" actually took effect.
   `notes` explains optional gaps (no `SESSION_SECRET`, no R2 bucket, bot not
   finished) that do **not** block the admin. This is the first place to look for
   **any** admin problem.

---

## Part 6 — Sign in to the admin

1. Open `https://YOUR-SITE.pages.dev/admin` (or `https://yourdomain.com/admin`).
   There is no link to it anywhere on the site, and it asks search engines not to
   index it. If sign-in ever fails, open `/api/health` first — the login card also
   links to it.
2. Type your `ADMIN_PASSWORD` → **Sign in**.
3. You get a 12-hour session in an `HttpOnly`, `Secure`, `SameSite` cookie.

**Wrong password five times in fifteen minutes from the same IP → 15 minute
lockout.** Wait it out, or clear the row in the `login_attempts` table.

### Adding a video — three ways

**A. Paste a link.** Tap **+ Add video**, put the link in **Embed link** (a player
page, e.g. `https://.../embed/abc`) or in **Video URL** (a real file, `.mp4` or a
Videy share link). Fill the title, tap **Save**. A Telegram post link pasted as
`t.me/yourchannel/123` is converted to an embed automatically.

**B. Upload the file from your phone.** **+ Add video** → **Upload video** (next
to *Video URL*) → pick an MP4, WebM or MOV **up to 95 MB**. The file streams into
your R2 bucket and plays from your own domain, with seeking support. While it
uploads the panel reads the file's metadata and fills in the **duration** and
**orientation** for you, and grabs a frame from the video to use as the
**thumbnail** (delete it or replace it if you prefer another image).

**C. Thumbnail + video URL.** Same form: tap **Upload** next to *Thumbnail* to
send a JPG/PNG/WebP/GIF (max 5 MB) to R2, **or** paste an image link. Put the
playable file in **Video URL**. Tap **Save**.

Use **either** a video URL **or** an embed link — not both.

**Why 95 MB?** Cloudflare rejects any request body over 100 MB (Free and Pro
plans), so 95 MB keeps a safe margin. For anything bigger, use the Telegram
channel (Part 7b): the file goes to Telegram's servers, never through your
Worker, and the site plays it with Telegram's own player.

- **Feature** makes a video the big hero player (only one at a time).
- **Pin** keeps a video at the top of the lists.
- The search box filters by title, creator, tag and id.
- **Delete** removes the row. Files already in R2 are left alone, so delete those
  in the R2 tab if you want the space back. If the video came from your Telegram
  channel, its channel post is deleted too — one delete, everywhere gone.
- A row with no video URL *and* no embed link is a **Draft**: it stays in the
  admin list but never appears on the public site.

### Settings tab

- **Site name** — used in the logo, footer, page title and meta tags.
- **Telegram link** — fills in every "Join on Telegram" button. Empty = buttons
  stay inactive.
- **Ad slots** — banner code, native card code, smartlink URL + code. Paste the
  network's snippet exactly as they give it. **An empty slot disappears from the
  page completely**, and there are only ever three slots.

---

## Part 7 — The Telegram bot

### 7a. Create the bot

1. In Telegram, message **@BotFather** → `/newbot` → choose a name and a username
   ending in `bot`.
2. Copy the **token** (looks like `123456789:AAE...`).
3. Still in @BotFather: `/setcommands` → pick your bot → paste:

   ```
   scrape - Scrape a page link
   list - Show the newest videos
   delete - Delete a video by id
   feature - Make a video the featured one
   help - Show upload instructions
   ```

### 7b. Create your public channel (this is what removes the 20 MB limit)

Telegram only lets a **bot** download 20 MB, but your own account can post files
up to 2 GB (4 GB with Premium). So the videos live in a channel and the site
embeds them — any size, no storage cost, nothing for you to download.

1. Telegram → ☰ → **New Channel** → name it (e.g. *BootyMansion Clips*) →
   **Public** → pick a username, e.g. `boootymansion_clips`.
2. Open the channel → **Administrators** → **Add Admin** → your bot → allow
   **Post Messages** *and* **Delete Messages** (the second one lets `/delete`
   clean up the channel too).
3. Post one video with the caption `Title | Creator | Tag` to test later.
4. In **Settings → Variables and Secrets** add
   `TELEGRAM_CHANNEL` = `@boootymansion_clips`
   (a bare `boootymansion_clips` or `https://t.me/boootymansion_clips` also works).

Optional: `TELEGRAM_CHANNEL_ID` = the numeric id (`-100…`) if you want to pin the
exact channel. Keep `TELEGRAM_CHANNEL` as the `@username` anyway — the embed link
needs the public name.

> The channel must stay **public**: a private channel cannot be embedded, so the
> player would not load for visitors.

### 7c. Find your numeric user id

Message **@userinfobot** (or **@RawDataBot**) and copy the `id` number it replies
with — a long number, not a @username. Once the bot is running you can also just
send it **`/id`**, which replies with your user id, the chat id and the channel it
is configured with.

### 7d. Fill in the bot secrets

In **Settings → Variables and Secrets**:

- `TELEGRAM_BOT_TOKEN` = the BotFather token
- `ADMIN_TELEGRAM_IDS` = your numeric id (comma-separated for more people)
- `TELEGRAM_WEBHOOK_SECRET` = a random letters-and-numbers string, e.g.
  `k7Qm2Zx9TpR4`
- `TELEGRAM_CHANNEL` = `@yourchannel` (from 7b)

Save, then **retry the deployment** (Part 5).

### 7e. Point Telegram at your site

Open this URL in your phone browser, replacing `TOKEN` and `SECRET`
(`SECRET` is your `TELEGRAM_WEBHOOK_SECRET`, written twice):

```
https://api.telegram.org/botTOKEN/setWebhook?url=https://YOUR-SITE.pages.dev/api/telegram/SECRET&secret_token=SECRET&allowed_updates=["message","channel_post","edited_message"]
```

The `allowed_updates` part matters: without `channel_post` Telegram never tells
your site about new channel posts, and videos posted in the channel silently do
nothing.

You should see `{"ok":true,"result":true,"description":"Webhook was set"}`.

### The easy way: let the site register itself

Once `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` are saved and the
deployment is retried, open this on your phone:

```
https://YOUR-SITE.pages.dev/api/telegram/setup?secret=SECRET
```

It reports what Telegram says about your bot — whether the token works, which
webhook URL is registered, how many updates are queued and the last delivery
error — next to what this deployment expects, and lists what to fix. That page is
the fastest way to answer "why is my bot not posting?".

To register the webhook from the site instead of pasting the long `setWebhook`
URL, send a **POST** to the same address (a browser will not do that, so use
`curl` or a REST client):

```sh
curl -X POST "https://YOUR-SITE.pages.dev/api/telegram/setup?secret=SECRET" \
  -H "content-type: application/json" -d '{"drop_pending_updates":true}'
```

It sets the URL, the `secret_token` and `allowed_updates` for you. `secret` can
also be sent as the `X-Telegram-Bot-Api-Secret-Token` header instead of in the
query string.

Check it any time with `https://api.telegram.org/botTOKEN/getWebhookInfo`.

> The secret is checked **twice**: Telegram echoes it back in the
> `X-Telegram-Bot-Api-Secret-Token` header, and it is also in the URL path. Both
> must match, so random scanners posting to `/api/telegram` get a 401.

### 7f. Use it

**Post a video in the channel** (from your phone, any size up to Telegram's
2 GB / 4 GB limit), caption it `Title | Creator | Tag` → the bot publishes it
instantly as a Telegram embed and stores the poster frame as its thumbnail. No
reply clutter: it only speaks up if something went wrong.

**Or send the video to the bot in a DM**, any size: the bot copies it into the
channel (`copyMessage`, a server-side copy — nothing is downloaded) and publishes
it the same way, replying `Published ✅ Poolside (#12)`.

- **Any page link (the automatic path):** paste a link to a video page and just
  send it — no caption needed. The bot fetches the page, reads the title, poster,
  duration and player (Open Graph tags, schema.org `VideoObject` data, `<video>`
  and `<source>` tags, iframe players, JS player configs, WordPress's REST API)
  and publishes what it finds. A **listing page** publishes every video on it, up
  to 12 per message — Cloudflare limits outbound requests per invocation, so the
  bot stops there and tells you. You get one line per video,
  `Published ✅ Title (#12, file)`.
  - **Nothing is stored by default.** The video plays from the source site's own
    URL and the poster uses the page's own image — **no R2, no storage cost, no
    extra setup**. The trade-offs: a host that blocks hotlinking (or later deletes
    the file) can break playback, and you cannot control how long it survives.
  - **Want the file on your own domain instead?** Bind R2 (`MEDIA`) and set
    `SCRAPE_MIRROR` = `on`: each scraped file up to `SCRAPE_MIRROR_MAX_MB`
    (default 90 MB) and its poster is copied into `/api/media/…`, so the source
    can no longer break it. Bigger files are linked and the reply says so.
  - **Links in the channel** are scraped the same way and published **silently**
    — the channel stays free of bot chatter, and you get a DM only if something
    fails.
  - **A direct video file link** (`…/clip.mp4`) needs no page: it is published
    under the file name, linked (or copied when mirroring is on).
  - **Duplicates are skipped**, keyed on the page the row came from
    (`source_url`), so pasting the same link twice answers
    `⏭️ Already on the site as #12` instead of adding a second row.
- **Link + caption:** `My video title | Creator name | 4K https://example.com/embed/abc`
  → the caption wins for a single link, published and answered with
  `Published ✅ … (#12)`. Without a caption the scraped title is used.
- **Photo + caption:** the photo is saved to R2 and becomes a **draft** thumbnail
  entry; add the video link in `/admin` to publish it.
- **Video under 20 MB with no channel configured:** stored in R2 and published
  directly (the old behaviour, still supported).
- **Commands:** `/scrape <url>` (scrape now), `/list` (newest 15),
  `/delete 12` (also deletes the channel post), `/feature 12`, `/id`, `/help`.
- Messages from any other Telegram account are ignored and answered with
  `⛔ This bot only accepts uploads from the site admin.` Posts in any other
  channel are ignored silently.

Every row remembers which Telegram message it came from, so a webhook Telegram
retries cannot publish the same video twice. Scraped rows remember the page they
came from (`source_url`) instead, and are deduped on it.

Telegram's retry rule also means **one channel post produces one row**: put a
single video per channel message. A link post is the exception — every video the
scraped page lists becomes its own row.

---

## Part 8 — Testing on your computer (optional)

You need Node.js once:

```sh
npx wrangler pages dev . --d1 DB --r2 MEDIA
```

The leading `.` is the static output directory. Wrangler may print *"A Wrangler
configuration file was found but it does not appear to be valid… skipping"* —
that is expected and harmless: the file is kept out of Pages' hands on purpose so
the dashboard bindings stay in charge (Part 2).

Put the secrets in a `.dev.vars` file in the project root (it is already in
`.gitignore`, so it is never committed):

```
ADMIN_PASSWORD=localtest123
SESSION_SECRET=local-development-secret
```

Then open `http://localhost:8788/admin`. `python3 server.py` still serves the
static site on port 5000 for design work; it has no database, so `/api/*` there
answers with a note explaining that.

---

## Part 9 — If something goes wrong

| What you see | Fix |
| --- | --- |
| `/admin` shows "Admin login is not configured" | `ADMIN_PASSWORD` is missing, or you did not redeploy after adding it. |
| "Missing D1 binding named DB" | The D1 binding is not named exactly `DB`, or the deployment predates the binding. Fix the binding, retry the deployment. |
| Videos you add never appear on the site | The row has no video URL and no embed link (draft), or the browser cached the list for 30 s — refresh. |
| "R2 bucket is not configured (binding MEDIA)" | Same as above, for the R2 binding. |
| Upload says "Use a JPG, PNG, WebP, GIF or AVIF image" | The file is a HEIC screenshot. Convert it to JPG first. |
| A video posted in the channel never appears | Three usual causes: the bot is not a channel **admin** (Part 7b step 2); `TELEGRAM_CHANNEL` does not match the channel's `@username`; the webhook was set without `channel_post` in `allowed_updates` (Part 7e). Send `/id` to the bot to see what it thinks the channel is. |
| The Telegram embed shows an "Open in Telegram" card instead of a player | The channel is private, or the post is not a video. Telegram only embeds **public** channels. |
| **Upload video** fails with "over 95 MB" | Cloudflare refuses request bodies above 100 MB. Send that video to the Telegram bot instead — the channel path has no practical limit. |
| A video plays but stutters or will not seek on iPhone | `/api/media/…` serves `Accept-Ranges` and answers `206 Partial Content`, so this should be fixed; if you still see it, check that the file is an MP4 with `faststart` (moov atom at the front) or re-upload it. |
| Telegram says `{"ok":false,...}` | The webhook URL was truncated, or the token/secret is wrong. Call `setWebhook` again with exactly the values from Part 7. |
| Bot replies `⚠️ ...` | The message inside the warning is the real error (bad URL, missing title, oversized file). |
| Login says "Too many attempts" | Five wrong passwords in 15 minutes. Wait 15 minutes. |
| Login says **"Request failed (500)"** | A Function threw before it could answer — almost always a binding the deployment cannot see. Open `/api/health`: it names the missing piece. Do **not** add `pages_build_output_dir` to `wrangler.toml` to "fix" it; that is what makes the dashboard bindings stop applying. |
| The binding is listed in the dashboard but `/api/health` says `"dbBinding": false` | `wrangler.toml` contains `pages_build_output_dir` (the file then overrides the dashboard), or the binding was added only to the other environment, or the deployment predates the binding. Remove the key / add the binding for this environment / retry the deployment. |
| Build fails with `Invalid Pages function route parameter` | A Functions filename used Next.js rest syntax. Cloudflare Pages route parameters must be a **single path segment** with a name made of letters, digits or `_` — e.g. `[id].js`, `[folder]/[file].js`, `[secret].js`. `[...key].js` is rejected; the only catch-all Pages accepts is the double-bracket `[[path]].js`. |

---

## Security notes (what is already handled)

- Secrets live only in Cloudflare environment variables — never in HTML, JS or
  the repo.
- The session cookie is `HttpOnly` (not readable by scripts), `Secure` (HTTPS
  only) and `SameSite`, so a third-party site cannot ride your login.
- Every admin write also requires the `x-requested-with: admin` header and a
  same-origin `Origin`, which blocks form-based CSRF.
- Login attempts are rate limited in D1 (5 failures → 15 minute block per IP).
- All text is stripped of `<`, `>` and control characters on the way in, and
  escaped again on the way out; URLs must be `http(s)` (or an `/api/media/…`
  path), so no `javascript:` links can be stored.
- Ad snippets are the one exception: they are HTML by design, length-limited, and
  only an admin can save them.
- `/admin` is `noindex, nofollow` and has no links pointing at it.
