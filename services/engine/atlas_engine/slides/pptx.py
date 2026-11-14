"""Dependency-free PowerPoint (.pptx) writer for Atlas presentations.

Writes each slide's background colour, text boxes (position, size, font size, bold/italic/underline, alignment,
bullets with indent levels), the section-header accent bar and speaker notes, using the deck's theme colours.
"""
from __future__ import annotations

import re
import zipfile
from datetime import datetime, timezone
from io import BytesIO
from xml.sax.saxutils import escape, quoteattr

from . import atlasdeck as dk

EMU = 9525  # EMU per slide pixel: 1280 px = 13.333 in = 12192000 EMU
NS = ('xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"')
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PML = "application/vnd.openxmlformats-officedocument.presentationml"
DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
_BAD_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")
CLR_MAP = ('bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" '
           'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"')


def _t(s: str) -> str:
    return escape(_BAD_XML.sub("", s))


def _a(s: str) -> str:
    return quoteattr(_BAD_XML.sub("", s))


def _rels(items: list[tuple[str, str]]) -> str:
    body = "".join(f'<Relationship Id="rId{i}" Type="{REL}/{typ}" Target={_a(target)}/>' for i, (typ, target) in enumerate(items, 1))
    return f'{DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{body}</Relationships>'


def _theme(name: str, th: dict) -> str:
    font = _a(th["font"])
    clr = lambda tag, v: f"<a:{tag}><a:srgbClr val=\"{v}\"/></a:{tag}>"  # noqa: E731
    fills = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' * 3
    lines = '<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' * 3
    effects = "<a:effectStyle><a:effectLst/></a:effectStyle>" * 3
    return (f'{DECL}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name={_a(name)}><a:themeElements>'
            f'<a:clrScheme name={_a(name)}>{clr("dk1", th["fg"])}{clr("lt1", th["bg"])}{clr("dk2", th["fg"])}{clr("lt2", th["bg"])}'
            f'{clr("accent1", th["accent"])}{clr("accent2", th["muted"])}{clr("accent3", "1BAF7A")}{clr("accent4", "EDA100")}'
            f'{clr("accent5", "E87BA4")}{clr("accent6", "6250D6")}{clr("hlink", th["accent"])}{clr("folHlink", th["muted"])}</a:clrScheme>'
            f'<a:fontScheme name={_a(name)}><a:majorFont><a:latin typeface={font}/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>'
            f'<a:minorFont><a:latin typeface={font}/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>'
            f'<a:fmtScheme name={_a(name)}><a:fillStyleLst>{fills}</a:fillStyleLst><a:lnStyleLst>{lines}</a:lnStyleLst>'
            f'<a:effectStyleLst>{effects}</a:effectStyleLst><a:bgFillStyleLst>{fills}</a:bgFillStyleLst></a:fmtScheme>'
            '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>')


_GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'


def _paragraphs(e: dict, th: dict) -> str:
    color = th["muted"] if e["role"] == "subtitle" else th["fg"]
    sz = max(100, min(400000, round(e["size"] * 75)))  # px → hundredths of a point (0.75 pt per px)
    flags = (' b="1"' if e.get("bold") else "") + (' i="1"' if e.get("italic") else "") + (' u="sng"' if e.get("underline") else "")
    rpr = (f'<a:rPr lang="en-US" sz="{sz}"{flags} dirty="0"><a:solidFill><a:srgbClr val="{color}"/></a:solidFill>'
           f'<a:latin typeface={_a(th["font"])}/></a:rPr>')
    algn = {"center": "ctr", "right": "r"}.get(e.get("align", "left"), "l")
    out = []
    for line in e["text"].split("\n") or [""]:
        level = 0
        if e.get("bullets"):
            m = re.match(r"^(\t|  )*", line)
            level = min(4, len(m.group(0).replace("  ", "\t"))) if m else 0
            line = line.strip()
        if e.get("bullets") and line:
            mar = round((0.6 + level * 0.9) * e["size"] * EMU)
            ppr = (f'<a:pPr marL="{mar}" indent="{-round(0.6 * e["size"] * EMU)}" algn="{algn}"><a:spcAft><a:spcPct val="20000"/></a:spcAft>'
                   f'<a:buClr><a:srgbClr val="{th["accent"]}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>')
        else:
            ppr = f'<a:pPr algn="{algn}"><a:buNone/></a:pPr>'
        run = f'<a:r>{rpr}<a:t>{_t(line)}</a:t></a:r>' if line else ""
        out.append(f'<a:p>{ppr}{run}<a:endParaRPr lang="en-US" sz="{sz}" dirty="0"/></a:p>')
    return "".join(out)


def _text_shape(n: int, e: dict, th: dict) -> str:
    anchor = "ctr" if e["role"] in ("title", "subtitle") else "t"
    name = {"title": "Title", "subtitle": "Subtitle", "body": "Content"}.get(e["role"], "Text box")
    return (f'<p:sp><p:nvSpPr><p:cNvPr id="{n}" name={_a(f"{name} {n}")}/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            f'<p:spPr><a:xfrm><a:off x="{e["x"] * EMU}" y="{e["y"] * EMU}"/><a:ext cx="{e["w"] * EMU}" cy="{e["h"] * EMU}"/></a:xfrm>'
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>'
            f'<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="{anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>'
            f'{_paragraphs(e, th)}</p:txBody></p:sp>')


def _slide_xml(slide: dict, th: dict) -> str:
    shapes, n = [], 2
    if slide["layout"] == "section":  # accent bar above the section title, as drawn in the shell
        shapes.append(f'<p:sp><p:nvSpPr><p:cNvPr id="{n}" name="Accent bar"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm>'
                      f'<a:off x="{120 * EMU}" y="{230 * EMU}"/><a:ext cx="{96 * EMU}" cy="{8 * EMU}"/></a:xfrm>'
                      f'<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="{th["accent"]}"/></a:solidFill>'
                      '<a:ln><a:noFill/></a:ln></p:spPr></p:sp>')
        n += 1
    for e in slide["elements"]:
        if not e["text"].strip():
            continue  # empty placeholders only exist to prompt for text while editing
        shapes.append(_text_shape(n, e, th))
        n += 1
    return (f'{DECL}<p:sld {NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="{th["bg"]}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>'
            f'<p:spTree>{_GROUP}{"".join(shapes)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>')


def _notes_xml(notes: str) -> str:
    paras = "".join(f'<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>{_t(line)}</a:t></a:r></a:p>' if line else "<a:p/>" for line in notes.split("\n"))
    return (f'{DECL}<p:notes {NS}><p:cSld><p:spTree>{_GROUP}'
            '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide image"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr>'
            '<p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>'
            '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>'
            f'<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>{paras}</p:txBody></p:sp>'
            '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>')


def export_pptx(deck: dict) -> bytes:
    try:
        deck = dk.validate(deck)
    except dk.DeckError as exc:
        raise ValueError(str(exc)) from exc
    th = dk.THEMES[deck["theme"]]
    slides = deck["slides"]
    with_notes = [i for i, s in enumerate(slides) if s["notes"].strip()]
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    parts: dict[str, str] = {}

    pres_rels = [("slideMaster", "slideMasters/slideMaster1.xml"), ("theme", "theme/theme1.xml")]
    slide_rids = []
    for i in range(len(slides)):
        pres_rels.append(("slide", f"slides/slide{i + 1}.xml"))
        slide_rids.append(len(pres_rels))
    notes_master = ""
    if with_notes:
        pres_rels.append(("notesMaster", "notesMasters/notesMaster1.xml"))
        notes_master = f'<p:notesMasterIdLst><p:notesMasterId r:id="rId{len(pres_rels)}"/></p:notesMasterIdLst>'
    sld_ids = "".join(f'<p:sldId id="{256 + i}" r:id="rId{rid}"/>' for i, rid in enumerate(slide_rids))
    parts["ppt/presentation.xml"] = (f'{DECL}<p:presentation {NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/>'
                                     f'</p:sldMasterIdLst>{notes_master}<p:sldIdLst>{sld_ids}</p:sldIdLst>'
                                     '<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>')
    parts["ppt/_rels/presentation.xml.rels"] = _rels(pres_rels)
    parts["ppt/theme/theme1.xml"] = _theme(th["name"], th)
    parts["ppt/slideMasters/slideMaster1.xml"] = (f'{DECL}<p:sldMaster {NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>'
                                                  f'<p:spTree>{_GROUP}</p:spTree></p:cSld><p:clrMap {CLR_MAP}/>'
                                                  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
                                                  '<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>')
    parts["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = _rels([("slideLayout", "../slideLayouts/slideLayout1.xml"), ("theme", "../theme/theme1.xml")])
    parts["ppt/slideLayouts/slideLayout1.xml"] = (f'{DECL}<p:sldLayout {NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>{_GROUP}</p:spTree>'
                                                  '</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>')
    parts["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = _rels([("slideMaster", "../slideMasters/slideMaster1.xml")])
    if with_notes:
        parts["ppt/theme/theme2.xml"] = _theme("Notes", dk.THEMES["atlas"])
        parts["ppt/notesMasters/notesMaster1.xml"] = (f'{DECL}<p:notesMaster {NS}><p:cSld><p:spTree>{_GROUP}</p:spTree></p:cSld>'
                                                      f'<p:clrMap {CLR_MAP}/></p:notesMaster>')
        parts["ppt/notesMasters/_rels/notesMaster1.xml.rels"] = _rels([("theme", "../theme/theme2.xml")])
    note_no = 0
    for i, slide in enumerate(slides, 1):
        parts[f"ppt/slides/slide{i}.xml"] = _slide_xml(slide, th)
        rels = [("slideLayout", "../slideLayouts/slideLayout1.xml")]
        if slide["notes"].strip():
            note_no += 1
            parts[f"ppt/notesSlides/notesSlide{note_no}.xml"] = _notes_xml(slide["notes"])
            parts[f"ppt/notesSlides/_rels/notesSlide{note_no}.xml.rels"] = _rels([("notesMaster", "../notesMasters/notesMaster1.xml"), ("slide", f"../slides/slide{i}.xml")])
            rels.append(("notesSlide", f"../notesSlides/notesSlide{note_no}.xml"))
        parts[f"ppt/slides/_rels/slide{i}.xml.rels"] = _rels(rels)

    parts["docProps/core.xml"] = (f'{DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
                                  'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
                                  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
                                  f'<dc:title>{_t(deck["title"])}</dc:title><dc:creator>Atlas Slides</dc:creator>'
                                  f'<dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created>'
                                  f'<dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified></cp:coreProperties>')
    parts["docProps/app.xml"] = (f'{DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
                                 f'<Application>Atlas Slides</Application><Slides>{len(slides)}</Slides><Notes>{len(with_notes)}</Notes></Properties>')
    parts["_rels/.rels"] = _rels([("officeDocument", "ppt/presentation.xml")]).replace(
        "</Relationships>",
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        f'<Relationship Id="rId3" Type="{REL}/extended-properties" Target="docProps/app.xml"/></Relationships>')

    overrides = {"/ppt/presentation.xml": f"{PML}.presentation.main+xml", "/ppt/slideMasters/slideMaster1.xml": f"{PML}.slideMaster+xml",
                 "/ppt/slideLayouts/slideLayout1.xml": f"{PML}.slideLayout+xml", "/ppt/theme/theme1.xml": "application/vnd.openxmlformats-officedocument.theme+xml",
                 "/docProps/core.xml": "application/vnd.openxmlformats-package.core-properties+xml",
                 "/docProps/app.xml": "application/vnd.openxmlformats-officedocument.extended-properties+xml"}
    for i in range(1, len(slides) + 1):
        overrides[f"/ppt/slides/slide{i}.xml"] = f"{PML}.slide+xml"
    if with_notes:
        overrides["/ppt/theme/theme2.xml"] = "application/vnd.openxmlformats-officedocument.theme+xml"
        overrides["/ppt/notesMasters/notesMaster1.xml"] = f"{PML}.notesMaster+xml"
        for k in range(1, note_no + 1):
            overrides[f"/ppt/notesSlides/notesSlide{k}.xml"] = f"{PML}.notesSlide+xml"
    types = "".join(f'<Override PartName="{p}" ContentType="{c}"/>' for p, c in overrides.items())
    content_types = (f'{DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                     '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                     f'<Default Extension="xml" ContentType="application/xml"/>{types}</Types>')

    out = BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        for name, xml in parts.items():
            z.writestr(name, xml)
    return out.getvalue()
