"""Serve the imported static page without exposing workspace files."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).parent
ASSETS = ROOT / "assets"

SERVED_FILES = {
    "/": (ROOT / "index.html", "text/html; charset=utf-8"),
    "/index.html": (ROOT / "index.html", "text/html; charset=utf-8"),
    "/videos.js": (ROOT / "videos.js", "text/javascript; charset=utf-8"),
}

ASSET_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


def resolve_request(path: str):
    """Return (file, content type) for a URL path, or None if it is not public."""
    if path in SERVED_FILES:
        return SERVED_FILES[path]

    if path.startswith("/assets/"):
        requested = unquote(path[len("/assets/"):])
        candidate = (ASSETS / requested).resolve()
        # Only files inside assets/ are served; no traversal outside it.
        if ASSETS.resolve() in candidate.parents and candidate.is_file():
            content_type = ASSET_TYPES.get(candidate.suffix.lower(), "application/octet-stream")
            return candidate, content_type

    return None


class PageHandler(BaseHTTPRequestHandler):
    def serve_page(self, include_body=True):
        asset = resolve_request(urlsplit(self.path).path)
        if asset is None:
            self.send_error(404)
            return

        file_path, content_type = asset
        try:
            content = file_path.read_bytes()
        except OSError:
            self.send_error(500, "Unable to read requested site file")
            return

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if include_body:
            self.wfile.write(content)

    def do_GET(self):
        self.serve_page()

    def do_HEAD(self):
        self.serve_page(include_body=False)


if __name__ == "__main__":
    print("Serving the site on 0.0.0.0:5000", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 5000), PageHandler).serve_forever()
