"""Export Atlas Slides presentations through the permission-enforcing core."""
from __future__ import annotations

import base64
import json
import posixpath

from ..core_client import CoreClient, CoreError
from ..tools import ToolError
from . import atlasdeck as dk
from .pptx import export_pptx

EXT = ".atlasdeck"


class SlidesService:
    def __init__(self, core: CoreClient) -> None:
        self.core = core

    def load(self, grant: str, path: str) -> dict:
        if not path.endswith(EXT):
            raise ToolError(f"Atlas presentations end in {EXT}", "invalid_arguments")
        r = self.core.call("fs.read_text", grant=grant, path=path, max_bytes=4_000_000)
        if r.get("truncated"):
            raise ToolError("presentation is too large", "too_large")
        try:
            return dk.validate(json.loads(r["content"]))
        except (json.JSONDecodeError, dk.DeckError) as e:
            raise ToolError(f"{path} is not a valid Atlas presentation: {e}", "invalid_document") from e

    def save(self, grant: str, path: str, deck: dict, create: bool = False) -> None:
        try:
            self.core.call("fs.write_text", grant=grant, path=path, content=json.dumps(dk.validate(deck), ensure_ascii=False, indent=1),
                           overwrite=not create)
        except CoreError as e:
            if create and "exists" in str(e):
                raise ToolError(f"{path} already exists; pick another name or edit it with the slides tools", "conflict") from e
            raise

    def _free_path(self, grant: str, original: str, extension: str) -> str:
        folder, filename = posixpath.split(original)
        stem = posixpath.splitext(filename)[0]
        for n in range(100):
            name = f"{stem}{extension}" if n == 0 else f"{stem} ({n}){extension}"
            path = posixpath.join(folder, name) if folder else name
            try:
                if self.core.call("fs.stat", grant=grant, path=path).get("kind") == "missing":
                    return path
            except CoreError:
                return path
        raise ToolError("could not find an unused file name", "conflict")

    def export_file(self, grant: str, path: str) -> dict:
        deck = self.load(grant, path)
        data = export_pptx(deck)
        out = self._free_path(grant, path, ".pptx")
        saved = self.core.call("fs.write_base64", grant=grant, path=out, data=base64.b64encode(data).decode("ascii"), overwrite=False)
        return {"path": out, "size": saved.get("size", len(data)), "slides": len(deck["slides"])}
