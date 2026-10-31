# BootyMansion.github.io
For hosting videos

## Running this project

This is a static video site: the page, styles and player are all in `index.html`,
and the editable video list is in `videos.js`. No third-party packages, database,
or secrets are required to run it.

Click **Run** to start the **Start application** workflow and view the site in
Preview. The workflow runs:

```sh
python3 server.py
```

The server listens on `0.0.0.0:5000`, serves `/` and `/index.html`, serves the
video list at `/videos.js`, and serves the brand images under `/assets/`. It
disables caching so refreshing Preview picks up page edits; other workspace files
are not publicly served.

## Adding videos

Add entries to the exported `videos` list in `videos.js`:

```js
{ title: "My video", url: "https://videy.co/v?id=XXXXXXXXX" }
```

Only `title` and `url` are required. Optional fields — `thumb`, `creator`,
`views`, `duration`, `category`, `posted`, `tag`, `description` and
`format: "short"` — appear automatically when provided. The schema is documented
at the top of `videos.js`.

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
  `[data-theme="light"]` overrides it (`#FAFAFB` page, white cards, `#E11D48`
  rose). Thumbnail captions stay white over the dark gradient in both modes.
- To re-skin light mode, edit only the `[data-theme="light"]` block.

## Branding and links

Everything is configured at the top of the script block in `index.html`:

- `SITE_NAME` — visible logo/footer text plus the SEO title and meta tags.
- `TELEGRAM_URL` — every Telegram button. Left empty, the buttons are visible but
  inactive; paste `https://t.me/yourchannel` to activate them.
- `SMARTLINK_URL` — optional Adsterra Smartlink used by the sponsored spots.
- `socialLinks` — the Follow section links.

## Advertising

Ad slots keep their original IDs so existing snippets drop in unchanged:

- `#adsterra-rectangle` — 300×250 under "Up next".
- `#adsterra-leaderboard` — 728×90 above the curated rows (desktop only).
- `#adsterra-native` — native banner above the Follow section.
- `[data-smartlink]` — hero offer, sponsored strip, sponsored grid cards and the
  footer link.

Paste each snippet inside its `<aside>` in `index.html` and delete the two
placeholder label spans. Analytics can be pasted into the marked comment in
`<head>`.

Google Fonts and hosted videos require an internet connection.
