import base64
import json
import shutil
import zipfile
import io

import pytest

from atlas_engine.core_client import CoreClient
from atlas_engine.tools import ToolContext, ToolError, ToolRegistry
from atlas_engine.writer import atlasdoc as ad
from atlas_engine.writer.converter import LibreOffice
from atlas_engine.writer.service import WriterService, register

from conftest import ui

HAS_LO = bool(shutil.which("soffice") or shutil.which("libreoffice"))


# ---------------- model ----------------
def test_sanitizer_strips_scripts_and_unsafe_links():
    s = ad.sanitize_inline('<b>ok</b><script>alert(1)</script><a href="javascript:x">click</a><img src=x onerror=1>'
                           '<a href="https://ex.com" onclick="y">site</a><i><b>nest</i></b>')
    assert "script" not in s and "javascript" not in s and "onerror" not in s and "onclick" not in s
    assert '<a href="https://ex.com">site</a>' in s and "click" in s
    assert s.count("<b>") == s.count("</b>")


def test_inline_markdown():
    assert ad.inline_from_text("a **b** *c* `d` [e](https://f.org) <x>") == \
        'a <b>b</b> <i>c</i> <code>d</code> <a href="https://f.org">e</a> &lt;x&gt;'


def test_validate_rejects_garbage_and_normalises():
    with pytest.raises(ad.DocError):
        ad.validate({"format": "nope"})
    d = ad.validate({"format": "atlas.doc", "version": 1, "title": "T", "blocks": [
        {"id": "x", "type": "paragraph", "html": "<script>1</script>hi"}, {"id": "x", "type": "heading1", "html": "h"}]})
    assert d["blocks"][0]["html"] == "hi" and d["blocks"][0]["id"] != d["blocks"][1]["id"]


def test_to_html_groups_lists():
    doc = ad.new_document("T", [ad.make_block("bullet", "a"), ad.make_block("bullet", "b"), ad.make_block("numbered", "c"),
                                ad.make_block("paragraph", "p"), ad.make_block("pagebreak"), ad.make_block("heading2", "H")])
    h = ad.to_html(doc)
    assert "<ul><li>a</li><li>b</li></ul><ol><li>c</li></ol><p>p</p>" in h
    assert 'page-break-before: always' in h


LO_SAMPLE = """<body><h1 class="western" align="left">Title</h1>
<p class="western" align="center">Hello <b>bold</b> and <i>it</i>.</p>
<ul><li><p class="western">a</p></li><li><p class="western">b</p></li></ul>
<table><tr><td><p>x</p></td><td><p>y</p></td></tr></table><p><br/><br/></p></body>"""


def test_from_libreoffice_html():
    d = ad.from_html(LO_SAMPLE)
    types = [b["type"] for b in d["blocks"]]
    assert types == ["heading1", "paragraph", "bullet", "bullet", "table"]
    assert d["title"] == "Title"
    assert d["blocks"][1]["html"] == "Hello <b>bold</b> and <i>it</i>." and d["blocks"][1]["align"] == "center"
    assert d["blocks"][4]["rows"] == [["x", "y"]]


# ---------------- real LibreOffice ----------------
@pytest.mark.skipif(not HAS_LO, reason="LibreOffice not installed")
def test_libreoffice_roundtrip(tmp_path):
    lo = LibreOffice(tmp_path / "profile")
    doc = ad.new_document("Quarterly report", [
        ad.make_block("title", "Quarterly report"), ad.make_block("heading1", "Summary"),
        ad.make_block("paragraph", "Revenue grew **12%** in *Q3*."), ad.make_block("bullet", "Shipped Writer"),
        ad.make_block("bullet", "Shipped Drive"), ad.make_block("table", rows=[["Metric", "Value"], ["Users", "1200"]])])
    docx = lo.convert_bytes(ad.to_html(doc).encode(), ".html", "docx", html_input=True)
    xml = zipfile.ZipFile(io.BytesIO(docx)).read("word/document.xml").decode()
    assert 'w:val="Heading1"' in xml and "Revenue grew" in xml and "Users" in xml
    pdf = lo.convert_bytes(ad.to_html(doc).encode(), ".html", "pdf", html_input=True)
    assert pdf[:5] == b"%PDF-"
    back = ad.from_html(lo.convert_bytes(docx, ".docx", "html").decode())
    texts = [ad.inline_to_text(b.get("html", "")) for b in back["blocks"] if b["type"] != "table"]
    assert "Summary" in texts and "Shipped Writer" in texts
    para = next(b for b in back["blocks"] if "Revenue" in b.get("html", ""))
    assert "<b>12%</b>" in para["html"] and "<i>Q3</i>" in para["html"]
    assert any(b["type"] == "bullet" for b in back["blocks"])
    assert next(b for b in back["blocks"] if b["type"] == "table")["rows"][1] == ["Users", "1200"]


# ---------------- tools against the real core ----------------
def test_writer_tools_end_to_end(core, tmp_path):
    info, _ = core
    docs = tmp_path / "Documents"
    docs.mkdir()
    grant = ui(info, "grants.add", path=str(docs))["id"]
    client = CoreClient(info["port"], info["engine_token"])
    reg = ToolRegistry()
    register(reg, WriterService(client, LibreOffice(tmp_path / "lo")))
    ctx = ToolContext(task_id="t")
    r = reg.call("writer.create_document", {"grant": grant, "path": "plan", "title": "Plan",
                                            "blocks": [{"type": "heading1", "text": "Goals"}, {"type": "bullet", "text": "Ship"}]}, ctx)
    assert r.content["path"] == "plan.atlasdoc" and r.changed[0]["path"] == "plan.atlasdoc"
    with pytest.raises(ToolError, match="already exists"):
        reg.call("writer.create_document", {"grant": grant, "path": "plan.atlasdoc", "title": "x", "blocks": [{"type": "paragraph"}]}, ctx)
    reg.call("writer.insert_blocks", {"grant": grant, "path": "plan.atlasdoc", "after": 2, "blocks": [{"type": "bullet", "text": "Test"}]}, ctx)
    reg.call("writer.update_block", {"grant": grant, "path": "plan.atlasdoc", "index": 1, "text": "Goals for Q4"}, ctx)
    out = reg.call("writer.read_document", {"grant": grant, "path": "plan.atlasdoc"}, ctx)
    assert [b["text"] for b in out.content["blocks"]] == ["Plan", "Goals for Q4", "Ship", "Test"] and out.untrusted
    reg.call("writer.delete_blocks", {"grant": grant, "path": "plan.atlasdoc", "index": 3, "count": 1}, ctx)
    saved = json.loads((docs / "plan.atlasdoc").read_text())
    assert len(saved["blocks"]) == 3
    with pytest.raises(ToolError, match="out of range"):
        reg.call("writer.update_block", {"grant": grant, "path": "plan.atlasdoc", "index": 99, "text": "x"}, ctx)
    if HAS_LO:
        e = reg.call("writer.export", {"grant": grant, "path": "plan.atlasdoc", "format": "docx"}, ctx)
        assert (docs / "plan.docx").exists() and e.content["path"] == "plan.docx"
        imp = reg.call("writer.import", {"grant": grant, "path": "plan.docx"}, ctx)
        assert imp.content["path"] == "plan (1).atlasdoc"
        assert "Goals for Q4" in (docs / "plan (1).atlasdoc").read_text()
