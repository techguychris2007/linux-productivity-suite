"""Client for the Rust security core (atlas-core-host). The engine holds only the *engine* token:
it can request approvals and claim tokens the user granted, but it can never approve anything."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

from .tools import ApprovalRequired, ToolError


class CoreError(ToolError):
    def __init__(self, code: str, message: str, data: Any = None) -> None:
        super().__init__(message, code)
        self.data = data


class ApprovalDenied(Exception):
    pass


class CoreClient:
    def __init__(self, port: int, token: str, timeout: float = 30.0) -> None:
        self.base = f"http://127.0.0.1:{port}/v1/"
        self.token = token
        self.timeout = timeout

    @classmethod
    def from_runtime(cls, data_dir: Path | None = None) -> "CoreClient":
        d = data_dir or Path(os.environ.get("ATLAS_DATA_DIR", Path.home() / ".local/share/atlas"))
        info = json.loads((d / "runtime" / "core.json").read_text())
        return cls(int(info["port"]), info["engine_token"])

    def call(self, command: str, **args: Any) -> Any:
        req = urllib.request.Request(self.base + command, data=json.dumps(args).encode(), method="POST",
                                     headers={"authorization": f"Bearer {self.token}", "content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read().decode())["result"]
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode())["error"]
            except Exception:  # noqa: BLE001
                raise CoreError("core_http", f"core returned HTTP {e.code}") from e
            if err["code"] == "approval_required":
                d = err.get("data") or {}
                raise ApprovalRequired(d.get("request_id", ""), d.get("summary", ""), d.get("risk", "")) from e
            raise CoreError(err["code"], err["message"], err.get("data")) from e
        except urllib.error.URLError as e:
            raise CoreError("core_unreachable", f"Atlas core is not running ({e.reason})") from e

    # ---- approval gateway used by the orchestrator ----
    def request_approval(self, fingerprint: str, summary: str, risk: str) -> str:
        return self.call("approvals.request", fingerprint=fingerprint, summary=summary, risk=risk)["id"]

    def wait_for_token(self, request_id: str, should_stop: Callable[[], bool], timeout: float = 600.0,
                       poll: float = 0.4) -> str:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if should_stop():
                raise ApprovalDenied("task stopped while waiting for approval")
            try:
                tok = self.call("approvals.claim", id=request_id).get("token")
            except CoreError as e:
                raise ApprovalDenied(str(e)) from e
            if tok:
                return tok
            time.sleep(poll)
        raise ApprovalDenied("approval timed out")

    def consume(self, token: str, fingerprint: str) -> bool:
        return bool(self.call("approvals.consume", token=token, fingerprint=fingerprint).get("valid"))
