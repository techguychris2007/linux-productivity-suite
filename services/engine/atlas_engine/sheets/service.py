"""Import and export Atlas Sheets workbooks through the permission-enforcing core."""
from __future__ import annotations

import base64
import json
import posixpath
import zipfile
import xml.etree.ElementTree as ET

from ..core_client import CoreClient, CoreError
from ..tools import ToolError
from .xlsx import export_xlsx, import_xlsx

EXT = ".atlasheet"


class SheetsService:
    def __init__(self, core: CoreClient) -> None:
        self.core = core

    def _free_path(self, grant: str, original: str, extension: str) -> str:
        folder, filename = posixpath.split(original)
        stem = posixpath.splitext(filename)[0]
        for suffix in range(100):
            name = f"{stem}{extension}" if suffix == 0 else f"{stem} ({suffix}){extension}"
            path = posixpath.join(folder, name) if folder else name
            try:
                result = self.core.call("fs.stat", grant=grant, path=path)
                if result.get("kind") == "missing":
                    return path
            except CoreError:
                return path
        raise ToolError("could not find an unused spreadsheet name", "conflict")

    def import_file(self, grant: str, path: str) -> dict:
        if posixpath.splitext(path)[1].lower() != ".xlsx":
            raise ToolError("Only .xlsx workbooks can be imported", "invalid_arguments")
        try:
            data = base64.b64decode(self.core.call("fs.read_base64", grant=grant, path=path)["data"], validate=True)
            model = import_xlsx(data, posixpath.splitext(posixpath.basename(path))[0])
        except (ValueError, KeyError, zipfile.BadZipFile, ET.ParseError, OSError) as exc:
            raise ToolError(f"Could not import this workbook: {exc}", "invalid_workbook") from exc
        out = self._free_path(grant, path, EXT)
        self.core.call("fs.write_text", grant=grant, path=out, content=json.dumps(model, ensure_ascii=False, indent=1), overwrite=False)
        return {"path": out, "title": model["title"]}

    def export_file(self, grant: str, path: str) -> dict:
        if not path.endswith(EXT):
            raise ToolError(f"Atlas spreadsheets must end in {EXT}", "invalid_arguments")
        result = self.core.call("fs.read_text", grant=grant, path=path, max_bytes=2_000_000)
        if result.get("truncated"):
            raise ToolError("spreadsheet is too large", "too_large")
        try:
            model = json.loads(result["content"])
            data = export_xlsx(model)
        except (ValueError, TypeError, KeyError) as exc:
            raise ToolError(f"Could not export this spreadsheet: {exc}", "invalid_spreadsheet") from exc
        folder, filename = posixpath.split(path)
        out = self._free_path(grant, path, ".xlsx")
        saved = self.core.call("fs.write_base64", grant=grant, path=out, data=base64.b64encode(data).decode("ascii"), overwrite=False)
        return {"path": out, "size": saved.get("size", len(data))}
