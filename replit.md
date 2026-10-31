# Running this project

The page and player are in `index.html`; the video library normally comes from a
Cloudflare Pages Functions API (`functions/api/videos.js`) backed by D1 and
managed from `/admin`. Without a backend the site runs as a plain static page and
falls back to the sample list in `videos.js`.

Click **Run** to start the **Start application** workflow and view the site in
Preview. The workflow runs:

```sh
python3 server.py
```

The server listens on `0.0.0.0:5000` and disables caching so refreshing Preview
picks up page edits. It serves `/` and `/index.html`, the admin page at
`/admin`, the legal pages (`/terms`, `/privacy`, `/compliance`), the video list
at `/videos.js`, and the images, age-gate script and stylesheet in `/assets/`.
`/api/*` replies with a JSON note: the real API (D1, R2, Telegram bot) runs on
Cloudflare Pages — see `SETUP.md`. Other workspace files are not publicly served.

Add videos to the exported `videos` list in `videos.js` using `{ title, url }`;
`thumb` is optional. For Videy links, the site extracts the ID and plays the
matching `https://cdn.videy.co/ID.mp4` file in its single player. If no thumbnail
is provided, the site requests video metadata to display a frame at 0.5 seconds.
The main video file loads when a visitor taps a thumbnail. If playback fails,
the player offers the original video page link.

The social links remain configurable in `index.html`. The site name, Telegram
link and the three ad slots are edited in `/admin → Settings`; the values in
`index.html` (`SITE_NAME`, `TELEGRAM_URL`, `AD_CONFIG`) are the defaults used
when no API is present. The 18+ gate lives in
`assets/age-gate.js` and is loaded by every page. Google Fonts and hosted videos
require an internet connection.
