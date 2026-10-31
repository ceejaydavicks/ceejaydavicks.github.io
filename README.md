# BootyMansion.github.io
For hosting videos

## Running this project

This is a video site with an optional private admin. The page, styles and player
are all in `index.html`; the video library is served by a small Cloudflare Pages
Functions API (`functions/api/videos.js`) backed by a D1 database, and managed
from `/admin`. Without a backend the site still runs as a plain static page and
falls back to the sample library in `videos.js`.

Click **Run** to start the **Start application** workflow and view the site in
Preview. The workflow runs:

```sh
python3 server.py
```

The server listens on `0.0.0.0:5000`, serves `/` and `/index.html`, the admin
page at `/admin`, the video list at `/videos.js`, and the brand images under
`/assets/`. It disables caching so refreshing Preview picks up page edits; other
workspace files are not publicly served. `/api/*` answers with a short JSON note
explaining that the real API runs on Cloudflare — see **[SETUP.md](SETUP.md)** for
the deploys, D1 database, R2 bucket, secrets and Telegram bot.

## Adding videos

### From the admin (the normal way)

Open `/admin` on the deployed site, sign in, and tap **+ Add video**. There are
two flows: paste an embed/video link, or upload a thumbnail to R2 and paste the
video URL. **Duration** accepts `mm:ss` (or `42s`, `1m 5s`) and decides whether
the clip becomes a Short — see [Shorts](#shorts-under-a-minute).
**Feature** and **Pin** control the hero player and list order, the
search box filters the list, and the **Settings** tab edits the site name,
Telegram link and the three ad slots.

The admin writes to D1 (`videos`, `settings`, `login_attempts`) through these
Functions:

| Route | Who can use it |
| --- | --- |
| `GET /api/videos` | public — published videos only |
| `GET /api/videos?all=1` | admin — includes drafts |
| `POST /api/videos` | admin |
| `PUT` / `PATCH` / `DELETE /api/videos/:id` | admin |
| `GET /api/settings` | public — site name, Telegram link, ad slots |
| `PUT /api/settings` | admin |
| `POST /api/upload` | admin — thumbnail (multipart, ≤ 5 MB) or video (raw body, ≤ 95 MB) → R2 |
| `GET /api/media/<folder>/<file>` | public — streams R2 files, `Accept-Ranges` + `206 Partial Content` so `<video>` can seek |
| `POST /api/login`, `POST /api/logout`, `GET /api/session` | password / session |
| `GET /api/health` | public — deployment diagnostics: which binding or secret is missing (booleans only, never a value) |
| `POST /api/telegram`, `POST /api/telegram/<secret>` | Telegram webhook (secret + admin allowlist) |
| `GET /api/telegram/setup` | secret — what Telegram reports about this bot (token valid, registered webhook, queued updates, last delivery error) next to what the deployment expects, plus the hints for whatever does not match |
| `POST /api/telegram/setup` | secret — registers the webhook with the right `secret_token` and `allowed_updates` |

### How a video gets in

| Route | Size | Where it lives |
| --- | --- | --- |
| **/admin → Upload video** | ≤ 95 MB | R2 (optional binding), played from your own domain (`/api/media/videos/…`) |
| **Telegram: post in the channel** | any (2 GB / 4 GB Premium) | Telegram, embedded with `t.me/…?embed=1` |
| **Telegram: send the video to the bot** | any | copied into the channel server-side, then embedded |
| **Telegram: paste a page link** | scraped | linked from the source site, no storage needed (optional R2 copy with `SCRAPE_MIRROR=on`, ≤ 90 MB) |
| **/admin → Video URL / Embed link** | — | wherever the link points |

Cloudflare rejects a request body over 100 MB, which is why the panel stops at
95 MB and the Telegram channel exists for everything larger.

The public page loads `/api/videos` and `/api/settings` on boot. If the API is
**unreachable** (static hosting, `server.py`) it falls back to `videos.js`; if the
API is **empty** it shows the "library opens soon" state instead of fake cards.

### From the Telegram bot Worker (Workers KV)

The bot in `worker/` keeps its own catalogue in Workers KV, separate from D1. The
public page merges that feed into the same grid, so a video published from the bot
appears on the site without touching the database.

The feed URL is one constant near the top of the module script in `index.html`:

```js
const BOT_FEED_URL = "https://<your-worker>.workers.dev/api/videos";
```

- Set it to your Worker and bot videos are shown first (they are the newest), with
  the Worker's streaming proxy as the playable URL and its thumbnail proxy as the poster.
- Set it to `""` to switch the merge off and use the site's own catalogue only.
- If the Worker is unreachable the page still renders normally — the merge is a
  third parallel request and a failure only logs a warning.
- Rows that look like the same file or poster as a bot video are skipped, so a video
  added both ways does not appear twice.

Because the Worker sends `Access-Control-Allow-Origin: *`, this works on the
Cloudflare Pages deployment and on plain GitHub Pages alike.

### From the file (fallback / samples)

Add entries to the exported `videos` list in `videos.js`:

```js
{ title: "My video", url: "https://videy.co/v?id=XXXXXXXXX" }
```

Only `title` and `url` are required. Optional fields — `thumb`, `creator`,
`views`, `duration`, `category`, `posted`, `tag`, `description` and
`format: "short"` — appear automatically when provided. The schema is documented
at the top of `videos.js`.

### Sample library

The first 25 entries in `videos.js` are placeholders that keep every row of the
page full while the real library is being built. Their thumbnails are generated
SVGs in `assets/samples/` and their `url` values point at `example.com`, so a
sample card shows its thumbnail but cannot play — clicking one lands on the
player's "this video could not play here" fallback.

Replacing a sample with a real clip is a one-line edit: swap its `url` for a
Videy share link or a direct `.mp4`, and optionally its `thumb`. Removing an
entry shortens the page (rows hide themselves when they run out of real videos).
The original Videy upload sits at the end of the list; move it to the top if you
want it featured again.

How the list is used: the first entry is the featured video, the next three fill
"Up next", then the Vertical Shorts row, Trending Now and the Mixed Feed are
filled in order. Rows with no videos left are hidden automatically instead of
showing placeholder content, and every card in the page is generated from this
file — so new uploads appear without touching the HTML. `category` values become
the filter chips, and the nav search matches titles, creators, descriptions and
categories.

For Videy links, the site extracts the ID and plays the matching
`https://cdn.videy.co/ID.mp4` file in its single player. Direct `.mp4` links play
as-is. If no thumbnail is provided, the site requests video metadata to display a
frame at 0.5 seconds and to label the real duration. The main video file loads
only when a visitor taps a thumbnail. If playback fails, the player offers the
original video page link.

## Video grid (Mixed Feed + Full library)

The feed and the "View all" library use one masonry component (`.grid-feed`), so
both look the same. Cards are never cropped on desktop: each thumbnail takes the
video's own aspect ratio — vertical 9:16 clips stay tall, 16:9 clips stay wide —
read from the thumbnail image or from the video metadata (falling back to the
declared `format` until it loads). Each card then drops into whichever column is
shortest, so there are no gaps. Desktop uses two columns with 20px gutters and
20px corner radii; the duration sits on the thumbnail and the title and creator
sit beneath the card.

On phones (up to 767px) the same list becomes three columns with 9px gutters.
Thumbnails are cropped to a uniform 3:4, the duration badge shrinks, and the
title is truncated to one line (the creator line is hidden to keep the columns
tight). The column count lives in `masonryColumnCount()` and the matching gaps in
the `.grid-feed` media query.

Cards keep the shared poster behaviour: hover lift/zoom, lazy-loaded thumbnails
(only frames near the viewport are fetched), and the "open the original video"
fallback.

Every section is built from real rows and hidden when it has none: with a big
library the featured player takes the first release, Up next the next three,
"Recommended for you" the following eight and the feed six more. On a small
library Up next stops at one card so the grid still gets something, and Shorts
are filtered out of all of it (see below). Delete the samples and the empty rows
disappear rather than leaving gaps. The "View all" library view shows the same
masonry as soon as there are two or more videos.

## Shorts (under a minute)

A clip is a **Short** when its length is under 60 seconds. Nothing is tagged by
hand: the length decides, so an existing video can never be mistagged and a new
upload is classified the moment it lands.

- `videos.duration_seconds` (integer) is the source of truth; `videos.duration`
  keeps the `m:ss` label the cards print. Older databases are upgraded in place
  on the first request (`ALTER TABLE … ADD COLUMN duration_seconds`).
- The admin's **Duration** field accepts `0:42`, `42`, `42s`, `1m 5s`, `1h 2m 3s`
  or `PT1M5S` and shows "Short (under a minute)" or "Regular video" live as you
  type. The videos table shows the same badge per row.
- The Telegram bot reads the length from the file metadata and stores both
  values. An embed link carries no metadata, so type the duration in the admin —
  until then the clip counts as a regular video.
- The rule is strictly `< 60`. A 1:00 clip is regular, an unknown (0) length is
  regular, and orientation plays no part — a 16:9 clip under a minute is still a
  Short.
- Shorts carry a "Short" badge, fill the horizontal shelf between the hero and
  "Recommended for you" (with the scroll arrow on desktop), answer the "Shorts"
  chip in search and drive the mobile **Shorts** tab. They are removed from the
  hero, Up next, "Recommended for you" and the feed so nothing repeats.
- A Short only leads the hero when the library holds no regular video at all —
  the wide player expects a full-length release. In that case it is dropped from
  the shelf so the same clip never shows twice.

## Brand assets

- `assets/logo-lockup@3x.png` — mark + wordmark, transparent, used in the nav,
  footer and preloader (36px tall on desktop, 30px on mobile, width automatic).
- `assets/favicon-32.png` / `favicon-64.png` / `favicon-192.png` — tab icon.
- `assets/apple-touch-icon.png` — iOS home-screen icon.

Every file keeps its transparent background; the page draws no plate behind it.
To rebrand, replace these files (keep the names) or point the `img` tags in
`index.html` at new ones.

The nav, footer and preloader logos are CSS background sprites on `.brand-logo`
/ `.preloader__logo`, so a theme swap costs no extra markup: `logo-lockup@3x.png`
is the white-lettering lockup for dark mode and `logo-lockup-light@3x.png` is
the near-black-lettering lockup used when `[data-theme="light"]` is set.

## Theme (dark / light)

- Dark is the default look. A first visit follows the device
  (`prefers-color-scheme`); once someone clicks the toggle the choice is saved to
  `localStorage` under `theme` and wins on every later visit.
- The toggle is the round sun/moon button in the top-right nav (next to search and
  Telegram) and repeats inside the mobile menu. The sun shows in dark mode, the
  moon in light mode, with a cross-fade/rotate swap.
- A tiny inline script in `<head>` sets `data-theme` before the stylesheet loads,
  so there is no flash of the wrong theme (it also preloads the matching logo).
- Every colour is a CSS variable: `:root` holds the dark palette and
  `[data-theme="light"]` overrides it (`#F7F7FA` page, white cards). The light
  block re-declares colour values only — no sizes, spacing, motion or markup —
  so the two themes are pixel-for-pixel twins and the toggle never moves
  anything. Thumbnail captions stay white over the dark gradient in both modes.
- To re-skin light mode, edit only the `[data-theme="light"]` block.

### Palette (crimson-rose)

The accent is crimson-rose; the logo keeps its own purple artwork.

| Token | Dark | Light | Used for |
| --- | --- | --- | --- |
| `--bg` | `#0B0B0F` | `#F7F7FA` | page |
| `--surface` / `--surface-2` | `#15151B` / `#1B1B22` | `#FFFFFF` / `#F2F2F7` | cards, panels |
| `--line` / `--line-strong` | `#26262F` / `#33333D` | `#E4E4EC` / `#D5D5DF` | borders |
| `--text` | `#F4F4F6` | `#14141A` | body copy |
| `--muted` / `--quiet` | `#9A9AA8` / `#86869A` | `#6B6B7A` / `#686878` | secondary copy |
| `--accent` / `--accent-hi` / `--accent-deep` | `#F43F5E` / `#FB7185` / `#BE123C` | same | accent, links |
| `--accent-gradient` | `#FB7185 → #E11D48` | same | decorative fills, poster tags, preloader ring |
| `--accent-gradient-ink` | `#E11D48 → #BE123C` | same | fills carrying white text (buttons, active nav pill, active chip, Featured badge) |

- Fonts: **Plus Jakarta Sans** for headings and the logo (`--font-display`),
  **Inter** for body copy and controls (`--font-body`). Both load from Google
  Fonts with preconnects and fall back to system sans.
- The dark page carries one soft rose glow: `--ambient`, a radial
  `rgba(244,63,94,.18)` in the top-right corner, drawn by `.ambient`.
- `--accent-gradient` is the bright ramp from the brief; `--accent-gradient-ink`
  is the same family, darkened, and is used wherever small white text sits on the
  fill so contrast stays ≥ 4.5:1 (white on `#FB7185` is only 2.6:1).
  `--rose*` stay as aliases of the accent so older rules keep resolving.
- Fixed surfaces never flip: `--player-bg` (`#08080C`) keeps the video stage
  dark in both themes, and `--banner-bg` / `--banner-text` / `--banner-muted`
  keep the 18+/Telegram banner on its own rose-black card.
- **Telegram is never the accent.** `--tg: #229ED9` and `--tg-hover: #1C8CC2` are
  declared once in `:root` and never overridden, so every Telegram control — nav
  button, `.hero-follow`, `.btn-telegram`, the footer pill, the rail icon — stays
  Telegram blue with a white plane and white text in both themes.
- The legal pages (`assets/legal.css`) and `/admin` mirror the same palette and
  read the same saved/device theme, so a light-mode visitor gets light legal and
  admin pages too. The age gate (`assets/age-gate.js`) keeps its styles inline
  and uses the same `#0B0B0F` / `#26262F` / rose-gradient values. In `/admin`, `--danger` stays
  red on purpose: it marks destructive actions, not the brand accent.
- Contrast was checked section by section in both themes: body copy ≥ 16:1,
  muted ≥ 6.5:1 (dark) / ≥ 4.9:1 (light), quiet ≥ 4.8:1 (≥ 4.9:1 on nested
  surfaces), white on the ink
  gradient ≥ 4.7:1. `--quiet` and the light-theme link rose are the tightest
  pairs and are the ones to re-check after any palette change.

## Branding and links

Everything is configured at the top of the script block in `index.html`:

- `SITE_NAME` — visible logo/footer text plus the SEO title and meta tags.
- `TELEGRAM_URL` — every Telegram button. Left empty, the buttons are visible but
  inactive; paste `https://t.me/yourchannel` to activate them.

Both are **defaults**: when the API is live, the values saved in `/admin →
Settings` are applied on top of them.
- `AD_CONFIG` — every advertisement on the page (see below). With the API live,
  the three ad snippets come from `/admin → Settings` instead of this object.
- `socialLinks` — the Follow section links.

## Advertising

There are at most three ad placements, all driven by one `AD_CONFIG` object at
the top of the script in `index.html`:

```js
const AD_CONFIG = {
  banner:    { label: "Advertisement", code: "" },              // (a)
  native:    { label: "Advertisement", every: 8, code: "" },     // (b)
  smartlink: { label: "Sponsored", url: "", code: "" }           // (c)
};
```

- **(a) `banner`** — one responsive banner between the Vertical Shorts and
  Trending Now sections: 300×250 on phones, 728×90 from 768px up. It is the only
  banner on the page; there are no ads above the fold or inside the featured
  player.
- **(b) `native`** — one native card inside the Mixed Feed, placed after the
  `every`-th video (default 8). A feed shorter than that gets its single native
  card at the end, so the placement still appears; the card is never repeated, so
  only one ad unit is ever on the page.
- **(c) `smartlink`** — one "Sponsored" card closing the feed. Set `url` for the
  built-in text card, or `code` for a banner-style card.

Rules that are enforced in code:

- **Empty means gone.** A slot with no `code` (or, for the smartlink, no `url`)
  is removed from the layout entirely — no placeholder box and no reserved
  space. Only active slots get the small `Advertisement` / `Sponsored` label.
- **Lazy.** Ad snippets are parsed but their scripts are only executed once the
  slot comes within ~300px of the viewport, so nothing loads on first paint.
- **No layout shift.** Active slots reserve the banner's height (250px on
  phones, 90px on desktop) and the ad card's height before the ad fills in.
- **No popups, popunders or auto-redirects.** Only the snippets you paste are
  rendered; nothing opens a window on its own.
- Use asynchronous snippets. A snippet that calls `document.write` cannot work
  after load.

Analytics can be pasted into the marked comment in `<head>`.

## Age gate (18+)

`assets/age-gate.js` is loaded before any page content and shows a full-screen
dark overlay on a first visit: the logo, the required adult-content notice, an
**I am 18 or older - Enter** button and an **Exit** link to
`https://www.google.com`.

- The confirmation is remembered for **30 days** in `localStorage`
  (`ageVerifiedUntil`), with an `age_ok=1` cookie as a fallback for browsers
  that block storage.
- While it is open the page cannot be scrolled or interacted with (`inert` +
  `aria-hidden` + hidden content), focus is moved into the dialog and trapped
  there, and **Escape does not dismiss it**.
- It is responsive and keyboard/screen-reader friendly.
- Every page also carries `<meta name="rating" content="adult">` and the RTA
  label `<meta name="RATING" content="RTA-5042-1996-1400-1577-RTA">`.

## Admin, API and Telegram bot

| Path | What it is |
| --- | --- |
| `admin/index.html` | The `/admin` control panel (dark, mobile-first, `noindex`, unlinked). |
| `functions/_lib/auth.js` | Password check, signed session cookie (`HttpOnly`, `Secure`, `SameSite`, 12 h), D1 login throttle (5 failures → 15 min block). |
| `functions/_lib/db.js` | D1 access; creates the tables and default settings on first use. |
| `functions/_lib/validate.js` | Input sanitising — strips `<`, `>` and control characters, requires `http(s)` URLs. |
| `functions/_lib/telegram.js` | The bot. Videos arrive four ways: a **channel post** in `TELEGRAM_CHANNEL` (any size, published as a `t.me/<channel>/<id>?embed=1` player), a **DM**, which is `copyMessage`d into that channel first, a **page link** (scraped automatically — see `scrape.js`, linked rather than stored unless `SCRAPE_MIRROR=on`), or a **link posted in the channel**, scraped silently. Without a channel it falls back to downloading ≤ 20 MB into R2. Also `/scrape`, `/list`, `/delete` (removes the channel post too), `/feature`, `/id`. Accepts the template's `BOT_TOKEN` / `WEBHOOK_SECRET` / `ALLOWED_USER_IDS` names as fallbacks for the `TELEGRAM_*` ones. |
| `functions/_lib/scrape.js` | The link scraper: Open Graph/Twitter metadata, schema.org `VideoObject` (single videos and `ItemList` galleries), `<video>`/`<source>` tags, iframe players, JS player configs (`sources: [{ file: "…mp4" }]`), known-tube embed derivation, WordPress REST rescue and one level of iframe chasing. Returns playable items (`file` / `embed` / `page`) with title, poster and duration; no database or side effects. |
| `functions/api/telegram/setup.js` | Webhook setup and diagnosis. `GET` reports `getMe` + `getWebhookInfo` beside the expected URL; `POST` calls `setWebhook`. The secret is never echoed back. |
| `functions/api/*` | The HTTP routes listed above. Route parameters are single path segments (`videos/[id].js`, `media/[folder]/[file].js`, `telegram/[secret].js`); Next.js-style `[...param].js` filenames are rejected by Wrangler while it builds the Functions bundle. |
| `functions/_middleware.js` | Security headers on every response. |
| `schema.sql` | The same schema as `db.js`, for `wrangler d1 execute`. |
| `wrangler.toml` | Notes for local development. It is deliberately **not** a Pages config file: setting `pages_build_output_dir` would make it the source of truth and stop the dashboard's D1/R2 bindings from being applied (the header comment explains both modes). |
| `SETUP.md` | Step-by-step setup: D1, R2, secrets, @BotFather, webhook. |
| `worker/` | A verbatim copy of the AfterDark standalone Worker (KV-based, separate app), ready to deploy with your own KV + secrets — see `worker/SETUP.md`. Not part of this site build. |

Nothing in the front end ever receives a secret: the browser only talks to
`/api/*`, and the password, bot token and session key stay in Cloudflare's
environment variables.

## Legal pages

- `terms.html` — Terms of Service.
- `privacy.html` — Privacy Policy (age cookie, theme preference, advertising,
  hosting).
- `compliance.html` — 18 U.S.C. § 2257 / compliance statement, content standards
  and the RTA labelling note.

All three share `assets/legal.css`, link to each other and to the site, and are
linked from the footer of `index.html`. They are **placeholder copy** with
bracketed fields (contact email, records custodian, address) to fill in; they
also load the same age gate. `server.py` serves them at `/terms`, `/privacy` and
`/compliance` as well.

Google Fonts and hosted videos require an internet connection.
