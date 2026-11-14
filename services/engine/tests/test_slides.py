import io
import json
import zipfile

import pytest

from atlas_engine.core_client import CoreClient
from atlas_engine.slides import atlasdeck as dk
from atlas_engine.slides.pptx import export_pptx
from atlas_engine.slides.service import SlidesService
from atlas_engine.slides.tools import register
from atlas_engine.tools import ToolContext, ToolError, ToolRegistry

from conftest import ui


def _deck():
    d = dk.new_deck("Quarterly review", "midnight")
    d["slides"] += [dk.fill_slide("title-content", "Results", body=["Revenue up 12%", "\tAccra & Lagos", "Hiring <on track>"], notes="Mention the Accra office.\nThen pause."),
                    dk.fill_slide("section", "Next year", "Plans"), dk.fill_slide("two-content", "Pros and cons", body=["Fast"], body2=["Costly"])]
    return d


# ---------------- model ----------------
def test_validate_cleans_untrusted_decks():
    d = dk.validate({"format": "atlas.deck", "title": "T", "theme": "nope", "slides": [
        {"layout": "weird", "elements": [{"role": "evil", "x": 1e12, "text": 5, "bold": "yes", "align": "justify", "size": 1}, "junk"], "notes": None}, "junk"]})
    assert d["theme"] == "atlas" and len(d["slides"]) == 1
    s = d["slides"][0]
    assert s["layout"] == "blank" and s["notes"] == ""
    e = s["elements"][0]
    assert e["role"] == "text" and e["x"] == 2560 and e["text"] == "" and e["size"] == 8 and "bold" not in e and "align" not in e
    assert dk.validate({"format": "atlas.deck", "slides": []})["slides"][0]["layout"] == "title"
    with pytest.raises(dk.DeckError):
        dk.validate({"format": "atlas.sheet", "slides": []})


def test_fill_slide_puts_text_in_layout_boxes():
    s = dk.fill_slide("two-content", "Compare", body=["a", "b"], body2=["c"], notes="n")
    assert [(e["role"], e["text"]) for e in s["elements"]] == [("title", "Compare"), ("body", "a\nb"), ("body", "c")]
    assert dk.fill_slide("title", "Hi", body=["fallback"])["elements"][1]["text"] == "fallback"


# ---------------- PPTX ----------------
def test_pptx_package_has_slides_notes_and_theme_colours():
    data = export_pptx(_deck())
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = set(z.namelist())
        assert {f"ppt/slides/slide{i}.xml" for i in range(1, 5)} <= names
        assert "ppt/notesSlides/notesSlide1.xml" in names and "ppt/notesSlides/notesSlide2.xml" not in names
        s2 = z.read("ppt/slides/slide2.xml").decode()
        assert 'srgbClr val="101826"' in s2 and "Hiring &lt;on track&gt;" in s2 and 'buChar char="•"' in s2
        assert "Accra &amp; Lagos" in s2 and 'b="1"' in s2
        assert "Mention the Accra office." in z.read("ppt/notesSlides/notesSlide1.xml").decode()
        assert "Accent bar" in z.read("ppt/slides/slide3.xml").decode()
        for name in names:  # every part is well-formed XML
            if name.endswith((".xml", ".rels")):
                __import__("xml.etree.ElementTree").etree.ElementTree.fromstring(z.read(name))


def test_pptx_strips_characters_xml_cannot_hold():
    d = dk.new_deck("Bad\x00chars\x0b here")
    assert b"Badchars here" in zipfile.ZipFile(io.BytesIO(export_pptx(d))).read("ppt/slides/slide1.xml")


def test_python_pptx_reads_the_export():
    pptx = pytest.importorskip("pptx")
    prs = pptx.Presentation(io.BytesIO(export_pptx(_deck())))
    assert (prs.slide_width, prs.slide_height) == (12192000, 6858000) and len(prs.slides) == 4
    s = prs.slides[1]
    texts = [sh.text_frame.text for sh in s.shapes if sh.has_text_frame]
    assert texts == ["Results", "Revenue up 12%\nAccra & Lagos\nHiring <on track>"]
    body = [sh for sh in s.shapes if sh.has_text_frame][1].text_frame
    assert [p.level for p in body.paragraphs] == [0, 0, 0] and body.paragraphs[1]._p.pPr.get("marL") > body.paragraphs[0]._p.pPr.get("marL")
    assert s.has_notes_slide and s.notes_slide.notes_text_frame.text == "Mention the Accra office.\nThen pause."
    assert not prs.slides[2].has_notes_slide
    title = [sh for sh in prs.slides[0].shapes if sh.has_text_frame][0]
    assert title.left == 120 * 9525 and title.text_frame.paragraphs[0].runs[0].font.bold


# ---------------- tools against the real core ----------------
def test_slides_tools_build_and_edit_a_deck(core, tmp_path):
    info, _ = core
    docs = tmp_path / "Talks"
    docs.mkdir()
    grant = ui(info, "grants.add", path=str(docs))["id"]
    client = CoreClient(info["port"], info["engine_token"])
    reg = ToolRegistry()
    register(reg, SlidesService(client))
    ctx = ToolContext(task_id="t")

    r = reg.call("slides.create", {"grant": grant, "path": "pitch", "title": "Pitch", "theme": "ocean", "slides": [
        {"layout": "title", "title": "Atlas", "subtitle": "A local-first suite"},
        {"layout": "title-content", "title": "Problem", "bullets": ["Too many apps", "\tNo privacy"], "notes": "Tell the story."},
        {"layout": "section", "title": "Demo"}]}, ctx)
    assert r.content == {"path": "pitch.atlasdeck", "slides": 3} and r.changed[0]["path"] == "pitch.atlasdeck"
    saved = dk.validate(json.loads((docs / "pitch.atlasdeck").read_text()))
    assert saved["theme"] == "ocean" and saved["slides"][1]["elements"][1]["text"] == "Too many apps\n\tNo privacy"

    with pytest.raises(ToolError, match="already exists"):
        reg.call("slides.create", {"grant": grant, "path": "pitch.atlasdeck", "title": "x", "slides": [{"layout": "blank"}]}, ctx)

    reg.call("slides.add_slides", {"grant": grant, "path": "pitch.atlasdeck", "after": 1, "slides": [{"layout": "title-content", "title": "Why now", "bullets": ["AI"]}]}, ctx)
    reg.call("slides.update_slide", {"grant": grant, "path": "pitch.atlasdeck", "slide": 3, "bullets": ["Too many apps", "Cloud lock-in"], "notes": "Short."}, ctx)
    reg.call("slides.update_slide", {"grant": grant, "path": "pitch.atlasdeck", "slide": 4, "layout": "title-content", "bullets": ["Live demo"]}, ctx)
    with pytest.raises(ToolError, match="no box for bullets_right"):
        reg.call("slides.update_slide", {"grant": grant, "path": "pitch.atlasdeck", "slide": 3, "bullets_right": ["x"]}, ctx)
    reg.call("slides.move_slide", {"grant": grant, "path": "pitch.atlasdeck", "slide": 4, "to": 2}, ctx)
    reg.call("slides.set_theme", {"grant": grant, "path": "pitch.atlasdeck", "theme": "paper"}, ctx)

    out = reg.call("slides.read", {"grant": grant, "path": "pitch.atlasdeck"}, ctx)
    assert out.untrusted and out.content["theme"] == "paper"
    assert [s["text"][0]["text"] for s in out.content["slides"]] == ["Atlas", "Demo", "Why now", "Problem"]
    assert out.content["slides"][1]["layout"] == "title-content" and out.content["slides"][1]["text"][1]["text"] == "Live demo"
    assert out.content["slides"][3]["notes"] == "Short." and out.content["slides"][3]["text"][1]["text"] == "Too many apps\nCloud lock-in"

    reg.call("slides.delete_slides", {"grant": grant, "path": "pitch.atlasdeck", "slides": [3]}, ctx)
    with pytest.raises(ToolError, match="at least one slide"):
        reg.call("slides.delete_slides", {"grant": grant, "path": "pitch.atlasdeck", "slides": [1, 2, 3]}, ctx)
    with pytest.raises(ToolError, match="does not exist"):
        reg.call("slides.move_slide", {"grant": grant, "path": "pitch.atlasdeck", "slide": 9, "to": 1}, ctx)

    e = reg.call("slides.export_pptx", {"grant": grant, "path": "pitch.atlasdeck"}, ctx)
    assert e.content["path"] == "pitch.pptx" and e.content["slides"] == 3 and (docs / "pitch.pptx").exists()
    assert reg.call("slides.export_pptx", {"grant": grant, "path": "pitch.atlasdeck"}, ctx).content["path"] == "pitch (1).pptx"
