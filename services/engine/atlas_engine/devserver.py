"""Engine HTTP API (stdlib). Used by the Atlas shell; in the packaged app the Tauri core proxies to it.

Routes (all under /v1, bearer = UI token from core runtime file; SSE also accepts ?token=):
  GET  /v1/health
  GET  /v1/providers                 provider kinds + current (secret-free) config
  POST /v1/providers                 {kind, api_key?, base_url?, model?}  validate + save
  POST /v1/providers/models          {kind, api_key?}  list models available to this key
  GET  /v1/tools                     registered tools
  GET  /v1/tasks                     task summaries
  POST /v1/tasks                     {goal, app_context?}
  GET  /v1/tasks/<id>
  POST /v1/tasks/<id>/(pause|resume|cancel|take_control)
  GET  /v1/events?after=<seq>        Server-Sent Events stream (all tasks)
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import __version__
from .apptools import drive
from .core_client import CoreClient
from .events import EventBus
from .orchestrator import Orchestrator
from .providers import PROVIDER_KINDS, ProviderError, make_provider
from .providers.gemini import GeminiProvider
from .settings import Settings
from .sheets.service import SheetsService
from .sheets import tools as sheets_tools
from .tools import ToolError, ToolRegistry
from .writer import service as writer_service
from .writer.converter import LibreOffice


class Engine:
    def __init__(self, data_dir: Path, core: CoreClient | None, startup_secret: tuple[str, str] | None = None) -> None:
        self.settings = Settings(data_dir / "engine" / "settings.json")
        self.bus = EventBus()
        self.registry = ToolRegistry()
        self.core = core
        self.lo = LibreOffice(data_dir / "engine" / "lo-profile")
        self.writer = writer_service.WriterService(core, self.lo) if core else None
        self.sheets = SheetsService(core) if core else None
        if core:
            drive.register(self.registry, core)
            writer_service.register(self.registry, self.writer)
            sheets_tools.register(self.registry, core, self.sheets)
        self._provider = None
        self._external_secret_kind, self._external_secret = startup_secret or (None, None)
        self.orch = Orchestrator(self.registry, self.bus, self.provider, approvals=core)

    def provider(self):
        cfg = self.settings.get("provider")
        if not cfg:
            return None
        if self._provider is None:
            cfg = dict(cfg)
            if not cfg.get("api_key") and self._external_secret_kind == cfg.get("kind"):
                if self._external_secret:
                    cfg["api_key"] = self._external_secret
            self._provider = make_provider(cfg)
        return self._provider

    def provider_public(self) -> dict | None:
        current = self.settings.provider_public()
        if current and current.get("kind") == self._external_secret_kind and self._external_secret:
            return current | {"has_api_key": True}
        return current

    def set_provider(self, cfg: dict) -> dict:
        external_secret = bool(cfg.pop("_atlas_keyring", False))
        kind = cfg.get("kind")
        if kind not in {k["kind"] for k in PROVIDER_KINDS}:
            raise ProviderError("unknown provider")
        prev = self.settings.get("provider") or {}
        if not cfg.get("api_key") and prev.get("kind") == kind:
            cfg["api_key"] = prev.get("api_key", "")  # keep a legacy key when migrating to keyring
        p = make_provider(cfg)  # validates (Gemini: lists models with the key)
        cfg["model"] = p.model
        self.settings.set(
            "provider",
            {
                k: v
                for k, v in cfg.items()
                if v not in (None, "") and not (external_secret and k == "api_key")
            },
        )
        self._provider = p
        if external_secret:
            self._external_secret_kind = kind if cfg.get("api_key") else None
            self._external_secret = cfg.get("api_key")
        return self.provider_public()


def make_handler(engine: Engine, ui_token: str, origin: str | None):
    class H(BaseHTTPRequestHandler):
        server_version = f"atlas-engine/{__version__}"

        def log_message(self, fmt, *args):  # keep stdout clean; errors still go to stderr
            pass

        def _cors(self):
            o = self.headers.get("Origin")
            if origin and o == origin:
                self.send_header("Access-Control-Allow-Origin", o)
                self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Vary", "Origin")

        def _send(self, status: int, payload) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)

        def _authed(self) -> bool:
            host = self.headers.get("Host", "")
            if not (host.startswith("127.0.0.1:") or host.startswith("localhost:")):
                return False
            tok = (self.headers.get("Authorization") or "").removeprefix("Bearer ")
            if not tok:
                tok = (parse_qs(urlparse(self.path).query).get("token") or [""])[0]
            return bool(tok) and hmac.compare_digest(tok, ui_token)

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 2_000_000:
                raise ValueError("body too large")
            return json.loads(self.rfile.read(n) or b"{}") if n else {}

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self):
            if not self._authed():
                return self._send(401, {"error": {"code": "unauthorized", "message": "bad token"}})
            u = urlparse(self.path)
            p = u.path
            if p == "/v1/health":
                return self._send(200, {"result": {"version": __version__, "core": engine.core is not None, "libreoffice": engine.lo.available(),
                                                   "provider": engine.provider_public()}})
            if p == "/v1/providers":
                return self._send(200, {"result": {"kinds": PROVIDER_KINDS, "current": engine.provider_public()}})
            if p == "/v1/tools":
                return self._send(200, {"result": [t.spec() | {"risk": t.risk, "toolset": t.toolset} for t in engine.registry.list()]})
            if p == "/v1/tasks":
                ts = sorted(engine.orch.tasks.values(), key=lambda t: t.created, reverse=True)
                return self._send(200, {"result": [t.summary() for t in ts]})
            m = re.fullmatch(r"/v1/tasks/(t_[0-9a-f]+)", p)
            if m:
                t = engine.orch.tasks.get(m.group(1))
                return self._send(200, {"result": t.summary()}) if t else self._send(404, {"error": {"code": "not_found", "message": "no task"}})
            if p == "/v1/events":
                return self._sse(int((parse_qs(u.query).get("after") or ["0"])[0]))
            return self._send(404, {"error": {"code": "not_found", "message": p}})

        def _sse(self, after: int):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self._cors()
            self.end_headers()
            try:
                for ev in engine.bus.stream(after):
                    chunk = ": keep-alive\n\n" if ev is None else f"id: {ev.seq}\ndata: {json.dumps(ev.to_dict())}\n\n"
                    self.wfile.write(chunk.encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return

        def do_POST(self):
            if not self._authed():
                return self._send(401, {"error": {"code": "unauthorized", "message": "bad token"}})
            p = urlparse(self.path).path
            try:
                body = self._body()
                if p == "/v1/providers":
                    return self._send(200, {"result": engine.set_provider(body)})
                if p == "/v1/providers/models":
                    if body.get("kind") != "gemini":
                        return self._send(400, {"error": {"code": "unsupported", "message": "model listing is available for Gemini"}})
                    key = body.get("api_key") or (engine.settings.get("provider") or {}).get("api_key", "")
                    g = GeminiProvider(key, model="placeholder")
                    return self._send(200, {"result": {"models": g.list_models(), "suggested": g.pick_default_model()}})
                if p in ("/v1/sheets/import", "/v1/sheets/export"):
                    if not engine.sheets:
                        return self._send(503, {"error": {"code": "unavailable", "message": "core not connected"}})
                    if p.endswith("import"):
                        return self._send(200, {"result": engine.sheets.import_file(body["grant"], body["path"])})
                    return self._send(200, {"result": engine.sheets.export_file(body["grant"], body["path"])})
                if p in ("/v1/writer/export", "/v1/writer/import"):
                    if not engine.writer:
                        return self._send(503, {"error": {"code": "unavailable", "message": "core not connected"}})
                    if p.endswith("export"):
                        return self._send(200, {"result": engine.writer.export(body["grant"], body["path"], body.get("format", "docx"))})
                    return self._send(200, {"result": engine.writer.import_file(body["grant"], body["path"])})
                if p == "/v1/tasks":
                    goal = (body.get("goal") or "").strip()
                    if not goal:
                        return self._send(400, {"error": {"code": "invalid_argument", "message": "goal is required"}})
                    t = engine.orch.start(goal[:8000], body.get("app_context") or {})
                    return self._send(200, {"result": t.summary()})
                m = re.fullmatch(r"/v1/tasks/(t_[0-9a-f]+)/(pause|resume|cancel|take_control)", p)
                if m:
                    tid, action = m.groups()
                    if tid not in engine.orch.tasks:
                        return self._send(404, {"error": {"code": "not_found", "message": "no task"}})
                    t = getattr(engine.orch, action)(tid)
                    return self._send(200, {"result": t.summary()})
                return self._send(404, {"error": {"code": "not_found", "message": p}})
            except ProviderError as e:
                return self._send(400, {"error": {"code": "provider_error", "message": str(e)}})
            except ToolError as e:
                return self._send(400, {"error": {"code": e.code, "message": str(e)}})
            except KeyError as e:
                return self._send(400, {"error": {"code": "invalid_argument", "message": f"missing {e}"}})
            except (ValueError, json.JSONDecodeError) as e:
                return self._send(400, {"error": {"code": "bad_request", "message": str(e)}})

    return H


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Atlas Engine")
    ap.add_argument("--port", type=int, default=int(os.environ.get("ATLAS_ENGINE_PORT", 47802)))
    ap.add_argument("--data-dir", type=Path, default=Path(os.environ.get("ATLAS_DATA_DIR", Path.home() / ".local/share/atlas")))
    ap.add_argument("--origin", default=os.environ.get("ATLAS_DEV_ORIGIN"))
    a = ap.parse_args(argv)
    info = json.loads((a.data_dir / "runtime" / "core.json").read_text())
    core = CoreClient(int(info["port"]), info["engine_token"])
    startup_secret = None
    try:
        startup = json.loads(sys.stdin.buffer.read() or b"{}")
        kind, secret = startup.get("provider_kind"), startup.get("api_key")
        if isinstance(kind, str) and isinstance(secret, str) and secret:
            startup_secret = (kind, secret)
    except (json.JSONDecodeError, AttributeError):
        startup_secret = None
    engine = Engine(a.data_dir, core, startup_secret)
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(engine, info["ui_token"], a.origin))
    srv.daemon_threads = True
    print(f"atlas-engine {__version__} on 127.0.0.1:{a.port}", file=sys.stderr)
    srv.serve_forever()


if __name__ == "__main__":
    main()
