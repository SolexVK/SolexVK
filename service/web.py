"""The panel: a small HTTP server on the same process. Standard library only.

Routes (SECRET is config web.secret, a long random string; without it, nothing):
  GET /d/<SECRET>            the page (service/dashboard.html)
  GET /d/<SECRET>/state.json everything the page shows, as JSON
  anything else              404, no body, no hint

Bind it to 127.0.0.1 and put Caddy (HTTPS on your domain) in front: docs/dashboard.md.
"""

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .state import build_state

HERE = os.path.dirname(os.path.abspath(__file__))


def make_handler(pack, scheduler, secret, cache):
    page_path = os.path.join(HERE, "dashboard.html")

    class Handler(BaseHTTPRequestHandler):
        server_version = "trader-panel/1.0"

        def log_message(self, fmt, *args):  # quiet; systemd has the journal
            pass

        def _send(self, code, body, ctype):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Robots-Tag", "noindex")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if not secret or not path.startswith("/d/" + secret):
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            rest = path[len("/d/" + secret):]
            if rest in ("", "/"):
                with open(page_path, "rb") as fh:
                    self._send(200, fh.read(), "text/html; charset=utf-8")
            elif rest == "/state.json":
                try:
                    doc = build_state(pack, scheduler, cache)
                except Exception as exc:
                    doc = {"error": str(exc)[:300]}
                self._send(200, json.dumps(doc, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")
            else:
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()

    return Handler


class Panel(object):
    def __init__(self, pack, scheduler, cfg):
        web = cfg.get("web") or {}
        self.host = web.get("host", "127.0.0.1")
        self.port = int(web.get("port", 8787))
        self.secret = str(web.get("secret") or "").strip()
        self.public_url = str(web.get("public_url") or "").rstrip("/")
        self.cache = {}
        self.server = ThreadingHTTPServer((self.host, self.port), make_handler(pack, scheduler, self.secret, self.cache))
        self.port = self.server.server_address[1]
        self.thread = None

    def enabled(self):
        return len(self.secret) >= 16

    def url(self):
        base = self.public_url or ("http://%s:%d" % (self.host, self.port))
        return "%s/d/%s" % (base, self.secret)

    def masked_url(self):
        """For logs: the secret never goes to the journal."""
        base = self.public_url or ("http://%s:%d" % (self.host, self.port))
        return "%s/d/%s..." % (base, self.secret[:3])

    def https(self):
        return self.public_url.startswith("https://")

    def start(self):
        self.thread = threading.Thread(target=self.server.serve_forever, name="panel", daemon=True)
        self.thread.start()
        return self.thread

    def stop(self):
        if self.thread is not None:
            self.server.shutdown()  # only a running serve_forever can acknowledge this
            self.thread = None
        self.server.server_close()
