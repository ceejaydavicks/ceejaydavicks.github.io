"""Serve the imported static page without exposing workspace files."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).parent
SERVED_FILES = {
    "/": (ROOT / "index.html", "text/html; charset=utf-8"),
    "/index.html": (ROOT / "index.html", "text/html; charset=utf-8"),
    "/videos.js": (ROOT / "videos.js", "text/javascript; charset=utf-8"),
}


class PageHandler(BaseHTTPRequestHandler):
    def serve_page(self, include_body=True):
        asset = SERVED_FILES.get(urlsplit(self.path).path)
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
