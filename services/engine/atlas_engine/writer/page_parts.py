"""Add repeating page header/footer text to LibreOffice ODT exports."""
from __future__ import annotations

from io import BytesIO
from xml.etree import ElementTree as ET
import zipfile


ODF = "urn:oasis:names:tc:opendocument:xmlns:"
STYLE = ODF + "style:1.0"
TEXT = ODF + "text:1.0"
FO = ODF + "xsl-fo-compatible:1.0"


def _q(ns: str, name: str) -> str:
    return f"{{{ns}}}{name}"


def _serialize(root: ET.Element, original: bytes) -> bytes:
    for _, (prefix, uri) in ET.iterparse(BytesIO(original), events=("start-ns",)):
        if prefix != "xml":
            ET.register_namespace(prefix or "", uri)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def add_page_parts(data: bytes, header: str, footer: str) -> bytes:
    """Embed repeated plain-text header/footer content in an ODT package."""
    header, footer = header.strip()[:300], footer.strip()[:300]
    if not header and not footer:
        return data

    source = BytesIO(data)
    with zipfile.ZipFile(source, "r") as zin:
        try:
            original = zin.read("styles.xml")
        except KeyError as e:
            raise ValueError("LibreOffice ODT export has no styles.xml") from e
        root = ET.fromstring(original)
        master_pages = root.findall(f".//{_q(STYLE, 'master-page')}")
        master = next((m for m in master_pages if m.get(_q(STYLE, "name")) == "Standard"), master_pages[0] if master_pages else None)
        if master is None:
            raise ValueError("LibreOffice ODT export has no master page")

        layout_name = master.get(_q(STYLE, "page-layout-name"))
        page_layout = next((p for p in root.findall(f".//{_q(STYLE, 'page-layout')}")
                            if p.get(_q(STYLE, "name")) == layout_name), None)

        for part, content in (("header", header), ("footer", footer)):
            tag = _q(STYLE, part)
            previous = master.find(tag)
            if previous is not None:
                master.remove(previous)
            if not content:
                continue
            section = ET.SubElement(master, tag, {_q(STYLE, "display"): "true"})
            paragraph = ET.SubElement(section, _q(TEXT, "p"))
            paragraph.text = content

            if page_layout is not None:
                style_tag = _q(STYLE, f"{part}-style")
                part_style = page_layout.find(style_tag)
                if part_style is None:
                    part_style = ET.SubElement(page_layout, style_tag)
                props_tag = _q(STYLE, "header-footer-properties")
                props = part_style.find(props_tag)
                if props is None:
                    props = ET.SubElement(part_style, props_tag)
                props.set(_q(FO, "min-height"), "0.22in")
                props.set(_q(FO, "margin-bottom" if part == "header" else "margin-top"), "0.08in")

        replacement = _serialize(root, original)
        out = BytesIO()
        with zipfile.ZipFile(out, "w") as zout:
            for info in zin.infolist():
                zout.writestr(info, replacement if info.filename == "styles.xml" else zin.read(info.filename))
        return out.getvalue()
