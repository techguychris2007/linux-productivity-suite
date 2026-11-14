"""`sheets.*` Atlas AI tools: create, read, write, format, chart and export `.atlasheet` spreadsheets."""

from __future__ import annotations

import json

from ..core_client import CoreClient, CoreError
from ..tools import ToolContext, ToolError, ToolRegistry, ToolResult
from . import atlasheet as sh
from .service import SheetsService

EXT = ".atlasheet"
_GRANT = {"type": "string", "minLength": 1, "description": "Folder grant id from drive.list_folders"}
_PATH = {"type": "string", "minLength": 1, "description": "Path of the .atlasheet file inside the shared folder"}
_ROWS = {"type": "array", "maxItems": sh.ROWS, "items": {"type": "array", "maxItems": sh.COLS, "items": {"type": ["string", "number", "boolean", "null"]}},
         "description": "Rows of cell values. Text, numbers, or formulas starting with '=' such as =SUM(B2:B6), =AVERAGE(...), =IF(...), "
                        "=VLOOKUP(...), =PMT(...). Use A1 references."}
_RANGE = {"type": "string", "pattern": r"^\$?[A-Za-z]{1,3}\$?[1-9]\d*(:\$?[A-Za-z]{1,3}\$?[1-9]\d*)?$", "description": "A1-style cell or range, e.g. B2:D9"}
_FORMAT = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "bold": {"type": "boolean"}, "italic": {"type": "boolean"}, "underline": {"type": "boolean"},
        "align": {"type": "string", "enum": list(sh.ALIGNS)},
        "number_format": {"type": "string", "enum": ["general", *sh.NUM_FORMATS]},
        "currency": {"type": "string", "pattern": "^[A-Z]{3}$", "description": "ISO 4217 code for number_format=currency, e.g. USD, EUR, GHS"},
        "decimals": {"type": "integer", "minimum": 0, "maximum": 6},
    },
}


def _cell(v: object) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _norm_path(path: str) -> str:
    return path if path.endswith(EXT) else path + EXT


class SheetStore:
    """Load and save sheets through the core so every write is permission-checked and backed up."""

    def __init__(self, core: CoreClient) -> None:
        self.core = core

    def load(self, grant: str, path: str) -> dict:
        if not path.endswith(EXT):
            raise ToolError(f"Atlas spreadsheets end in {EXT}", "invalid_arguments")
        r = self.core.call("fs.read_text", grant=grant, path=path, max_bytes=2_000_000)
        if r.get("truncated"):
            raise ToolError("spreadsheet is too large", "too_large")
        try:
            return sh.validate(json.loads(r["content"]))
        except (json.JSONDecodeError, sh.SheetError) as e:
            raise ToolError(f"{path} is not a valid Atlas spreadsheet: {e}", "invalid_document") from e

    def save(self, grant: str, path: str, sheet: dict, create: bool = False) -> None:
        try:
            self.core.call("fs.write_text", grant=grant, path=path, content=json.dumps(sh.validate(sheet), ensure_ascii=False, indent=1),
                           overwrite=not create)
        except CoreError as e:
            if create and "exists" in str(e):
                raise ToolError(f"{path} already exists; pick another name or edit it with sheets.write_range", "conflict") from e
            raise


def write_rows(sheet: dict, start: str, rows: list[list]) -> str:
    ix = sh.cell_index(start)
    if ix is None:
        raise ToolError(f"'{start}' is not a cell reference like A1", "invalid_arguments")
    r0, c0 = ix
    if not rows:
        raise ToolError("rows is empty", "invalid_arguments")
    width = max(len(r) for r in rows)
    if r0 + len(rows) > sh.ROWS or c0 + width > sh.COLS:
        raise ToolError(f"data does not fit: sheets have {sh.ROWS} rows (1-{sh.ROWS}) and {sh.COLS} columns (A-{sh.column_name(sh.COLS - 1)})", "invalid_arguments")
    for i, row in enumerate(rows):
        for j, v in enumerate(row):
            sheet["cells"][r0 + i][c0 + j] = _cell(v)
    return f"{sh.cell_name(r0, c0)}:{sh.cell_name(r0 + len(rows) - 1, c0 + width - 1)}"


def apply_format(sheet: dict, rng: str, fmt: dict) -> int:
    b = sh.range_bounds(rng)
    if b is None:
        raise ToolError(f"'{rng}' is not a range like B2:D9", "invalid_arguments")
    t, l, bt, rt = b
    if bt >= sh.ROWS or rt >= sh.COLS:
        raise ToolError("range is outside the sheet", "invalid_arguments")
    patch = {}
    for src, dst in (("bold", "b"), ("italic", "i"), ("underline", "u")):
        if src in fmt:
            patch[dst] = bool(fmt[src])
    if "align" in fmt:
        patch["align"] = fmt["align"]
    if "number_format" in fmt:
        patch["num"] = None if fmt["number_format"] == "general" else fmt["number_format"]
    if "currency" in fmt:
        patch["cur"] = fmt["currency"]
    if "decimals" in fmt:
        patch["dp"] = fmt["decimals"]
    formats = sheet.setdefault("formats", {})
    n = 0
    for r in range(t, bt + 1):
        for c in range(l, rt + 1):
            key = sh.cell_name(r, c)
            merged = {**formats.get(key, {}), **patch}
            clean = sh.clean_format({k: v for k, v in merged.items() if v not in (None, False)})
            if clean:
                formats[key] = clean
            else:
                formats.pop(key, None)
            n += 1
    return n


def add_chart(sheet: dict, ctype: str, rng: str, title: str) -> dict:
    b = sh.range_bounds(rng)
    if b is None or b[2] >= sh.ROWS or b[3] >= sh.COLS:
        raise ToolError(f"'{rng}' is not a range inside the sheet", "invalid_arguments")
    if b[0] == b[2] and b[1] == b[3]:
        raise ToolError("a chart needs a range with labels and numbers, e.g. A1:B6", "invalid_arguments")
    charts = sheet.setdefault("charts", [])
    if len(charts) >= 20:
        raise ToolError("this sheet already has 20 charts", "invalid_arguments")
    used = {c["id"] for c in charts}
    i = len(charts) + 1
    while f"chart{i}" in used:
        i += 1
    col = min(b[3] + 2, sh.COLS - 5)
    chart = {"id": f"chart{i}", "type": ctype, "range": sh.cell_name(b[0], b[1]) + ":" + sh.cell_name(b[2], b[3]), "title": title[:120],
             "x": 44 + col * 96, "y": 24 + b[0] * 24 + (len(charts) * 300), "w": 440, "h": 280}
    charts.append(chart)
    return chart


def register(reg: ToolRegistry, core: CoreClient, svc: SheetsService) -> None:
    store = SheetStore(core)

    def changed(grant: str, path: str) -> list[dict]:
        return [{"kind": "document", "grant": grant, "path": path}]

    @reg.tool("sheets.create",
              "Create a new spreadsheet (.atlasheet). `rows` starts at A1; put headers in the first row and use formulas for totals "
              "(e.g. =SUM(B2:B6)). Optionally format ranges and add charts in the same call.",
              {"type": "object", "additionalProperties": False, "required": ["grant", "path", "title", "rows"], "properties": {
                  "grant": _GRANT, "path": _PATH, "title": {"type": "string", "minLength": 1, "maxLength": 120}, "rows": _ROWS,
                  "formats": {"type": "array", "maxItems": 40, "items": {"type": "object", "required": ["range", "format"], "additionalProperties": False,
                                                                           "properties": {"range": _RANGE, "format": _FORMAT}}},
                  "charts": {"type": "array", "maxItems": 6, "items": {"type": "object", "required": ["type", "range"], "additionalProperties": False,
                                                                       "properties": {"type": {"type": "string", "enum": list(sh.CHART_TYPES)}, "range": _RANGE, "title": {"type": "string", "maxLength": 120}}}},
              }}, "write", "sheets")
    def create(args, ctx: ToolContext):
        path = _norm_path(args["path"])
        sheet = sh.new_sheet(args["title"])
        sheet["formats"], sheet["charts"] = {}, []
        filled = write_rows(sheet, "A1", args["rows"])
        for f in args.get("formats", []):
            apply_format(sheet, f["range"], f["format"])
        for c in args.get("charts", []):
            add_chart(sheet, c["type"], c["range"], c.get("title", ""))
        store.save(args["grant"], path, sheet, create=True)
        return ToolResult({"path": path, "filled": filled, "charts": len(sheet["charts"])},
                          summary=f"Created {path} ({filled}{', ' + str(len(sheet['charts'])) + ' chart(s)' if sheet['charts'] else ''})",
                          changed=changed(args["grant"], path))

    @reg.tool("sheets.read", "Read a spreadsheet: the used cells (raw values and formulas by address), number formats and charts.",
              {"type": "object", "additionalProperties": False, "required": ["grant", "path"], "properties": {"grant": _GRANT, "path": _PATH}},
              "read", "sheets")
    def read(args, ctx):
        sheet = store.load(args["grant"], args["path"])
        nr, nc = sh.used_size(sheet["cells"])
        rows = [{"row": r + 1, "cells": {sh.cell_name(r, c): v for c, v in enumerate(sheet["cells"][r][:nc]) if v != ""}} for r in range(nr)]
        rows = [r for r in rows if r["cells"]]
        return ToolResult({"title": sheet["title"], "used_range": f"A1:{sh.cell_name(nr - 1, nc - 1)}" if nr else None, "rows": rows,
                           "formats": sheet["formats"], "charts": [{k: c[k] for k in ("id", "type", "range", "title")} for c in sheet["charts"]],
                           "note": "Formulas are shown as written; Atlas Sheets calculates them when the sheet is opened."},
                          untrusted=True, source=f"spreadsheet {args['path']}", summary=f"Read {args['path']} ({len(rows)} rows)")

    @reg.tool("sheets.write_range", "Write rows of values or formulas into a spreadsheet starting at a cell (overwrites those cells).",
              {"type": "object", "additionalProperties": False, "required": ["grant", "path", "start", "rows"], "properties": {
                  "grant": _GRANT, "path": _PATH, "start": {"type": "string", "pattern": r"^[A-Za-z]{1,3}[1-9]\d*$"}, "rows": _ROWS}},
              "write", "sheets")
    def write_range(args, ctx):
        sheet = store.load(args["grant"], args["path"])
        filled = write_rows(sheet, args["start"].upper(), args["rows"])
        store.save(args["grant"], args["path"], sheet)
        return ToolResult({"filled": filled}, summary=f"Wrote {filled} in {args['path']}", changed=changed(args["grant"], args["path"]))

    @reg.tool("sheets.format_range", "Format a range: bold/italic/underline, alignment, number format (number, currency, percent, date) and decimals.",
              {"type": "object", "additionalProperties": False, "required": ["grant", "path", "range", "format"], "properties": {
                  "grant": _GRANT, "path": _PATH, "range": _RANGE, "format": _FORMAT}}, "write", "sheets")
    def format_range(args, ctx):
        sheet = store.load(args["grant"], args["path"])
        n = apply_format(sheet, args["range"], args["format"])
        store.save(args["grant"], args["path"], sheet)
        return ToolResult({"cells": n}, summary=f"Formatted {args['range'].upper()} in {args['path']}", changed=changed(args["grant"], args["path"]))

    @reg.tool("sheets.create_chart",
              "Add a column, bar, line or pie chart. The range's first column holds category labels and the first row holds series names.",
              {"type": "object", "additionalProperties": False, "required": ["grant", "path", "type", "range"], "properties": {
                  "grant": _GRANT, "path": _PATH, "type": {"type": "string", "enum": list(sh.CHART_TYPES)}, "range": _RANGE,
                  "title": {"type": "string", "maxLength": 120}}}, "write", "sheets")
    def create_chart(args, ctx):
        sheet = store.load(args["grant"], args["path"])
        chart = add_chart(sheet, args["type"], args["range"], args.get("title", ""))
        store.save(args["grant"], args["path"], sheet)
        return ToolResult({"chart": chart["id"], "range": chart["range"]}, summary=f"Added a {chart['type']} chart of {chart['range']} to {args['path']}",
                          changed=changed(args["grant"], args["path"]))

    @reg.tool("sheets.export_xlsx", "Export a spreadsheet to an Excel workbook (.xlsx) next to it. Formulas are kept.",
              {"type": "object", "additionalProperties": False, "required": ["grant", "path"], "properties": {"grant": _GRANT, "path": _PATH}},
              "write", "sheets")
    def export(args, ctx):
        r = svc.export_file(args["grant"], args["path"])
        return ToolResult(r, summary=f"Exported {r['path']}", changed=[{"kind": "file", "grant": args["grant"], "path": r["path"]}])
