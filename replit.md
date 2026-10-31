# Running this project

This is a static video site: the page and player are in `index.html`, and the
editable video list is in `videos.js`. No third-party packages, database, or
secrets are required to run it.

Click **Run** to start the **Start application** workflow and view the site in
Preview. The workflow runs:

```sh
python3 server.py
```

The server listens on `0.0.0.0:5000` and disables caching so refreshing Preview
picks up page edits. It serves `/` and `/index.html`, the legal pages
(`/terms`, `/privacy`, `/compliance`), the video list at `/videos.js`, and the
images, age-gate script and stylesheet in `/assets/`; other workspace files are
not publicly served.

Add videos to the exported `videos` list in `videos.js` using `{ title, url }`;
`thumb` is optional. For Videy links, the site extracts the ID and plays the
matching `https://cdn.videy.co/ID.mp4` file in its single player. If no thumbnail
is provided, the site requests video metadata to display a frame at 0.5 seconds.
The main video file loads when a visitor taps a thumbnail. If playback fails,
the player offers the original video page link.

The social links, Telegram link and all advertisements (`AD_CONFIG`, max three
placements) remain configurable in `index.html`. The 18+ gate lives in
`assets/age-gate.js` and is loaded by every page. Google Fonts and hosted videos
require an internet connection.
