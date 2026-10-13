# Running this project

This is the original static video site, with its HTML, CSS, and browser JavaScript
kept together in `index.html`. No third-party packages, database, or secrets are
required to run it.

Click **Run** to start the **Start application** workflow and view the site in
Preview. The workflow runs:

```sh
python3 server.py
```

The server listens on `0.0.0.0:5000`, serves `/` and `/index.html`, and disables
caching so refreshing Preview picks up page edits. Other workspace files are not
publicly served.

The imported content remains unchanged: videos use sample YouTube embeds, social
profiles use placeholder URLs, and the Adsterra Smartlink is not configured.
Replace those public links in `index.html` when real content is available.
YouTube playback and the optional Google font require an internet connection.
