# Admin setup — Cloudflare Pages, D1, R2 and the Telegram bot

This is the phone-friendly setup guide. Everything below can be done in a phone
browser; no terminal is required for the normal path.

You are turning the site from "a list of videos in a file" into "a small app with
a private admin page and a database":

| Piece | What it does |
| --- | --- |
| `admin/index.html` (served at `/admin`) | Private control panel: add / edit / delete videos, upload thumbnails, set featured + pinned, edit settings. `noindex`, not linked anywhere. |
| `functions/` | Cloudflare Pages **Functions** — the server code behind `/api/*`. This is where the password check, database and uploads live. |
| **D1** (binding `DB`) | Stores the video list, the site settings and login-throttle counters. |
| **R2** (binding `MEDIA`) | Stores uploaded thumbnails and Telegram video files. |
| Telegram bot | Send a link, a photo, or a small video from your phone and it appears on the site. |

Nothing here needs a credit card for normal use: D1, R2 and Pages all have a
free tier that is far above a small site's usage. **There are no payments,
subscriptions or checkout anywhere in this project.**

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
5. Add it for **Production** (and **Preview** if the option is shown).

You do **not** need to run any SQL. The Functions create the `videos`,
`settings` and `login_attempts` tables automatically on the first request.
(`schema.sql` is the same schema, for anyone who prefers `wrangler d1 execute`.)

---

## Part 3 — Create the bucket (R2) and bind it as `MEDIA`

1. Dashboard → **R2 → Overview → Create bucket**.
2. Name it `bootymansion-media` and create it. Keep it **private** — the site
   serves files through `/api/media/…`, so the bucket never needs public access.
3. Back to **Pages project → Settings → Bindings → Add → R2 bucket**.
   - **Variable name:** `MEDIA`
   - **R2 bucket:** `bootymansion-media`

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

---

## Part 6 — Sign in to the admin

1. Open `https://YOUR-SITE.pages.dev/admin` (or `https://yourdomain.com/admin`).
   There is no link to it anywhere on the site, and it asks search engines not to
   index it.
2. Type your `ADMIN_PASSWORD` → **Sign in**.
3. You get a 12-hour session in an `HttpOnly`, `Secure`, `SameSite` cookie.

**Wrong password five times in fifteen minutes from the same IP → 15 minute
lockout.** Wait it out, or clear the row in the `login_attempts` table.

### Adding a video — the two ways

**A. Paste a link.** Tap **+ Add video**, put the link in **Embed link** (a player
page, e.g. `https://.../embed/abc`) or in **Video URL** (a real file, `.mp4` or a
Videy share link). Fill the title, tap **Save**.

**B. Thumbnail + video URL.** Same form: tap **Upload** next to *Thumbnail* to
send a JPG/PNG/WebP/GIF (max 5 MB) to R2, **or** paste an image link. Put the
playable file in **Video URL**. Tap **Save**.

Use **either** a video URL **or** an embed link — not both.

- **Feature** makes a video the big hero player (only one at a time).
- **Pin** keeps a video at the top of the lists.
- The search box filters by title, creator, tag and id.
- **Delete** removes the row. Files already in R2 are left alone, so delete those
  in the R2 tab if you want the space back.
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
   list - Show the newest videos
   delete - Delete a video by id
   feature - Make a video the featured one
   help - Show upload instructions
   ```

### 7b. Find your numeric user id

Message **@userinfobot** (or **@RawDataBot**) and copy the `id` number it replies
with — a long number, not a @username.

### 7c. Fill in the three bot secrets

In **Settings → Variables and Secrets**:

- `TELEGRAM_BOT_TOKEN` = the BotFather token
- `ADMIN_TELEGRAM_IDS` = your numeric id (comma-separated for more people)
- `TELEGRAM_WEBHOOK_SECRET` = a random letters-and-numbers string, e.g.
  `k7Qm2Zx9TpR4`

Save, then **retry the deployment** (Part 5).

### 7d. Point Telegram at your site

Open this URL in your phone browser, replacing `TOKEN` and `SECRET`
(`SECRET` is your `TELEGRAM_WEBHOOK_SECRET`, written twice):

```
https://api.telegram.org/botTOKEN/setWebhook?url=https://YOUR-SITE.pages.dev/api/telegram/SECRET&secret_token=SECRET
```

You should see `{"ok":true,"result":true,"description":"Webhook was set"}`.

Check it any time with `https://api.telegram.org/botTOKEN/getWebhookInfo`.

> The secret is checked **twice**: Telegram echoes it back in the
> `X-Telegram-Bot-Api-Secret-Token` header, and it is also in the URL path. Both
> must match, so random scanners posting to `/api/telegram` get a 401.

### 7e. Use it

- **Link + caption:** send
  `My video title | Creator name | 4K https://example.com/embed/abc`
  → the video is published, and the bot replies `Published ✅ My video title (#12)`.
- **Photo + caption:** the same `Title | Creator | Tag` line attached to a photo →
  the photo is saved to R2 and becomes a **draft** thumbnail entry; add the video
  link in `/admin` to publish it.
- **Video file under 20 MB:** the file is stored in R2 and published with its
  thumbnail. Bigger files get a clear "please send a smaller file or a link"
  reply.
- **Commands:** `/list` (newest 15), `/delete 12`, `/feature 12`, `/help`.
- Messages from any other Telegram account are ignored and answered with
  `⛔ This bot only accepts uploads from the site admin.`

---

## Part 8 — Testing on your computer (optional)

You need Node.js once:

```sh
npx wrangler pages dev . --d1 DB --r2 MEDIA
```

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
| Telegram says `{"ok":false,...}` | The webhook URL was truncated, or the token/secret is wrong. Call `setWebhook` again with exactly the values from Part 7. |
| Bot replies `⚠️ ...` | The message inside the warning is the real error (bad URL, missing title, oversized file). |
| Login says "Too many attempts" | Five wrong passwords in 15 minutes. Wait 15 minutes. |

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
