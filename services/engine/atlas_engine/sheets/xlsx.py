"""Small, dependency-free XLSX reader/writer for Atlas Sheets' single-grid format.

Handles the first worksheet, shared/inline strings, booleans, numeric cells and formulas.
It intentionally leaves Excel styles, macros, external links and multiple sheets untouched.
"""
from __future__ import annotations

import posixpath
import re
import xml.etree.ElementTree as ET
import zipfile
from io import BytesIO

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
MAX_CELLS = 80 * 20


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


def _cell_ref(row: int, col: int) -> str:
    letters = ""
    n = col + 1
    while n:
        n, rem = divmod(n - 1, 26)
        letters = chr(65 + rem) + letters
    return f"{letters}{row + 1}"


def _safe_xml(data: bytes) -> ET.Element:
    # ElementTree does not resolve external entities; reject DTD declarations explicitly.
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ValueError("XLSX contains unsupported XML declarations")
    try:
        return ET.fromstring(data)
    except ET.ParseError as exc:
        raise ValueError("XLSX contains malformed XML") from exc


def _text_value(element: ET.Element) -> str:
    return "".join(node.text or "" for node in element.iter(_tag(NS, "t")))


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
        rid = sheet.get(_tag(REL, "id"))
        rels = _safe_xml(archive.read("xl/_rels/workbook.xml.rels"))
        target = next((r.get("Target") for r in rels.findall(_tag(PKG_REL, "Relationship")) if r.get("Id") == rid), None)
        if not target or target.startswith(("http:", "https:")):
            raise ValueError("XLSX worksheet reference is invalid")
        if target.startswith("/xl/"):
            target = target[1:]
        elif target.startswith("/"):
            raise ValueError("XLSX worksheet reference is invalid")
        worksheet_path = posixpath.normpath(target if target.startswith("xl/") else posixpath.join("xl", target))
        if not worksheet_path.startswith("xl/") or worksheet_path not in names:
            raise ValueError("XLSX worksheet reference is invalid")
        shared: list[str] = []
        if "xl/sharedStrings.xml" in names:
            root = _safe_xml(archive.read("xl/sharedStrings.xml"))
            shared = [_text_value(si) for si in root.findall(_tag(NS, "si"))]
        root = _safe_xml(archive.read(worksheet_path))
        cells = [["" for _ in range(20)] for _ in range(80)]
        count = 0
        for cell in root.iter(_tag(NS, "c")):
            ix = _col_index(cell.get("r", ""))
            if ix is None:
                continue
            row, col = ix
            if row >= 80 or col >= 20:
                continue
            count += 1
            if count > MAX_CELLS:
                break
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
        return {"format": "atlas.sheet", "version": 1, "title": title, "cells": cells}


def export_xlsx(sheet: dict) -> bytes:
    cells = sheet.get("cells")
    if not isinstance(cells, list):
        raise ValueError("Atlas spreadsheet has no cell grid")
    ET.register_namespace("", NS)
    ET.register_namespace("r", REL)
    root = ET.Element(_tag(NS, "worksheet"))
    dimension = ET.SubElement(root, _tag(NS, "dimension"), {"ref": "A1"})
    sheet_data = ET.SubElement(root, _tag(NS, "sheetData"))
    last_row = 0
    last_col = 0
    for r, row in enumerate(cells[:80]):
        if not isinstance(row, list):
            continue
        row_node = None
        for c, value in enumerate(row[:20]):
            value = str(value or "")
            if not value:
                continue
            if row_node is None:
                row_node = ET.SubElement(sheet_data, _tag(NS, "row"), {"r": str(r + 1)})
            ref = _cell_ref(r, c)
            attrs = {"r": ref}
            if value.startswith("="):
                node = ET.SubElement(row_node, _tag(NS, "c"), attrs)
                ET.SubElement(node, _tag(NS, "f")).text = value[1:]
                ET.SubElement(node, _tag(NS, "v"))
            else:
                node = ET.SubElement(row_node, _tag(NS, "c"), attrs | {"t": "inlineStr"})
                inline = ET.SubElement(node, _tag(NS, "is"))
                ET.SubElement(inline, _tag(NS, "t"), {"{http://www.w3.org/XML/1998/namespace}space": "preserve"}).text = value
            last_row, last_col = max(last_row, r), max(last_col, c)
    dimension.set("ref", f"A1:{_cell_ref(last_row, last_col)}")
    worksheet = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    workbook = ET.Element(_tag(NS, "workbook"))
    sheets = ET.SubElement(workbook, _tag(NS, "sheets"))
    sheet_name = re.sub(r"[:\\/?*\[\]]", "-", str(sheet.get("title") or "Sheet1")).strip("'")[:31] or "Sheet1"
    ET.SubElement(sheets, _tag(NS, "sheet"), {"name": sheet_name, "sheetId": "1", _tag(REL, "id"): "rId1"})
    workbook_xml = ET.tostring(workbook, encoding="utf-8", xml_declaration=True)
    rels = ET.Element(_tag(PKG_REL, "Relationships"))
    ET.SubElement(rels, _tag(PKG_REL, "Relationship"), {"Id": "rId1", "Type": f"{REL}/worksheet", "Target": "worksheets/sheet1.xml"})
    rels_xml = ET.tostring(rels, encoding="utf-8", xml_declaration=True)
    pkg_rels = ET.Element(_tag(PKG_REL, "Relationships"))
    ET.SubElement(pkg_rels, _tag(PKG_REL, "Relationship"), {"Id": "rId1", "Type": f"{REL}/officeDocument", "Target": "xl/workbook.xml"})
    pkg_rels_xml = ET.tostring(pkg_rels, encoding="utf-8", xml_declaration=True)
    types = ET.Element(_tag(CT, "Types"))
    ET.SubElement(types, _tag(CT, "Default"), {"Extension": "rels", "ContentType": "application/vnd.openxmlformats-package.relationships+xml"})
    ET.SubElement(types, _tag(CT, "Default"), {"Extension": "xml", "ContentType": "application/xml"})
    ET.SubElement(types, _tag(CT, "Override"), {"PartName": "/xl/workbook.xml", "ContentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"})
    ET.SubElement(types, _tag(CT, "Override"), {"PartName": "/xl/worksheets/sheet1.xml", "ContentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"})
    types_xml = ET.tostring(types, encoding="utf-8", xml_declaration=True)
    output = BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", types_xml)
        archive.writestr("_rels/.rels", pkg_rels_xml)
        archive.writestr("xl/workbook.xml", workbook_xml)
        archive.writestr("xl/_rels/workbook.xml.rels", rels_xml)
        archive.writestr("xl/worksheets/sheet1.xml", worksheet)
    return output.getvalue()
