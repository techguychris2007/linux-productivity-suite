#!/usr/bin/env python3
"""Tiny static server for the built shell with single-page-app fallback (development only)."""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class SPA(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send_head(self):
        path = Path(self.translate_path(self.path))
        if not path.exists() or path.is_dir() and not (path / "index.html").exists():
            self.path = "/index.html"
        return super().send_head()


if __name__ == "__main__":
    root, port = sys.argv[1], int(sys.argv[2])
    ThreadingHTTPServer(("127.0.0.1", port), partial(SPA, directory=root)).serve_forever()
