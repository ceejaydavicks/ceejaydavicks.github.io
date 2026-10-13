"""Serve the imported static page without exposing workspace files."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


PAGE = Path(__file__).with_name("index.html")


class PageHandler(BaseHTTPRequestHandler):
    def serve_page(self, include_body=True):
        if urlsplit(self.path).path not in ("/", "/index.html"):
            self.send_error(404)
            return

        try:
            content = PAGE.read_bytes()
        except OSError:
            self.send_error(500, "Unable to read index.html")
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
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
