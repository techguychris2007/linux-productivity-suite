"""The `.atlasheet` model shared with the shell (apps/shell/src/sheets/model.ts).

A sheet is a fixed ROWS x COLS grid of raw cell strings. A cell that starts with "=" is a formula.
"""

from __future__ import annotations

import re

ROWS = 80
COLS = 20
FORMAT = "atlas.sheet"

_REF = re.compile(r"^([A-Z]{1,3})([1-9]\d*)$")
# Same numbers the shell's Number() accepts for plain cells (no "inf", "nan" or "1_000").
NUMBER = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$")


class SheetError(Exception):
    pass


def column_name(n: int) -> str:
    out = ""
    n += 1
    while n > 0:
        n, rem = divmod(n - 1, 26)
        out = chr(65 + rem) + out
    return out


def cell_name(row: int, col: int) -> str:
    return f"{column_name(col)}{row + 1}"


def cell_index(ref: str) -> tuple[int, int] | None:
    m = _REF.match(ref.upper().replace("$", ""))
    if not m:
        return None
    col = 0
    for ch in m.group(1):
        col = col * 26 + ord(ch) - 64
    return int(m.group(2)) - 1, col - 1


def empty_grid() -> list[list[str]]:
    return [[""] * COLS for _ in range(ROWS)]


def new_sheet(title: str, cells: list[list[str]] | None = None) -> dict:
    sheet = {"format": FORMAT, "version": 1, "title": title.strip() or "Untitled spreadsheet", "cells": empty_grid()}
    if cells:
        for r, row in enumerate(cells[:ROWS]):
            for c, v in enumerate(row[:COLS]):
                sheet["cells"][r][c] = str(v)
    return sheet


CHART_TYPES = ("column", "bar", "line", "pie")
NUM_FORMATS = ("number", "currency", "percent", "date")
ALIGNS = ("left", "center", "right")


def clean_format(f: object) -> dict:
    """Same rules as cleanFormat() in apps/shell/src/sheets/model.ts."""
    if not isinstance(f, dict):
        return {}
    out: dict = {}
    for k in ("b", "i", "u"):
        if f.get(k):
            out[k] = True
    if f.get("align") in ALIGNS:
        out["align"] = f["align"]
    if f.get("num") in NUM_FORMATS:
        out["num"] = f["num"]
    if isinstance(f.get("cur"), str) and re.fullmatch(r"[A-Z]{3}", f["cur"]):
        out["cur"] = f["cur"]
    if isinstance(f.get("dp"), int) and not isinstance(f.get("dp"), bool) and 0 <= f["dp"] <= 6:
        out["dp"] = f["dp"]
    return out


def range_bounds(rng: str) -> tuple[int, int, int, int] | None:
    parts = rng.replace("$", "").upper().split(":")
    if len(parts) not in (1, 2):
        return None
    a, b = cell_index(parts[0]), cell_index(parts[-1])
    if a is None or b is None:
        return None
    return min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])


def _int(v: object, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(hi, round(float(v))))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def validate(value: object) -> dict:
    if not isinstance(value, dict) or value.get("format") != FORMAT or not isinstance(value.get("cells"), list):
        raise SheetError("not an Atlas spreadsheet")
    cells = value["cells"]
    rows = [row if isinstance(row, list) else [] for row in cells]
    sheet = new_sheet(str(value.get("title") or "Untitled spreadsheet"), [["" if v is None else str(v) for v in row] for row in rows])
    formats = {}
    for key, f in (value.get("formats") or {}).items() if isinstance(value.get("formats"), dict) else []:
        ix = cell_index(str(key))
        clean = clean_format(f)
        if ix and ix[0] < ROWS and ix[1] < COLS and clean:
            formats[str(key).upper()] = clean
    charts = []
    for i, c in enumerate(value.get("charts") or [] if isinstance(value.get("charts"), list) else []):
        if not isinstance(c, dict) or c.get("type") not in CHART_TYPES or not range_bounds(str(c.get("range", ""))):
            continue
        charts.append({"id": str(c.get("id") or f"chart{i + 1}"), "type": c["type"], "range": str(c["range"]).upper(),
                       "title": str(c.get("title") or "")[:120], "x": _int(c.get("x"), 0, 4000, 560), "y": _int(c.get("y"), 0, 4000, 40),
                       "w": _int(c.get("w"), 240, 1200, 440), "h": _int(c.get("h"), 180, 900, 280)})
    sheet["formats"] = formats
    sheet["charts"] = charts[:20]
    return sheet


def used_size(cells: list[list[str]]) -> tuple[int, int]:
    """(rows, cols) of the smallest top-left block containing every non-empty cell."""
    nr = nc = 0
    for r, row in enumerate(cells):
        for c, v in enumerate(row):
            if v != "":
                nr, nc = max(nr, r + 1), max(nc, c + 1)
    return nr, nc
