"""The Atlas document model (`.atlasdoc`, JSON) and its HTML bridge.

A document is an ordered list of typed blocks. Inline formatting is a small, sanitised HTML subset.
This structure is what Atlas AI edits through typed tools, and what LibreOffice converts to DOCX/ODT/PDF.

  {"format": "atlas.doc", "version": 1, "title": str, "page": {"size": "A4"|"Letter"},
   "blocks": [{"id": str, "type": BlockType, "html": str, "align"?: str, "rows"?: [[str]]}]}
"""

from __future__ import annotations

import html as htmllib
import re
import uuid
from html.parser import HTMLParser
from typing import Any

TEXT_TYPES = ("title", "heading1", "heading2", "heading3", "paragraph", "quote", "bullet", "numbered")
BLOCK_TYPES = TEXT_TYPES + ("table", "pagebreak")
ALIGNS = ("left", "center", "right", "justify")
INLINE_TAGS = {"b", "strong", "i", "em", "u", "s", "code", "sub", "sup", "br", "a"}
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
        if tag in ("script", "style"):
            self.skip = max(0, self.skip - 1)
            return
        if self.skip or tag not in INLINE_TAGS or tag == "br":
            return
        # close up to the matching tag (repairs mis-nesting)
        if tag in self.stack or (tag == "a" and "" in self.stack):
            while self.stack:
                t = self.stack.pop()
                if t:
                    self.out.append(f"</{t}>")
                if t == tag or (tag == "a" and t == ""):
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
    if btype not in BLOCK_TYPES:
        raise DocError(f"unknown block type '{btype}'. Use one of: {', '.join(BLOCK_TYPES)}")
    b: dict[str, Any] = {"id": new_id(), "type": btype}
    if btype == "table":
        if not rows or not all(isinstance(r, list) and r for r in rows):
            raise DocError("a table needs 'rows': a list of rows, each a list of cell texts")
        width = max(len(r) for r in rows)
        b["rows"] = [[inline_from_text(str(c)) for c in r] + [""] * (width - len(r)) for r in rows]
    elif btype != "pagebreak":
        b["html"] = sanitize_inline(html) if html is not None else inline_from_text(text or "")
    if align:
        if align not in ALIGNS:
            raise DocError(f"align must be one of {ALIGNS}")
        b["align"] = align
    return b


def new_document(title: str, blocks: list[dict] | None = None, page_size: str = "A4") -> dict:
    return validate({"format": "atlas.doc", "version": 1, "title": title.strip() or "Untitled document",
                     "page": {"size": page_size}, "blocks": blocks or [make_block("paragraph", "")]})


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
        elif b["type"] != "pagebreak":
            nb["html"] = sanitize_inline(str(b.get("html", "")))
        if b.get("align") in ALIGNS:
            nb["align"] = b["align"]
        out.append(nb)
    page = doc.get("page") if isinstance(doc.get("page"), dict) else {}
    return {"format": "atlas.doc", "version": 1, "title": str(doc.get("title") or "Untitled document")[:300],
            "page": {"size": page.get("size") if page.get("size") in ("A4", "Letter") else "A4"}, "blocks": out}


def outline(doc: dict, max_chars: int = 400) -> list[dict]:
    """Compact view for the AI: index, type and plain text of each block."""
    res = []
    for i, b in enumerate(doc["blocks"]):
        if b["type"] == "table":
            text = " | ".join(inline_to_text(c) for c in b["rows"][0]) + f"  ({len(b['rows'])} rows)"
        elif b["type"] == "pagebreak":
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
        elif t == "title":
            parts.append(f'<h1 class="title"{st}><font size="6">{b["html"]}</font></h1>')
        else:
            tag = _TAG[t]
            parts.append(f"<{tag}{st}>{b['html'] or '&nbsp;'}</{tag}>")
    if list_open:
        parts.append(f"</{list_open}>")
    title = htmllib.escape(doc["title"])
    return f'<!DOCTYPE html><html><head><meta charset="utf-8"><title>{title}</title></head><body>{"".join(parts)}</body></html>'


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
            attrs = "".join(f' {k}="{htmllib.escape(v or "", quote=True)}"' for k, v in c.attrs.items() if k == "href")
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
