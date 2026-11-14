"""Small, dependency-free XLSX reader/writer for Atlas Sheets' single-grid format.

Round-trips the first worksheet's values, formulas, cell formats (bold/italic/underline, alignment,
number/currency/percent/date formats) and column, bar, line and pie charts. Macros, external links,
other worksheets and formatting Atlas cannot show are left out.
"""
from __future__ import annotations

import posixpath
import re
import xml.etree.ElementTree as ET
import zipfile
from io import BytesIO

from . import atlasheet as sh

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
XDR = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
C = "http://schemas.openxmlformats.org/drawingml/2006/chart"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
MAX_CELLS = sh.ROWS * sh.COLS

# Geometry shared with the shell grid: 44px row header, 96px columns, 24px rows (see tools.add_chart).
HEADER_W, HEADER_H, COL_W, ROW_H = 44, 24, 96, 24
EMU_PER_PX = 9525
# Categorical palette used by the shell's charts (--series-N in light mode).
SERIES_COLORS = ("2A78D6", "EB6834", "1BAF7A", "EDA100", "E87BA4", "008300", "6250D6", "E34948")
CURRENCY_SYMBOLS = {"USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥", "CNY": "¥", "INR": "₹", "NGN": "₦", "GHS": "GH₵", "KRW": "₩"}
_SYMBOL_TO_CODE = {"$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR", "₦": "NGN", "GH₵": "GHS", "₵": "GHS", "₩": "KRW"}
# Built-in Excel number formats that are dates/times.
_BUILTIN_DATES = set(range(14, 23)) | set(range(45, 48))
_BUILTIN_FORMATS = {1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%"}

for _prefix, _ns in (("", NS), ("r", REL), ("xdr", XDR), ("a", A), ("c", C)):
    ET.register_namespace(_prefix, _ns)


def _tag(ns: str, name: str) -> str:
    return f"{{{ns}}}{name}"


def _col_index(ref: str) -> tuple[int, int] | None:
    m = re.fullmatch(r"\$?([A-Z]{1,3})\$?([1-9]\d*)", ref.upper())
    if not m:
        return None
    col = 0
    for char in m.group(1):
        col = col * 26 + ord(char) - 64
    return int(m.group(2)) - 1, col - 1


def _cell_ref(row: int, col: int, absolute: bool = False) -> str:
    name = sh.column_name(col)
    return f"${name}${row + 1}" if absolute else f"{name}{row + 1}"


def _safe_xml(data: bytes) -> ET.Element:
    # ElementTree does not resolve external entities; reject DTD declarations explicitly.
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ValueError("XLSX contains unsupported XML declarations")
    try:
        return ET.fromstring(data)
    except ET.ParseError as exc:
        raise ValueError("XLSX contains malformed XML") from exc


def _xml(root: ET.Element) -> bytes:
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _text_value(element: ET.Element) -> str:
    return "".join(node.text or "" for node in element.iter(_tag(NS, "t")))


def _sheet_name(title: object) -> str:
    return re.sub(r"[:\\/?*\[\]]", "-", str(title or "Sheet1")).strip("'")[:31].strip() or "Sheet1"


# ---------------------------------------------------------------- number formats
def _excel_numfmt(f: dict) -> str | None:
    kind = f.get("num")
    if kind is None:
        return None
    if kind == "date":
        return "d mmm yyyy"
    dp = f.get("dp", 0 if kind == "percent" else 2)
    frac = "." + "0" * dp if dp else ""
    if kind == "percent":
        return f"0{frac}%"
    body = f"#,##0{frac}"
    if kind == "currency":
        code = f.get("cur") or "USD"
        symbol = CURRENCY_SYMBOLS.get(code, code + " ")
        return f'"{symbol}"{body}'
    return body


def _strip_literals(code: str) -> str:
    return re.sub(r'"[^"]*"|\\.|\[[^\]]*\]', "", code)


def _atlas_numfmt(code: str | None, builtin: int) -> dict:
    """Map an Excel number format to the closest Atlas format (or {} for General/unknown)."""
    if code is None:
        if builtin in _BUILTIN_DATES:
            return {"num": "date"}
        code = _BUILTIN_FORMATS.get(builtin)
        if code is None:
            return {}
    section = code.split(";")[0]
    if section.strip().lower() in ("", "general", "@"):
        return {}
    bare = _strip_literals(section)
    if re.search(r"[dmyhs]", bare, re.IGNORECASE) and not re.search(r"[0#]", bare):
        return {"num": "date"}
    dp_match = re.search(r"[0#]\.(0+)", bare)
    dp = len(dp_match.group(1)) if dp_match else 0
    if "%" in bare:
        return {"num": "percent", "dp": dp} if dp else {"num": "percent"}
    cur = None
    for lit in re.findall(r'"([^"]*)"|\[\$([^\]-]*)', section):
        text = (lit[0] or lit[1]).strip()
        if re.fullmatch(r"[A-Z]{3}", text):
            cur = text
        elif text in _SYMBOL_TO_CODE:
            cur = _SYMBOL_TO_CODE[text]
        if cur:
            break
    if cur is None:
        cur = next((code for sym, code in sorted(_SYMBOL_TO_CODE.items(), key=lambda kv: -len(kv[0])) if sym in bare), None)
    out: dict = {"num": "currency", "cur": cur} if cur else {"num": "number"}
    if dp != 2:  # the shell shows numbers and currency with 2 decimals by default
        out["dp"] = dp
    return out


# ---------------------------------------------------------------- styles
class _Styles:
    """Collects the distinct cell formats of a sheet into styles.xml records."""

    def __init__(self) -> None:
        self.fonts: list[tuple[bool, bool, bool]] = [(False, False, False)]
        self.numfmts: dict[str, int] = {}
        self.xfs: list[tuple[int, int, str | None]] = [(0, 0, None)]

    def index(self, f: dict) -> int:
        font = (bool(f.get("b")), bool(f.get("i")), bool(f.get("u")))
        if font not in self.fonts:
            self.fonts.append(font)
        code = _excel_numfmt(f)
        fmt_id = 0
        if code is not None:
            fmt_id = self.numfmts.setdefault(code, 164 + len(self.numfmts))
        xf = (self.fonts.index(font), fmt_id, f.get("align"))
        if xf not in self.xfs:
            self.xfs.append(xf)
        return self.xfs.index(xf)

    def xml(self) -> bytes:
        root = ET.Element(_tag(NS, "styleSheet"))
        if self.numfmts:
            nf = ET.SubElement(root, _tag(NS, "numFmts"), {"count": str(len(self.numfmts))})
            for code, i in self.numfmts.items():
                ET.SubElement(nf, _tag(NS, "numFmt"), {"numFmtId": str(i), "formatCode": code})
        fonts = ET.SubElement(root, _tag(NS, "fonts"), {"count": str(len(self.fonts))})
        for b, i, u in self.fonts:
            font = ET.SubElement(fonts, _tag(NS, "font"))
            for on, name in ((b, "b"), (i, "i"), (u, "u")):
                if on:
                    ET.SubElement(font, _tag(NS, name))
            ET.SubElement(font, _tag(NS, "sz"), {"val": "11"})
            ET.SubElement(font, _tag(NS, "name"), {"val": "Calibri"})
        fills = ET.SubElement(root, _tag(NS, "fills"), {"count": "2"})
        for pattern in ("none", "gray125"):
            ET.SubElement(ET.SubElement(fills, _tag(NS, "fill")), _tag(NS, "patternFill"), {"patternType": pattern})
        borders = ET.SubElement(root, _tag(NS, "borders"), {"count": "1"})
        ET.SubElement(borders, _tag(NS, "border"))
        sxf = ET.SubElement(root, _tag(NS, "cellStyleXfs"), {"count": "1"})
        ET.SubElement(sxf, _tag(NS, "xf"), {"numFmtId": "0", "fontId": "0", "fillId": "0", "borderId": "0"})
        xfs = ET.SubElement(root, _tag(NS, "cellXfs"), {"count": str(len(self.xfs))})
        for font_id, fmt_id, align in self.xfs:
            attrs = {"numFmtId": str(fmt_id), "fontId": str(font_id), "fillId": "0", "borderId": "0", "xfId": "0"}
            if font_id:
                attrs["applyFont"] = "1"
            if fmt_id:
                attrs["applyNumberFormat"] = "1"
            if align:
                attrs["applyAlignment"] = "1"
            xf = ET.SubElement(xfs, _tag(NS, "xf"), attrs)
            if align:
                ET.SubElement(xf, _tag(NS, "alignment"), {"horizontal": align})
        styles = ET.SubElement(root, _tag(NS, "cellStyles"), {"count": "1"})
        ET.SubElement(styles, _tag(NS, "cellStyle"), {"name": "Normal", "xfId": "0", "builtinId": "0"})
        return _xml(root)


def _read_styles(root: ET.Element) -> list[dict]:
    """Atlas format for each cellXfs index."""
    codes = {int(n.get("numFmtId", "0")): n.get("formatCode", "") for n in root.iter(_tag(NS, "numFmt")) if n.get("numFmtId", "").isdigit()}
    fonts = []
    fonts_node = root.find(_tag(NS, "fonts"))
    for font in fonts_node.findall(_tag(NS, "font")) if fonts_node is not None else []:
        def on(name: str) -> bool:
            node = font.find(_tag(NS, name))
            return node is not None and node.get("val", "1") not in ("0", "false", "none")
        fonts.append({k: True for k in ("b", "i", "u") if on(k)})
    out = []
    xfs = root.find(_tag(NS, "cellXfs"))
    for xf in xfs.findall(_tag(NS, "xf")) if xfs is not None else []:
        f: dict = {}
        try:
            f.update(fonts[int(xf.get("fontId", "0"))])
        except (ValueError, IndexError):
            pass
        fmt_id = int(xf.get("numFmtId", "0")) if xf.get("numFmtId", "0").isdigit() else 0
        if fmt_id:
            f.update(_atlas_numfmt(codes.get(fmt_id), fmt_id))
        align = xf.find(_tag(NS, "alignment"))
        if align is not None and align.get("horizontal") in sh.ALIGNS:
            f["align"] = align.get("horizontal")
        out.append(sh.clean_format(f))
        if len(out) >= 4000:
            break
    return out


# ---------------------------------------------------------------- charts
def _chart_layout(cells: list[list[str]], rng: str) -> dict | None:
    """Same reading rules as chartData() in apps/shell/src/sheets/charts.tsx, on raw cells.

    Formula cells count as numbers (they nearly always calculate to one).
    """
    b = sh.range_bounds(rng)
    if b is None:
        return None
    t, l, bt, r = b

    def text(row: int, col: int) -> bool:
        v = cells[row][col].strip() if row < sh.ROWS and col < sh.COLS else ""
        return bool(v) and not v.startswith("=") and not sh.NUMBER.match(v)

    label_col = r > l and any(text(t + i, l) for i in range(bt - t + 1))
    first = l + 1 if label_col else l
    header = bt > t and any(text(t, first + i) for i in range(r - first + 1))
    top = t + 1 if header else t
    if top > bt or first > r:
        return None
    return {"label_col": l if label_col else None, "header_row": t if header else None, "top": top, "bottom": bt,
            "series_cols": list(range(first, min(r, first + 7) + 1))}


def _str_ref(parent: ET.Element, tag: str, formula: str, values: list[str]) -> None:
    ref = ET.SubElement(ET.SubElement(parent, _tag(C, tag)), _tag(C, "strRef"))
    ET.SubElement(ref, _tag(C, "f")).text = formula
    cache = ET.SubElement(ref, _tag(C, "strCache"))
    ET.SubElement(cache, _tag(C, "ptCount"), {"val": str(len(values))})
    for i, v in enumerate(values):
        ET.SubElement(ET.SubElement(cache, _tag(C, "pt"), {"idx": str(i)}), _tag(C, "v")).text = v


def _num_ref(parent: ET.Element, formula: str, values: list[str]) -> None:
    ref = ET.SubElement(ET.SubElement(parent, _tag(C, "val")), _tag(C, "numRef"))
    ET.SubElement(ref, _tag(C, "f")).text = formula
    cache = ET.SubElement(ref, _tag(C, "numCache"))
    ET.SubElement(cache, _tag(C, "formatCode")).text = "General"
    ET.SubElement(cache, _tag(C, "ptCount"), {"val": str(len(values))})
    for i, v in enumerate(values):
        if sh.NUMBER.match(v.strip()):  # formulas are left for the spreadsheet app to calculate
            ET.SubElement(ET.SubElement(cache, _tag(C, "pt"), {"idx": str(i)}), _tag(C, "v")).text = v.strip()


def _solid(parent: ET.Element, color: str, line: bool = False) -> None:
    sp = ET.SubElement(parent, _tag(C, "spPr"))
    if line:
        ln = ET.SubElement(sp, _tag(A, "ln"), {"w": "28575", "cap": "rnd"})
        ET.SubElement(ET.SubElement(ln, _tag(A, "solidFill")), _tag(A, "srgbClr"), {"val": color})
    else:
        ET.SubElement(ET.SubElement(sp, _tag(A, "solidFill")), _tag(A, "srgbClr"), {"val": color})


def _chart_xml(chart: dict, cells: list[list[str]], sheet_name: str) -> bytes | None:
    lay = _chart_layout(cells, chart["range"])
    if lay is None:
        return None
    quoted = "'" + sheet_name.replace("'", "''") + "'"

    def ref(r0: int, c0: int, r1: int, c1: int) -> str:
        a, b = _cell_ref(r0, c0, True), _cell_ref(r1, c1, True)
        return f"{quoted}!{a}" if a == b else f"{quoted}!{a}:{b}"

    rows = range(lay["top"], lay["bottom"] + 1)
    root = ET.Element(_tag(C, "chartSpace"))
    ET.SubElement(root, _tag(C, "roundedCorners"), {"val": "0"})
    ch = ET.SubElement(root, _tag(C, "chart"))
    if chart.get("title"):
        title = ET.SubElement(ch, _tag(C, "title"))
        rich = ET.SubElement(ET.SubElement(title, _tag(C, "tx")), _tag(C, "rich"))
        ET.SubElement(rich, _tag(A, "bodyPr"))
        ET.SubElement(ET.SubElement(ET.SubElement(rich, _tag(A, "p")), _tag(A, "r")), _tag(A, "t")).text = chart["title"]
        ET.SubElement(title, _tag(C, "overlay"), {"val": "0"})
    ET.SubElement(ch, _tag(C, "autoTitleDeleted"), {"val": "0" if chart.get("title") else "1"})
    plot = ET.SubElement(ch, _tag(C, "plotArea"))
    ET.SubElement(plot, _tag(C, "layout"))
    kind = chart["type"]
    series_cols = lay["series_cols"][:1] if kind == "pie" else lay["series_cols"]
    if kind == "pie":
        group = ET.SubElement(plot, _tag(C, "pieChart"))
        ET.SubElement(group, _tag(C, "varyColors"), {"val": "1"})
    elif kind == "line":
        group = ET.SubElement(plot, _tag(C, "lineChart"))
        ET.SubElement(group, _tag(C, "grouping"), {"val": "standard"})
        ET.SubElement(group, _tag(C, "varyColors"), {"val": "0"})
    else:
        group = ET.SubElement(plot, _tag(C, "barChart"))
        ET.SubElement(group, _tag(C, "barDir"), {"val": "bar" if kind == "bar" else "col"})
        ET.SubElement(group, _tag(C, "grouping"), {"val": "clustered"})
        ET.SubElement(group, _tag(C, "varyColors"), {"val": "0"})
    for j, col in enumerate(series_cols):
        ser = ET.SubElement(group, _tag(C, "ser"))
        ET.SubElement(ser, _tag(C, "idx"), {"val": str(j)})
        ET.SubElement(ser, _tag(C, "order"), {"val": str(j)})
        if lay["header_row"] is not None:
            h = lay["header_row"]
            _str_ref(ser, "tx", ref(h, col, h, col), [cells[h][col] or f"Series {j + 1}"])
        color = SERIES_COLORS[j % len(SERIES_COLORS)]
        if kind == "pie":
            for i in range(len(rows)):
                dpt = ET.SubElement(ser, _tag(C, "dPt"))
                ET.SubElement(dpt, _tag(C, "idx"), {"val": str(i)})
                ET.SubElement(dpt, _tag(C, "bubble3D"), {"val": "0"})
                _solid(dpt, SERIES_COLORS[i % len(SERIES_COLORS)])
        else:
            _solid(ser, color, line=kind == "line")
        if kind == "line":
            ET.SubElement(ET.SubElement(ser, _tag(C, "marker")), _tag(C, "symbol"), {"val": "circle"})
        if kind in ("column", "bar"):
            ET.SubElement(ser, _tag(C, "invertIfNegative"), {"val": "0"})
        if lay["label_col"] is not None:
            lc = lay["label_col"]
            _str_ref(ser, "cat", ref(lay["top"], lc, lay["bottom"], lc), [cells[r][lc] for r in rows])
        _num_ref(ser, ref(lay["top"], col, lay["bottom"], col), [cells[r][col] for r in rows])
        if kind == "line":
            ET.SubElement(ser, _tag(C, "smooth"), {"val": "0"})
    if kind == "pie":
        ET.SubElement(group, _tag(C, "firstSliceAng"), {"val": "0"})
    else:
        if kind != "line":
            ET.SubElement(group, _tag(C, "gapWidth"), {"val": "80"})
        if kind == "line":
            ET.SubElement(group, _tag(C, "marker"), {"val": "1"})
        ET.SubElement(group, _tag(C, "axId"), {"val": "500000001"})
        ET.SubElement(group, _tag(C, "axId"), {"val": "500000002"})
        cat_pos, val_pos = ("l", "b") if kind == "bar" else ("b", "l")
        for tagname, ax_id, cross, pos in (("catAx", "500000001", "500000002", cat_pos), ("valAx", "500000002", "500000001", val_pos)):
            ax = ET.SubElement(plot, _tag(C, tagname))
            ET.SubElement(ax, _tag(C, "axId"), {"val": ax_id})
            ET.SubElement(ET.SubElement(ax, _tag(C, "scaling")), _tag(C, "orientation"), {"val": "minMax"})
            ET.SubElement(ax, _tag(C, "delete"), {"val": "0"})
            ET.SubElement(ax, _tag(C, "axPos"), {"val": pos})
            if tagname == "valAx":
                ET.SubElement(ax, _tag(C, "majorGridlines"))
            ET.SubElement(ax, _tag(C, "numFmt"), {"formatCode": "General", "sourceLinked": "1"})
            ET.SubElement(ax, _tag(C, "tickLblPos"), {"val": "nextTo"})
            ET.SubElement(ax, _tag(C, "crossAx"), {"val": cross})
            ET.SubElement(ax, _tag(C, "crosses"), {"val": "autoZero"})
            if tagname == "valAx":
                ET.SubElement(ax, _tag(C, "crossBetween"), {"val": "between"})
    if kind == "pie" or len(series_cols) >= 2:
        legend = ET.SubElement(ch, _tag(C, "legend"))
        ET.SubElement(legend, _tag(C, "legendPos"), {"val": "b"})
        ET.SubElement(legend, _tag(C, "overlay"), {"val": "0"})
    ET.SubElement(ch, _tag(C, "plotVisOnly"), {"val": "1"})
    return _xml(root)


def _anchor_point(px: int, origin: int, size: int) -> tuple[int, int]:
    cell, off = divmod(max(0, px - origin), size)
    return cell, off * EMU_PER_PX


def _drawing_xml(charts: list[dict]) -> bytes:
    root = ET.Element(_tag(XDR, "wsDr"))
    for n, chart in enumerate(charts, 1):
        anchor = ET.SubElement(root, _tag(XDR, "twoCellAnchor"), {"editAs": "oneCell"})
        for tagname, x, y in (("from", chart["x"], chart["y"]), ("to", chart["x"] + chart["w"], chart["y"] + chart["h"])):
            col, col_off = _anchor_point(x, HEADER_W, COL_W)
            row, row_off = _anchor_point(y, HEADER_H, ROW_H)
            point = ET.SubElement(anchor, _tag(XDR, tagname))
            for name, val in (("col", col), ("colOff", col_off), ("row", row), ("rowOff", row_off)):
                ET.SubElement(point, _tag(XDR, name)).text = str(val)
        frame = ET.SubElement(anchor, _tag(XDR, "graphicFrame"), {"macro": ""})
        nv = ET.SubElement(frame, _tag(XDR, "nvGraphicFramePr"))
        ET.SubElement(nv, _tag(XDR, "cNvPr"), {"id": str(n + 1), "name": chart.get("title") or f"Chart {n}"})
        ET.SubElement(nv, _tag(XDR, "cNvGraphicFramePr"))
        xfrm = ET.SubElement(frame, _tag(XDR, "xfrm"))
        ET.SubElement(xfrm, _tag(A, "off"), {"x": "0", "y": "0"})
        ET.SubElement(xfrm, _tag(A, "ext"), {"cx": "0", "cy": "0"})
        graphic = ET.SubElement(ET.SubElement(frame, _tag(A, "graphic")), _tag(A, "graphicData"), {"uri": C})
        ET.SubElement(graphic, _tag(C, "chart"), {_tag(REL, "id"): f"rId{n}"})
        ET.SubElement(anchor, _tag(XDR, "clientData"))
    return _xml(root)


def _rels(items: list[tuple[str, str, str]]) -> bytes:
    root = ET.Element(_tag(PKG_REL, "Relationships"))
    for rid, typ, target in items:
        ET.SubElement(root, _tag(PKG_REL, "Relationship"), {"Id": rid, "Type": f"{REL}/{typ}", "Target": target})
    return _xml(root)


# ---------------------------------------------------------------- import
def _resolve(base_part: str, target: str | None, names: set[str]) -> str | None:
    """Resolve a relationship target against the part that owns it; None if it leaves the package."""
    if not target or re.match(r"^[a-z]+:", target, re.IGNORECASE):
        return None
    path = posixpath.normpath(target[1:] if target.startswith("/") else posixpath.join(posixpath.dirname(base_part), target))
    return path if path in names and not path.startswith("..") else None


def _part_rels(archive: zipfile.ZipFile, part: str, names: set[str]) -> dict[str, str]:
    rels_path = posixpath.join(posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels")
    if rels_path not in names:
        return {}
    out = {}
    for r in _safe_xml(archive.read(rels_path)).findall(_tag(PKG_REL, "Relationship")):
        resolved = _resolve(part, r.get("Target"), names)
        if r.get("Id") and resolved and r.get("TargetMode") != "External":
            out[r.get("Id")] = resolved
    return out


def _formula_bounds(formula: str | None) -> tuple[int, int, int, int] | None:
    if not formula:
        return None
    rng = formula.rsplit("!", 1)[-1].strip()
    if "," in rng:
        return None
    return sh.range_bounds(rng)


def _import_charts(archive: zipfile.ZipFile, worksheet_path: str, sheet_root: ET.Element, names: set[str]) -> list[dict]:
    drawing = sheet_root.find(_tag(NS, "drawing"))
    if drawing is None:
        return []
    drawing_path = _part_rels(archive, worksheet_path, names).get(drawing.get(_tag(REL, "id"), ""))
    if not drawing_path:
        return []
    chart_rels = _part_rels(archive, drawing_path, names)
    charts: list[dict] = []
    for anchor in _safe_xml(archive.read(drawing_path)):
        if anchor.tag not in (_tag(XDR, "twoCellAnchor"), _tag(XDR, "oneCellAnchor")) or len(charts) >= 20:
            continue
        ref = anchor.find(f".//{_tag(C, 'chart')}")
        chart_path = chart_rels.get(ref.get(_tag(REL, "id"), "")) if ref is not None else None
        if not chart_path:
            continue
        root = _safe_xml(archive.read(chart_path))
        kind = None
        for el in root.iter():
            if el.tag in (_tag(C, "pieChart"), _tag(C, "pie3DChart"), _tag(C, "doughnutChart")):
                kind = "pie"
            elif el.tag in (_tag(C, "lineChart"), _tag(C, "line3DChart")):
                kind = "line"
            elif el.tag in (_tag(C, "barChart"), _tag(C, "bar3DChart")):
                bar_dir = el.find(_tag(C, "barDir"))
                kind = "bar" if bar_dir is not None and bar_dir.get("val") == "bar" else "column"
            if kind:
                break
        if not kind:
            continue
        boxes = [_formula_bounds(f.text) for f in root.iter(_tag(C, "f"))]
        boxes = [b for b in boxes if b]
        if not boxes:
            continue
        t, l = min(b[0] for b in boxes), min(b[1] for b in boxes)
        bt, r = max(b[2] for b in boxes), max(b[3] for b in boxes)
        if bt >= sh.ROWS or r >= sh.COLS:
            continue
        title_el = root.find(f"{_tag(C, 'chart')}/{_tag(C, 'title')}")
        title = "".join(t.text or "" for t in title_el.iter(_tag(A, "t"))) if title_el is not None else ""

        def point(tagname: str) -> tuple[int, int] | None:
            p = anchor.find(_tag(XDR, tagname))
            if p is None:
                return None
            try:
                v = {n: int(p.findtext(_tag(XDR, n)) or 0) for n in ("col", "colOff", "row", "rowOff")}
            except ValueError:
                return None
            return HEADER_W + v["col"] * COL_W + v["colOff"] // EMU_PER_PX, HEADER_H + v["row"] * ROW_H + v["rowOff"] // EMU_PER_PX

        start, end = point("from"), point("to")
        x, y = start or (HEADER_W + (r + 2) * COL_W, HEADER_H + t * ROW_H)
        w, h = (end[0] - x, end[1] - y) if end else (440, 280)
        charts.append({"id": f"chart{len(charts) + 1}", "type": kind, "range": f"{sh.cell_name(t, l)}:{sh.cell_name(bt, r)}",
                       "title": title, "x": x, "y": y, "w": w, "h": h})
    return charts


def import_xlsx(data: bytes, title: str) -> dict:
    if len(data) > 25 * 1024 * 1024:
        raise ValueError("XLSX files must be 25 MB or smaller")
    try:
        archive = zipfile.ZipFile(BytesIO(data))
    except (zipfile.BadZipFile, OSError) as exc:
        raise ValueError("This is not a valid XLSX workbook") from exc
    with archive:
        infos = archive.infolist()
        if len(infos) > 2000 or sum(i.file_size for i in infos) > 80 * 1024 * 1024:
            raise ValueError("XLSX workbook expands beyond the supported size")
        names = set(archive.namelist())
        if "xl/workbook.xml" not in names or "xl/_rels/workbook.xml.rels" not in names:
            raise ValueError("XLSX workbook is missing its workbook metadata")
        workbook = _safe_xml(archive.read("xl/workbook.xml"))
        sheet = workbook.find(f"{_tag(NS, 'sheets')}/{_tag(NS, 'sheet')}")
        if sheet is None:
            raise ValueError("XLSX workbook has no worksheets")
        worksheet_path = _part_rels(archive, "xl/workbook.xml", names).get(sheet.get(_tag(REL, "id"), ""))
        if not worksheet_path or not worksheet_path.startswith("xl/"):
            raise ValueError("XLSX worksheet reference is invalid")
        shared: list[str] = []
        if "xl/sharedStrings.xml" in names:
            root = _safe_xml(archive.read("xl/sharedStrings.xml"))
            shared = [_text_value(si) for si in root.findall(_tag(NS, "si"))]
        styles = _read_styles(_safe_xml(archive.read("xl/styles.xml"))) if "xl/styles.xml" in names else []
        root = _safe_xml(archive.read(worksheet_path))
        cells = sh.empty_grid()
        formats: dict[str, dict] = {}
        count = 0
        for cell in root.iter(_tag(NS, "c")):
            ix = _col_index(cell.get("r", ""))
            if ix is None:
                continue
            row, col = ix
            if row >= sh.ROWS or col >= sh.COLS:
                continue
            count += 1
            if count > MAX_CELLS:
                break
            style = cell.get("s", "0")
            if style.isdigit() and int(style) < len(styles) and styles[int(style)]:
                formats[sh.cell_name(row, col)] = dict(styles[int(style)])
            formula = cell.find(_tag(NS, "f"))
            value = cell.find(_tag(NS, "v"))
            inline = cell.find(_tag(NS, "is"))
            typ = cell.get("t", "n")
            if formula is not None and formula.text:
                cells[row][col] = "=" + formula.text
            elif typ == "inlineStr" and inline is not None:
                cells[row][col] = _text_value(inline)
            elif value is not None and value.text is not None:
                if typ == "s":
                    try:
                        cells[row][col] = shared[int(value.text)]
                    except (ValueError, IndexError):
                        cells[row][col] = ""
                elif typ == "b":
                    cells[row][col] = "TRUE" if value.text == "1" else "FALSE"
                else:
                    cells[row][col] = value.text
        charts = _import_charts(archive, worksheet_path, root, names)
        return sh.validate({"format": sh.FORMAT, "version": 1, "title": title, "cells": cells, "formats": formats, "charts": charts})


# ---------------------------------------------------------------- export
def _number_text(value: str) -> str | None:
    """The <v> text for a plain number cell, or None to keep it as text (e.g. '007', '+5')."""
    v = value.strip()
    if not sh.NUMBER.match(v) or v.startswith("+") or (len(v) > 1 and v[0] == "0" and v[1].isdigit()):
        return None
    if v.startswith("-0") and len(v) > 2 and v[2].isdigit():
        return None
    if v.startswith("."):
        v = "0" + v
    elif v.startswith("-."):
        v = "-0" + v[1:]
    return v.rstrip(".") if v.endswith(".") else v


def export_xlsx(sheet: dict) -> bytes:
    if not isinstance(sheet, dict) or not isinstance(sheet.get("cells"), list):
        raise ValueError("Atlas spreadsheet has no cell grid")
    try:
        sheet = sh.validate(sheet)
    except sh.SheetError as exc:
        raise ValueError(str(exc)) from exc
    cells, formats = sheet["cells"], sheet["formats"]
    name = _sheet_name(sheet.get("title"))
    styles = _Styles()

    root = ET.Element(_tag(NS, "worksheet"))
    dimension = ET.SubElement(root, _tag(NS, "dimension"), {"ref": "A1"})
    ET.SubElement(root, _tag(NS, "sheetFormatPr"), {"defaultRowHeight": "18", "customHeight": "1"})
    cols = ET.SubElement(root, _tag(NS, "cols"))
    ET.SubElement(cols, _tag(NS, "col"), {"min": "1", "max": str(sh.COLS), "width": "13", "customWidth": "1"})
    sheet_data = ET.SubElement(root, _tag(NS, "sheetData"))
    last_row = last_col = 0
    for r, row in enumerate(cells):
        row_node = None
        for c, value in enumerate(row):
            fmt = formats.get(sh.cell_name(r, c))
            if not value and not fmt:
                continue
            if row_node is None:
                row_node = ET.SubElement(sheet_data, _tag(NS, "row"), {"r": str(r + 1)})
            attrs = {"r": _cell_ref(r, c)}
            if fmt:
                attrs["s"] = str(styles.index(fmt))
            number = _number_text(value) if value else None
            if not value:
                ET.SubElement(row_node, _tag(NS, "c"), attrs)
            elif value.startswith("="):
                node = ET.SubElement(row_node, _tag(NS, "c"), attrs)
                ET.SubElement(node, _tag(NS, "f")).text = value[1:]
            elif value.upper() in ("TRUE", "FALSE"):
                node = ET.SubElement(row_node, _tag(NS, "c"), attrs | {"t": "b"})
                ET.SubElement(node, _tag(NS, "v")).text = "1" if value.upper() == "TRUE" else "0"
            elif number is not None:
                ET.SubElement(ET.SubElement(row_node, _tag(NS, "c"), attrs), _tag(NS, "v")).text = number
            else:
                node = ET.SubElement(row_node, _tag(NS, "c"), attrs | {"t": "inlineStr"})
                ET.SubElement(ET.SubElement(node, _tag(NS, "is")), _tag(NS, "t"), {XML_SPACE: "preserve"}).text = value
            last_row, last_col = max(last_row, r), max(last_col, c)
    dimension.set("ref", f"A1:{_cell_ref(last_row, last_col)}")

    chart_parts = [(chart, xml) for chart in sheet["charts"] if (xml := _chart_xml(chart, cells, name)) is not None]
    if chart_parts:
        ET.SubElement(root, _tag(NS, "drawing"), {_tag(REL, "id"): "rId1"})

    workbook = ET.Element(_tag(NS, "workbook"))
    sheets = ET.SubElement(workbook, _tag(NS, "sheets"))
    ET.SubElement(sheets, _tag(NS, "sheet"), {"name": name, "sheetId": "1", _tag(REL, "id"): "rId1"})
    ET.SubElement(workbook, _tag(NS, "calcPr"), {"calcId": "191029", "fullCalcOnLoad": "1"})  # formulas carry no cached values

    types = ET.Element(_tag(CT, "Types"))
    ET.SubElement(types, _tag(CT, "Default"), {"Extension": "rels", "ContentType": "application/vnd.openxmlformats-package.relationships+xml"})
    ET.SubElement(types, _tag(CT, "Default"), {"Extension": "xml", "ContentType": "application/xml"})
    office = "application/vnd.openxmlformats-officedocument"
    for part, ctype in (("/xl/workbook.xml", f"{office}.spreadsheetml.sheet.main+xml"),
                        ("/xl/worksheets/sheet1.xml", f"{office}.spreadsheetml.worksheet+xml"),
                        ("/xl/styles.xml", f"{office}.spreadsheetml.styles+xml")):
        ET.SubElement(types, _tag(CT, "Override"), {"PartName": part, "ContentType": ctype})
    if chart_parts:
        ET.SubElement(types, _tag(CT, "Override"), {"PartName": "/xl/drawings/drawing1.xml", "ContentType": f"{office}.drawing+xml"})
        for n in range(1, len(chart_parts) + 1):
            ET.SubElement(types, _tag(CT, "Override"), {"PartName": f"/xl/charts/chart{n}.xml", "ContentType": f"{office}.drawingml.chart+xml"})

    output = BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", _xml(types))
        archive.writestr("_rels/.rels", _rels([("rId1", "officeDocument", "xl/workbook.xml")]))
        archive.writestr("xl/workbook.xml", _xml(workbook))
        archive.writestr("xl/_rels/workbook.xml.rels", _rels([("rId1", "worksheet", "worksheets/sheet1.xml"), ("rId2", "styles", "styles.xml")]))
        archive.writestr("xl/worksheets/sheet1.xml", _xml(root))
        archive.writestr("xl/styles.xml", styles.xml())
        if chart_parts:
            archive.writestr("xl/worksheets/_rels/sheet1.xml.rels", _rels([("rId1", "drawing", "../drawings/drawing1.xml")]))
            archive.writestr("xl/drawings/drawing1.xml", _drawing_xml([c for c, _ in chart_parts]))
            archive.writestr("xl/drawings/_rels/drawing1.xml.rels",
                             _rels([(f"rId{n}", "chart", f"../charts/chart{n}.xml") for n in range(1, len(chart_parts) + 1)]))
            for n, (_, xml) in enumerate(chart_parts, 1):
                archive.writestr(f"xl/charts/chart{n}.xml", xml)
    return output.getvalue()
