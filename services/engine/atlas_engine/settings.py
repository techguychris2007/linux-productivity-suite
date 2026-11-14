"""Engine settings (AI provider choice).

Milestone 1 stores the provider config in a 0600 file inside the Atlas data dir.
Planned (Milestone 2): API keys move to the desktop keyring (Secret Service) via the Rust core.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any


class Settings:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._data: dict[str, Any] = {}
        if path.exists():
            try:
                self._data = json.loads(path.read_text())
            except json.JSONDecodeError:
                self._data = {}

    def get(self, key: str, default: Any = None) -> Any:
        with self._lock:
            return self._data.get(key, default)

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            self._data[key] = value
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(self._data, f)
            os.replace(tmp, self.path)

    def provider_public(self) -> dict | None:
        """Provider config without secrets, safe to send to the UI."""
        p = self.get("provider")
        if not p:
            return None
        return {k: v for k, v in p.items() if k != "api_key"} | {
            "has_api_key": bool(p.get("api_key"))
        }
