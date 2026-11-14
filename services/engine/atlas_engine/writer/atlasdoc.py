"""The Atlas document model (`.atlasdoc`, JSON) and its HTML bridge.

A document is an ordered list of typed blocks. Inline formatting is a small, sanitised HTML subset.
This structure is what Atlas AI edits through typed tools, and what LibreOffice converts to DOCX/ODT/PDF.

  {"format": "atlas.doc", "version": 1, "title": str, "page": {"size": "A4"|"Letter", "header"?: str, "footer"?: str},
   "blocks": [{"id": str, "type": BlockType, "html": str, "align"?: str, "rows"?: [[str]]}]}
"""

from __future__ import annotations

import html as htmllib
import re
import uuid
from html.parser import HTMLParser
from typing import Any

TEXT_TYPES = ("title", "heading1", "heading2", "heading3", "paragraph", "quote", "bullet", "numbered")
BLOCK_TYPES = TEXT_TYPES + ("table", "pagebreak", "image", "toc")
ALIGNS = ("left", "center", "right", "justify")
INLINE_TAGS = {"b", "strong", "i", "em", "u", "s", "code", "sub", "sup", "br", "a", "span", "font"}
IMAGE_RE = re.compile(r"^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$")
MAX_IMAGE_CHARS = 4_000_000  # ~3 MB of image data per picture
FONT_FAMILIES = ("Arial", "Calibri", "Cambria", "Georgia", "Inter", "Liberation Sans", "Liberation Serif", "Noto Sans", "Times New Roman", "Ubuntu")


def _hex_colour(value: str | None) -> str | None:
    """'#rrggbb' from '#rrggbb', '#rgb' or 'rgb(r, g, b)'; anything else is rejected."""
    v = (value or "").strip().lower()
    if re.fullmatch(r"#[0-9a-f]{6}", v):
        return v
    if re.fullmatch(r"#[0-9a-f]{3}", v):
        return "#" + "".join(ch * 2 for ch in v[1:])
    m = re.fullmatch(r"rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)", v)
    if m and all(int(x) <= 255 for x in m.groups()[:3]) and (m.group(4) is None or float(m.group(4)) > 0):
        return "#" + "".join(f"{int(x):02x}" for x in m.groups()[:3])
    return None


def _safe_font_family(value: str | None) -> str | None:
    first = (value or "").split(",", 1)[0].strip().strip("\"'")
    return next((family for family in FONT_FAMILIES if family.lower() == first.lower()), None)


def _safe_font_size(value: str | None) -> str | None:
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*(pt|px)\s*", value or "", re.I)
    if not m:
        return None
    pt = float(m.group(1)) * (0.75 if m.group(2).lower() == "px" else 1)
    return f"{round(pt * 4) / 4:g}pt" if 6 <= pt <= 96 else None


def _span_style(tag: str, attrs: dict) -> str | None:
    """Canonical safe inline styles, or None to drop the span while keeping its text."""
    color = bg = family = size = None
    if tag == "font":
        color = _hex_colour(attrs.get("color"))
        family = _safe_font_family(attrs.get("face"))
        legacy_size = {"1": "8pt", "2": "10pt", "3": "12pt", "4": "14pt", "5": "18pt", "6": "24pt", "7": "36pt"}
        size = legacy_size.get((attrs.get("size") or "").strip())
    for decl in (attrs.get("style") or "").split(";"):
        if ":" not in decl:
            continue
        k, v = (x.strip().lower() for x in decl.split(":", 1))
        if k == "color":
            color = _hex_colour(v) or color
        elif k in ("background-color", "background"):
            bg = _hex_colour(v) or bg
        elif k == "font-family":
            family = _safe_font_family(v) or family
        elif k == "font-size":
            size = _safe_font_size(v) or size
    parts = ([f"font-family: {family}"] if family else []) + ([f"font-size: {size}"] if size else []) + \
            ([f"color: {color}"] if color else []) + ([f"background-color: {bg}"] if bg else [])
    return "; ".join(parts) or None
_TAG_NORMAL = {"strong": "b", "em": "i", "strike": "s", "del": "s"}


def new_id() -> str:
    return "b" + uuid.uuid4().hex[:10]


# ---------------------------------------------------------------- sanitising

class _Sanitizer(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.stack: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        tag = _TAG_NORMAL.get(tag, tag)
        if tag in ("script", "style"):
            self.skip += 1
            return
        if self.skip or tag not in INLINE_TAGS:
            if tag in ("p", "div", "li") and self.out and self.out[-1] != "<br>":
                pass
            return
        if tag == "br":
            self.out.append("<br>")
            return
        if tag in ("span", "font"):
            style = _span_style(tag, dict(attrs))
            if style is None:
                self.stack.append("")
                return
            self.out.append(f'<span style="{style}">')
            self.stack.append("span")
            return
        if tag == "a":
            href = dict(attrs).get("href") or ""
            if not re.match(r"^(https?:|mailto:)", href, re.I):
                self.stack.append("")  # drop unsafe link but keep its text
                return
            self.out.append(f'<a href="{htmllib.escape(href, quote=True)}">')
            self.stack.append("a")
            return
        self.out.append(f"<{tag}>")
        self.stack.append(tag)

    def handle_endtag(self, tag):
        tag = _TAG_NORMAL.get(tag, tag)
        if tag == "font":
            tag = "span"
        if tag in ("script", "style"):
            self.skip = max(0, self.skip - 1)
            return
        if self.skip or tag not in INLINE_TAGS or tag == "br":
            return
        # close up to the matching tag (repairs mis-nesting)
        if tag in self.stack or (tag in ("a", "span") and "" in self.stack):
            while self.stack:
                t = self.stack.pop()
                if t:
                    self.out.append(f"</{t}>")
                if t == tag or (tag in ("a", "span") and t == ""):
                    break

    def handle_data(self, data):
        if not self.skip:
            self.out.append(htmllib.escape(data, quote=False))

    def result(self) -> str:
        while self.stack:
            t = self.stack.pop()
            if t:
                self.out.append(f"</{t}>")
        s = "".join(self.out)
        s = re.sub(r"\s+", " ", s.replace("\n", " "))
        return re.sub(r"^(?:\s|<br>)+|(?:\s|<br>)+$", "", s)


def sanitize_inline(html: str) -> str:
    p = _Sanitizer()
    p.feed(html or "")
    p.close()
    return p.result()


def inline_from_text(text: str) -> str:
    """Plain text with light Markdown (**bold**, *italic*, `code`, [label](url)) → sanitised inline HTML."""
    s = htmllib.escape(text or "", quote=False)
    s = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r'<a href="\2">\1</a>', s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
    s = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<i>\1</i>", s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = s.replace("\n", "<br>")
    return sanitize_inline(s)


def inline_to_text(html: str) -> str:
    s = re.sub(r"<br\s*/?>", "\n", html or "")
    return htmllib.unescape(re.sub(r"<[^>]+>", "", s))


# ---------------------------------------------------------------- model

class DocError(ValueError):
    pass


def make_block(btype: str, text: str | None = None, html: str | None = None, rows: list[list[str]] | None = None,
               align: str | None = None) -> dict:
    if btype not in BLOCK_TYPES or btype == "image":
        raise DocError(f"unknown block type '{btype}'. Use one of: {', '.join(t for t in BLOCK_TYPES if t != 'image')}")
    b: dict[str, Any] = {"id": new_id(), "type": btype}
    if btype == "table":
        if not rows or not all(isinstance(r, list) and r for r in rows):
            raise DocError("a table needs 'rows': a list of rows, each a list of cell texts")
        width = max(len(r) for r in rows)
        b["rows"] = [[inline_from_text(str(c)) for c in r] + [""] * (width - len(r)) for r in rows]
    elif btype not in ("pagebreak", "toc"):
        b["html"] = sanitize_inline(html) if html is not None else inline_from_text(text or "")
    if align:
        if align not in ALIGNS:
            raise DocError(f"align must be one of {ALIGNS}")
        b["align"] = align
    return b


def new_document(title: str, blocks: list[dict] | None = None, page_size: str = "A4") -> dict:
    return validate({"format": "atlas.doc", "version": 1, "title": title.strip() or "Untitled document",
                     "page": {"size": page_size, "header": "", "footer": ""}, "blocks": blocks or [make_block("paragraph", "")]})


def _page_text(value: Any) -> str:
    return re.sub(r"[\x00-\x1f\x7f]", " ", str(value or ""))[:300].strip()


def validate(doc: Any) -> dict:
    """Validate and normalise (sanitises all inline HTML). Raises DocError."""
    if not isinstance(doc, dict) or doc.get("format") != "atlas.doc":
        raise DocError("not an Atlas document")
    if doc.get("version") != 1:
        raise DocError("unsupported document version")
    blocks = doc.get("blocks")
    if not isinstance(blocks, list):
        raise DocError("blocks must be a list")
    out = []
    seen = set()
    for b in blocks:
        if not isinstance(b, dict) or b.get("type") not in BLOCK_TYPES:
            raise DocError(f"invalid block: {str(b)[:80]}")
        bid = b.get("id") if isinstance(b.get("id"), str) and b.get("id") not in seen else new_id()
        seen.add(bid)
        nb: dict[str, Any] = {"id": bid, "type": b["type"]}
        if b["type"] == "table":
            rows = b.get("rows")
            if not isinstance(rows, list) or not rows:
                raise DocError("table without rows")
            width = max(len(r) for r in rows if isinstance(r, list)) if rows else 1
            nb["rows"] = [[sanitize_inline(str(c)) for c in r] + [""] * (width - len(r)) for r in rows if isinstance(r, list)]
        elif b["type"] == "image":
            src = str(b.get("src", ""))
            if len(src) > MAX_IMAGE_CHARS or not IMAGE_RE.match(src):
                raise DocError("pictures must be PNG, JPEG, GIF or WebP data under 3 MB")
            nb["src"] = src
            nb["alt"] = str(b.get("alt") or "")[:300]
            width = b.get("width")
            nb["width"] = width if isinstance(width, int) and not isinstance(width, bool) and 10 <= width <= 100 else 100
        elif b["type"] not in ("pagebreak", "toc"):
            nb["html"] = sanitize_inline(str(b.get("html", "")))
        if b.get("align") in ALIGNS:
            nb["align"] = b["align"]
        out.append(nb)
    page = doc.get("page") if isinstance(doc.get("page"), dict) else {}
    return {"format": "atlas.doc", "version": 1, "title": str(doc.get("title") or "Untitled document")[:300],
            "page": {"size": page.get("size") if page.get("size") in ("A4", "Letter") else "A4",
                     "header": _page_text(page.get("header")), "footer": _page_text(page.get("footer"))}, "blocks": out}


def outline(doc: dict, max_chars: int = 400) -> list[dict]:
    """Compact view for the AI: index, type and plain text of each block."""
    res = []
    for i, b in enumerate(doc["blocks"]):
        if b["type"] == "table":
            text = " | ".join(inline_to_text(c) for c in b["rows"][0]) + f"  ({len(b['rows'])} rows)"
        elif b["type"] == "pagebreak":
            text = ""
        elif b["type"] == "image":
            text = f"[picture: {b['alt'] or 'no description'}]"
        elif b["type"] == "toc":
            text = ""
        else:
            text = inline_to_text(b["html"])
        res.append({"index": i, "type": b["type"], "text": text[:max_chars]})
    return res


def stats(doc: dict) -> dict:
    text = " ".join(x["text"] for x in outline(doc, 10**9))
    words = len(re.findall(r"\w+", text))
    return {"block_count": len(doc["blocks"]), "words": words, "characters": len(text)}


# ---------------------------------------------------------------- HTML export (for LibreOffice)

_TAG = {"title": "h1", "heading1": "h1", "heading2": "h2", "heading3": "h3", "paragraph": "p", "quote": "blockquote"}


def to_html(doc: dict) -> str:
    parts: list[str] = []
    list_open: str | None = None
    break_next = False
    for b in doc["blocks"]:
        t = b["type"]
        if list_open and t not in ("bullet", "numbered") or (list_open == "ul" and t == "numbered") or (list_open == "ol" and t == "bullet"):
            parts.append(f"</{list_open}>")
            list_open = None
        if t == "pagebreak":
            break_next = True
            continue
        if t == "toc":
            parts.append(_toc_html(doc))
            continue
        style = []
        if b.get("align"):
            style.append(f"text-align: {b['align']}")
        if break_next:
            style.append("page-break-before: always")
            break_next = False
        st = f' style="{"; ".join(style)}"' if style else ""
        if t in ("bullet", "numbered"):
            want = "ul" if t == "bullet" else "ol"
            if list_open != want:
                parts.append(f"<{want}>")
                list_open = want
            parts.append(f"<li{st}>{b['html']}</li>")
        elif t == "table":
            rows = "".join("<tr>" + "".join(f"<td>{c or '&nbsp;'}</td>" for c in r) + "</tr>" for r in b["rows"])
            parts.append(f'<table border="1" cellpadding="5" cellspacing="0" width="100%"{st}>{rows}</table>')
        elif t == "image":
            alt = htmllib.escape(b.get("alt", ""), quote=True)
            parts.append(f'<p{st}><img src="{b["src"]}" alt="{alt}" style="width: {b["width"]}%"></p>')
        elif t == "title":
            parts.append(f'<h1 class="title"{st}><font size="6">{b["html"]}</font></h1>')
        else:
            tag = _TAG[t]
            anchor = f' id="atlas-{htmllib.escape(b["id"], quote=True)}"' if t in ("heading1", "heading2", "heading3") else ""
            parts.append(f"<{tag}{anchor}{st}>{b['html'] or '&nbsp;'}</{tag}>")
    if list_open:
        parts.append(f"</{list_open}>")
    title = htmllib.escape(doc["title"])
    return f'<!DOCTYPE html><html><head><meta charset="utf-8"><title>{title}</title></head><body>{"".join(parts)}</body></html>'


def _toc_html(doc: dict) -> str:
    headings = [b for b in doc["blocks"] if b["type"] in ("heading1", "heading2", "heading3")]
    if not headings:
        return '<nav class="atlas-toc"><h2>Contents</h2><p>No headings yet.</p></nav>'
    items = []
    for b in headings:
        level = int(b["type"][-1])
        text = htmllib.escape(inline_to_text(b.get("html", "")), quote=False) or "(untitled)"
        anchor = htmllib.escape(str(b["id"]), quote=True)
        items.append(f'<li style="margin-left: {(level - 1) * 20}px"><a href="#atlas-{anchor}">{text}</a></li>')
    return '<nav class="atlas-toc"><h2>Contents</h2><ul>' + "".join(items) + "</ul></nav>"


# ---------------------------------------------------------------- HTML import (from LibreOffice)

class _Node:
    __slots__ = ("tag", "attrs", "children", "parent")

    def __init__(self, tag, attrs=None, parent=None):
        self.tag, self.attrs, self.children, self.parent = tag, dict(attrs or []), [], parent


_VOID = {"br", "img", "hr", "meta", "link", "col", "input"}


class _TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _Node("#root")
        self.cur = self.root

    def handle_starttag(self, tag, attrs):
        n = _Node(tag, attrs, self.cur)
        self.cur.children.append(n)
        if tag not in _VOID:
            self.cur = n

    def handle_startendtag(self, tag, attrs):
        self.cur.children.append(_Node(tag, attrs, self.cur))

    def handle_endtag(self, tag):
        n = self.cur
        while n is not self.root and n.tag != tag:
            n = n.parent
        if n is not self.root:
            self.cur = n.parent

    def handle_data(self, data):
        self.cur.children.append(data)


def _inner_html(n: _Node) -> str:
    out = []
    for c in n.children:
        if isinstance(c, str):
            out.append(htmllib.escape(c, quote=False))
        elif c.tag in _VOID:
            out.append(f"<{c.tag}>")
        else:
            attrs = "".join(f' {k}="{htmllib.escape(v or "", quote=True)}"' for k, v in c.attrs.items()
                            if k == "href" or (k in ("style", "color", "face", "size") and c.tag in ("span", "font")))
            out.append(f"<{c.tag}{attrs}>{_inner_html(c)}</{c.tag}>")
    return "".join(out)


def _align(n: _Node) -> str | None:
    a = (n.attrs.get("align") or "").lower()
    m = re.search(r"text-align:\s*(\w+)", n.attrs.get("style") or "")
    a = m.group(1).lower() if m else a
    return a if a in ("center", "right", "justify") else None


def from_html(html: str, title: str = "Imported document") -> dict:
    tb = _TreeBuilder()
    tb.feed(html)
    tb.close()
    blocks: list[dict] = []

    def text_block(btype: str, n: _Node):
        inner = sanitize_inline(_inner_html(n))
        if btype == "paragraph" and not inline_to_text(inner).strip():
            return
        b = make_block(btype, html=inner)
        if _align(n):
            b["align"] = _align(n)
        blocks.append(b)

    def walk(n: _Node):
        for c in n.children:
            if isinstance(c, str):
                if c.strip() and n.tag in ("body", "#root", "div", "section"):
                    blocks.append(make_block("paragraph", c.strip()))
                continue
            t = c.tag
            if t in ("head", "script", "style", "title"):
                continue
            if t == "h1":
                text_block("heading1", c)
            elif t == "h2":
                text_block("heading2", c)
            elif t in ("h3", "h4", "h5", "h6"):
                text_block("heading3", c)
            elif t == "p":
                if "page-break-before: always" in (c.attrs.get("style") or "") and blocks:
                    blocks.append(make_block("pagebreak"))
                text_block("paragraph", c)
            elif t == "blockquote":
                text_block("quote", c)
            elif t in ("ul", "ol"):
                for li in c.children:
                    if isinstance(li, _Node) and li.tag == "li":
                        nested = [x for x in li.children if isinstance(x, _Node) and x.tag in ("ul", "ol")]
                        li.children = [x for x in li.children if x not in nested]
                        text_block("bullet" if t == "ul" else "numbered", li)
                        for sub in nested:
                            walk(_wrap(sub))
            elif t == "table":
                rows = []
                for tr in _find_all(c, "tr"):
                    cells = [sanitize_inline(_inner_html(td)) for td in tr.children if isinstance(td, _Node) and td.tag in ("td", "th")]
                    if cells:
                        rows.append(cells)
                if rows:
                    width = max(len(r) for r in rows)
                    blocks.append({"id": new_id(), "type": "table", "rows": [r + [""] * (width - len(r)) for r in rows]})
            else:
                walk(c)

    walk(tb.root)
    doc_title = title
    for b in blocks:
        if b["type"] == "heading1":
            doc_title = inline_to_text(b["html"]).strip() or title
            break
    return validate({"format": "atlas.doc", "version": 1, "title": doc_title, "page": {"size": "A4"},
                     "blocks": blocks or [make_block("paragraph", "")]})


def _wrap(n: _Node) -> _Node:
    w = _Node("div")
    w.children = [n]
    return w


def _find_all(n: _Node, tag: str) -> list[_Node]:
    out = []
    for c in n.children:
        if isinstance(c, _Node):
            if c.tag == tag:
                out.append(c)
            out.extend(_find_all(c, tag) if c.tag != "table" else [])
    return out
