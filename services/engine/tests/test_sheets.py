import json
import zipfile
import io

import pytest

from atlas_engine.core_client import CoreClient
from atlas_engine.providers.gemini import _clean_schema
from atlas_engine.sheets import atlasheet as sh
from atlas_engine.sheets.service import SheetsService
from atlas_engine.sheets.tools import register
from atlas_engine.sheets.xlsx import export_xlsx, import_xlsx
from atlas_engine.tools import ToolContext, ToolError, ToolRegistry

from conftest import ui


# ---------------- model ----------------
def test_validate_keeps_clean_formats_and_charts_only():
    s = sh.validate({"format": "atlas.sheet", "cells": [["x"]],
                     "formats": {"a1": {"b": 1, "num": "currency", "cur": "GHS", "evil": "<script>"}, "ZZ999": {"b": True}},
                     "charts": [{"type": "pie", "range": "a1:b3", "w": 99999}, {"type": "nope", "range": "A1:B2"}, {"type": "bar", "range": "bad"}]})
    assert s["formats"] == {"A1": {"b": True, "num": "currency", "cur": "GHS"}}
    assert [c["type"] for c in s["charts"]] == ["pie"] and s["charts"][0]["range"] == "A1:B3" and s["charts"][0]["w"] == 1200
    with pytest.raises(sh.SheetError):
        sh.validate({"format": "other"})


def test_xlsx_round_trip_keeps_values_and_formulas():
    sheet = sh.new_sheet("Budget", [["Item", "Cost"], ["Rent", "1200"], ["Food", "400"], ["Total", "=SUM(B2:B3)"], ['a<b & "c"', ""]])
    data = export_xlsx(sheet)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        assert "xl/worksheets/sheet1.xml" in z.namelist()
    back = import_xlsx(data, "Budget")
    assert [r[:2] for r in back["cells"][:5]] == [["Item", "Cost"], ["Rent", "1200"], ["Food", "400"], ["Total", "=SUM(B2:B3)"], ['a<b & "c"', ""]]


def test_gemini_schema_gets_single_types():
    out = _clean_schema({"type": "array", "items": {"type": ["string", "number", "null"], "pattern": "x"}})
    assert out == {"type": "array", "items": {"type": "string", "nullable": True}}


# ---------------- tools against the real core ----------------
def test_sheets_tools_build_a_budget_with_a_chart(core, tmp_path):
    info, _ = core
    docs = tmp_path / "Documents"
    docs.mkdir()
    grant = ui(info, "grants.add", path=str(docs))["id"]
    client = CoreClient(info["port"], info["engine_token"])
    reg = ToolRegistry()
    register(reg, client, SheetsService(client))
    ctx = ToolContext(task_id="t")

    r = reg.call("sheets.create", {
        "grant": grant, "path": "budget", "title": "Monthly budget",
        "rows": [["Category", "Amount"], ["Rent", 1200], ["Food", 400.0], ["Transport", "150"], ["Total", "=SUM(B2:B4)"]],
        "formats": [{"range": "A1:B1", "format": {"bold": True}}, {"range": "B2:B5", "format": {"number_format": "currency", "currency": "GHS", "decimals": 2}}],
        "charts": [{"type": "column", "range": "A1:B4", "title": "Spending"}],
    }, ctx)
    assert r.content["path"] == "budget.atlasheet" and r.content["charts"] == 1 and r.changed[0]["path"] == "budget.atlasheet"
    saved = json.loads((docs / "budget.atlasheet").read_text())
    assert saved["cells"][2][1] == "400" and saved["cells"][4][1] == "=SUM(B2:B4)"
    assert saved["formats"]["A1"] == {"b": True} and saved["formats"]["B3"] == {"num": "currency", "cur": "GHS", "dp": 2}
    assert saved["charts"][0]["range"] == "A1:B4" and saved["charts"][0]["title"] == "Spending"

    with pytest.raises(ToolError, match="already exists"):
        reg.call("sheets.create", {"grant": grant, "path": "budget.atlasheet", "title": "x", "rows": [["a"]]}, ctx)

    reg.call("sheets.write_range", {"grant": grant, "path": "budget.atlasheet", "start": "a6", "rows": [["Savings", 250]]}, ctx)
    reg.call("sheets.format_range", {"grant": grant, "path": "budget.atlasheet", "range": "A1:B1", "format": {"bold": False, "align": "center"}}, ctx)
    reg.call("sheets.create_chart", {"grant": grant, "path": "budget.atlasheet", "type": "pie", "range": "A1:B4"}, ctx)
    out = reg.call("sheets.read", {"grant": grant, "path": "budget.atlasheet"}, ctx)
    assert out.untrusted and out.content["used_range"] == "A1:B6"
    assert out.content["rows"][5]["cells"] == {"A6": "Savings", "B6": "250"}
    assert out.content["formats"]["A1"] == {"align": "center"}
    assert [c["type"] for c in out.content["charts"]] == ["column", "pie"]

    with pytest.raises(ToolError, match="does not fit"):
        reg.call("sheets.write_range", {"grant": grant, "path": "budget.atlasheet", "start": "T80", "rows": [["a", "b"]]}, ctx)
    with pytest.raises(ToolError, match="not a range"):
        reg.call("sheets.create_chart", {"grant": grant, "path": "budget.atlasheet", "type": "bar", "range": "nope"}, ctx)

    e = reg.call("sheets.export_xlsx", {"grant": grant, "path": "budget.atlasheet"}, ctx)
    assert (docs / e.content["path"]).exists()
    back = import_xlsx((docs / e.content["path"]).read_bytes(), "b")
    assert back["cells"][4][1] == "=SUM(B2:B4)"



# ---------------- XLSX formatting and charts ----------------
def _styled_budget():
    return sh.validate({"format": "atlas.sheet", "title": "Budget",
                        "cells": [["Item", "Cost", "Share"], ["Rent", "1200", "0.75"], ["Food", "400", "0.25"], ["Total", "=SUM(B2:B3)", ""], ["Paid", "TRUE", "007"]],
                        "formats": {"A1": {"b": True, "align": "center"}, "B2": {"num": "currency", "cur": "GHS"}, "B3": {"num": "currency", "cur": "EUR", "dp": 0},
                                    "C2": {"num": "percent", "dp": 1}, "A4": {"i": True, "u": True}, "B4": {"num": "number", "dp": 3}, "A6": {"num": "date"}},
                        "charts": [{"type": "column", "range": "A1:B3", "title": "Costs", "x": 332, "y": 48}, {"type": "pie", "range": "A1:B3"},
                                   {"type": "line", "range": "A1:C3"}, {"type": "bar", "range": "A1:B3"}]})


def test_xlsx_export_writes_numbers_styles_and_charts():
    data = export_xlsx(_styled_budget())
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        ws = z.read("xl/worksheets/sheet1.xml").decode()
        assert {"xl/styles.xml", "xl/drawings/drawing1.xml", "xl/charts/chart4.xml"} <= set(z.namelist())
        b2 = ws.split('r="B2"')[1].split("</c>")[0]
        assert "<v>1200</v>" in b2 and "inlineStr" not in b2  # numeric, so Excel's SUM counts it
        assert 't="b"' in ws and "007" in ws.split('r="C5"')[1].split("</c>")[0] and "<drawing" in ws
        chart = z.read("xl/charts/chart1.xml").decode()
        assert 'barDir val="col"' in chart and "'Budget'!$B$2:$B$3" in chart and "'Budget'!$A$2:$A$3" in chart and "Costs" in chart
        assert "fullCalcOnLoad" in z.read("xl/workbook.xml").decode()


def test_xlsx_round_trip_keeps_formats_and_charts():
    sheet = _styled_budget()
    back = import_xlsx(export_xlsx(sheet), "Budget")
    assert back["cells"][1][1] == "1200" and back["cells"][3][1] == "=SUM(B2:B3)" and back["cells"][4][1] == "TRUE" and back["cells"][4][2] == "007"
    assert back["formats"] == sheet["formats"]
    assert [(c["type"], c["range"], c["title"]) for c in back["charts"]] == [("column", "A1:B3", "Costs"), ("pie", "A1:B3", ""), ("line", "A1:C3", ""), ("bar", "A1:B3", "")]
    assert (back["charts"][0]["x"], back["charts"][0]["y"], back["charts"][0]["w"], back["charts"][0]["h"]) == (332, 48, 440, 280)


def test_excel_number_formats_map_to_atlas_formats():
    from atlas_engine.sheets.xlsx import _atlas_numfmt
    assert _atlas_numfmt("#,##0.00", 164) == {"num": "number"}
    assert _atlas_numfmt("#,##0", 3) == {"num": "number", "dp": 0}
    assert _atlas_numfmt('"$"#,##0.00;[Red]-"$"#,##0.00', 164) == {"num": "currency", "cur": "USD"}
    assert _atlas_numfmt("[$€-407] #,##0", 164) == {"num": "currency", "cur": "EUR", "dp": 0}
    assert _atlas_numfmt("0.0%", 164) == {"num": "percent", "dp": 1}
    assert _atlas_numfmt("yyyy-mm-dd", 164) == {"num": "date"} and _atlas_numfmt(None, 14) == {"num": "date"}
    assert _atlas_numfmt("General", 164) == {} and _atlas_numfmt(None, 0) == {}


def test_openpyxl_reads_the_exported_workbook():
    openpyxl = pytest.importorskip("openpyxl")
    ws = openpyxl.load_workbook(io.BytesIO(export_xlsx(_styled_budget()))).active
    assert ws["B2"].value == 1200 and ws["B2"].number_format == '"GH₵"#,##0.00' and ws["C2"].number_format == "0.0%"
    assert ws["A1"].font.b and ws["A1"].alignment.horizontal == "center" and ws["A4"].font.u == "single"
    assert ws["B5"].value is True and ws["C5"].value == "007"
    assert [type(c).__name__ for c in ws._charts] == ["BarChart", "PieChart", "LineChart", "BarChart"]
