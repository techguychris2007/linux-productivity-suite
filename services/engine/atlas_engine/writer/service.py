"""Writer service: load/save `.atlasdoc` files through the core, convert via LibreOffice, and expose AI tools."""

from __future__ import annotations

import base64
import json
import posixpath

from ..core_client import CoreClient, CoreError
from ..tools import ToolContext, ToolError, ToolRegistry, ToolResult
from . import atlasdoc as ad
from .converter import FORMATS, IMPORTABLE, ConversionError, LibreOffice
from .page_parts import add_page_parts

EXT = ".atlasdoc"


def _stem(path: str) -> str:
    base = posixpath.basename(path)
    return base[: base.rfind(".")] if "." in base else base


class WriterService:
    def __init__(self, core: CoreClient, lo: LibreOffice) -> None:
        self.core, self.lo = core, lo

    # ---------------- storage ----------------
    def load(self, grant: str, path: str) -> dict:
        if not path.endswith(EXT):
            raise ToolError(f"Writer documents end in {EXT}", "invalid_arguments")
        r = self.core.call("fs.read_text", grant=grant, path=path)
        if r["truncated"]:
            raise ToolError("document is too large", "too_large")
        try:
            return ad.validate(json.loads(r["content"]))
        except (json.JSONDecodeError, ad.DocError) as e:
            raise ToolError(f"{path} is not a valid Atlas document: {e}", "invalid_document") from e

    def save(self, grant: str, path: str, doc: dict, create: bool = False) -> dict:
        doc = ad.validate(doc)
        return self.core.call("fs.write_text", grant=grant, path=path, content=json.dumps(doc, ensure_ascii=False, indent=1),
                              overwrite=not create)

    def _free_name(self, grant: str, folder: str, stem: str, ext: str) -> str:
        for i in range(0, 100):
            name = f"{stem}{ext}" if i == 0 else f"{stem} ({i}){ext}"
            p = posixpath.join(folder, name) if folder else name
            try:
                self.core.call("fs.stat", grant=grant, path=p)
                if self.core.call("fs.stat", grant=grant, path=p)["kind"] == "missing":
                    return p
            except CoreError:
                return p
        raise ToolError("could not find a free file name", "conflict")

    # ---------------- conversion ----------------
    def export(self, grant: str, path: str, fmt: str) -> dict:
        if fmt not in ("docx", "odt", "pdf"):
            raise ToolError("format must be docx, odt or pdf", "invalid_arguments")
        doc = self.load(grant, path)
        try:
            html = ad.to_html(doc).encode()
            header, footer = doc["page"].get("header", ""), doc["page"].get("footer", "")
            if header or footer:
                odt = self.lo.convert_bytes(html, ".html", "odt", html_input=True)
                odt = add_page_parts(odt, header, footer)
                data = odt if fmt == "odt" else self.lo.convert_bytes(odt, ".odt", fmt)
            else:
                data = self.lo.convert_bytes(html, ".html", fmt, html_input=True)
        except (ConversionError, ValueError) as e:
            raise ToolError(str(e), "conversion_failed") from e
        out = posixpath.join(posixpath.dirname(path), _stem(path) + "." + FORMATS[fmt][0])
        r = self.core.call("fs.write_base64", grant=grant, path=out, data=base64.b64encode(data).decode(), overwrite=True)
        return {"path": out, "size": r["size"], "replaced_previous": bool(r.get("backup"))}

    def import_file(self, grant: str, path: str) -> dict:
        ext = posixpath.splitext(path)[1].lower()
        if ext not in IMPORTABLE:
            raise ToolError(f"cannot import {ext or 'this file'}; supported: {', '.join(sorted(IMPORTABLE))}", "invalid_arguments")
        src = base64.b64decode(self.core.call("fs.read_base64", grant=grant, path=path)["data"])
        try:
            if ext in (".html", ".htm"):
                html = src.decode("utf-8", errors="replace")
            else:
                html = self.lo.convert_bytes(src, ext, "html").decode("utf-8", errors="replace")
        except ConversionError as e:
            raise ToolError(str(e), "conversion_failed") from e
        doc = ad.from_html(html, title=_stem(path))
        out = self._free_name(grant, posixpath.dirname(path), _stem(path), EXT)
        self.save(grant, out, doc, create=True)
        return {"path": out, **ad.stats(doc)}


# ---------------------------------------------------------------- AI tools

_GRANT = {"type": "string", "minLength": 1, "description": "Folder grant id from drive.list_folders"}
_DOC = {"type": "string", "minLength": 1, "description": "Path of the .atlasdoc file inside the shared folder"}
_BLOCK = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": [t for t in ad.BLOCK_TYPES if t != "image"],
                 "description": "Use 'toc' to insert a generated table of contents from Heading 1–3 blocks."},
        "text": {"type": "string", "description": "Block text. Inline **bold**, *italic*, `code` and [link](https://…) are supported."},
        "rows": {"type": "array", "items": {"type": "array", "items": {"type": "string"}}, "description": "Only for type=table: rows of cell texts; first row is the header."},
        "align": {"type": "string", "enum": list(ad.ALIGNS)},
    },
    "required": ["type"],
}


def _blocks_from_args(items: list[dict]) -> list[dict]:
    try:
        return [ad.make_block(b["type"], text=b.get("text", ""), rows=b.get("rows"), align=b.get("align")) for b in items]
    except ad.DocError as e:
        raise ToolError(str(e), "invalid_arguments") from e


def register(reg: ToolRegistry, svc: WriterService) -> None:
    def changed(grant: str, path: str) -> list[dict]:
        return [{"kind": "document", "grant": grant, "path": path}]

    @reg.tool("writer.create_document",
              "Create a new Writer document (.atlasdoc) with a title and content blocks. Use heading1/2/3 for structure, "
              "paragraph for body text, bullet/numbered for list items (one block per item), quote, table, toc and pagebreak. "
              "Optional header and footer text repeat on every exported page.",
              {"type": "object", "properties": {"grant": _GRANT, "path": _DOC, "title": {"type": "string", "minLength": 1},
                                                "header": {"type": "string", "maxLength": 300}, "footer": {"type": "string", "maxLength": 300},
                                                "blocks": {"type": "array", "items": _BLOCK, "minItems": 1, "maxItems": 400}},
               "required": ["grant", "path", "title", "blocks"], "additionalProperties": False}, "write", "writer")
    def create(args, ctx: ToolContext):
        path = args["path"] if args["path"].endswith(EXT) else args["path"] + EXT
        doc = ad.new_document(args["title"], [ad.make_block("title", args["title"])] + _blocks_from_args(args["blocks"]))
        doc["page"]["header"] = args.get("header", "")
        doc["page"]["footer"] = args.get("footer", "")
        try:
            svc.save(args["grant"], path, doc, create=True)
        except CoreError as e:
            if "exists" in str(e):
                raise ToolError(f"{path} already exists; choose another name or edit it with writer.insert_blocks", "conflict") from e
            raise
        s = ad.stats(doc)
        return ToolResult({"path": path, **s}, summary=f"Created {path} ({s['words']} words)", changed=changed(args["grant"], path))

    @reg.tool("writer.read_document", "Read a Writer document's page settings and numbered blocks (index, type, text).",
              {"type": "object", "properties": {"grant": _GRANT, "path": _DOC}, "required": ["grant", "path"], "additionalProperties": False},
              "read", "writer")
    def read(args, ctx):
        doc = svc.load(args["grant"], args["path"])
        return ToolResult({"title": doc["title"], "page": doc["page"], "blocks": ad.outline(doc), "comments": doc.get("comments", []), **ad.stats(doc)}, untrusted=True,
                          source=f"document {args['path']}", summary=f"Read {args['path']} ({len(doc['blocks'])} blocks)")

    @reg.tool("writer.update_page", "Update a document's page size, repeating header text, or repeating footer text.",
              {"type": "object", "properties": {"grant": _GRANT, "path": _DOC,
                                                  "size": {"type": "string", "enum": ["A4", "Letter"]},
                                                  "header": {"type": "string", "maxLength": 300},
                                                  "footer": {"type": "string", "maxLength": 300}},
               "required": ["grant", "path"], "additionalProperties": False}, "write", "writer")
    def update_page(args, ctx):
        fields = ("size", "header", "footer")
        if not any(k in args for k in fields):
            raise ToolError("pass at least one page setting to update", "invalid_arguments")
        doc = svc.load(args["grant"], args["path"])
        doc["page"].update({k: args[k] for k in fields if k in args})
        svc.save(args["grant"], args["path"], doc)
        return ToolResult(doc["page"], summary=f"Updated page settings in {args['path']}", changed=changed(args["grant"], args["path"]))

    @reg.tool("writer.insert_blocks", "Insert blocks after the given block index (-1 inserts at the very start).",
              {"type": "object", "properties": {"grant": _GRANT, "path": _DOC, "after": {"type": "integer", "minimum": -1},
                                                "blocks": {"type": "array", "items": _BLOCK, "minItems": 1, "maxItems": 400}},
               "required": ["grant", "path", "after", "blocks"], "additionalProperties": False}, "write", "writer")
    def insert(args, ctx):
        doc = svc.load(args["grant"], args["path"])
        at = min(args["after"] + 1, len(doc["blocks"]))
        new = _blocks_from_args(args["blocks"])
        doc["blocks"][at:at] = new
        svc.save(args["grant"], args["path"], doc)
        return ToolResult({"inserted": len(new), "at_index": at}, summary=f"Added {len(new)} block{'s' if len(new) != 1 else ''} to {args['path']}",
                          changed=changed(args["grant"], args["path"]))

    @reg.tool("writer.update_block", "Change the type, text, alignment or table rows of one block.",
              {"type": "object", "properties": {"grant": _GRANT, "path": _DOC, "index": {"type": "integer", "minimum": 0},
                                                "type": {"type": "string", "enum": [t for t in ad.BLOCK_TYPES if t != "image"]}, "text": {"type": "string"},
                                                "rows": _BLOCK["properties"]["rows"], "align": {"type": "string", "enum": list(ad.ALIGNS)}},
               "required": ["grant", "path", "index"], "additionalProperties": False}, "write", "writer")
    def update(args, ctx):
        doc = svc.load(args["grant"], args["path"])
        i = args["index"]
        if i >= len(doc["blocks"]):
            raise ToolError(f"index {i} out of range (document has {len(doc['blocks'])} blocks)", "invalid_arguments")
        old = doc["blocks"][i]
        btype = args.get("type", old["type"])
        text = args.get("text")
        try:
            if btype == "table":
                nb = ad.make_block("table", rows=args.get("rows") or ([[ad.inline_to_text(c) for c in r] for r in old["rows"]] if old["type"] == "table" else None))
            elif btype == "pagebreak":
                nb = ad.make_block("pagebreak")
            else:
                nb = ad.make_block(btype, text=text) if text is not None else ad.make_block(btype, html=old.get("html", ""))
        except ad.DocError as e:
            raise ToolError(str(e), "invalid_arguments") from e
        nb["id"] = old["id"]
        if args.get("align") or old.get("align"):
            nb["align"] = args.get("align", old.get("align"))
        doc["blocks"][i] = nb
        svc.save(args["grant"], args["path"], doc)
        return ToolResult({"updated": i}, summary=f"Updated block {i + 1} in {args['path']}", changed=changed(args["grant"], args["path"]))

    @reg.tool("writer.delete_blocks", "Delete `count` blocks starting at `index`. The previous version is backed up.",
              {"type": "object", "properties": {"grant": _GRANT, "path": _DOC, "index": {"type": "integer", "minimum": 0},
                                                "count": {"type": "integer", "minimum": 1, "maximum": 200}},
               "required": ["grant", "path", "index", "count"], "additionalProperties": False}, "write", "writer")
    def delete(args, ctx):
        doc = svc.load(args["grant"], args["path"])
        removed = doc["blocks"][args["index"]: args["index"] + args["count"]]
        if not removed:
            raise ToolError("nothing to delete at that index", "invalid_arguments")
        del doc["blocks"][args["index"]: args["index"] + args["count"]]
        if not doc["blocks"]:
            doc["blocks"] = [ad.make_block("paragraph", "")]
        svc.save(args["grant"], args["path"], doc)
        return ToolResult({"deleted": len(removed)}, summary=f"Removed {len(removed)} block(s) from {args['path']}", changed=changed(args["grant"], args["path"]))

    @reg.tool("writer.export", "Export a Writer document to DOCX (Microsoft Word), ODT or PDF next to the original.",
              {"type": "object", "properties": {"grant": _GRANT, "path": _DOC, "format": {"type": "string", "enum": ["docx", "odt", "pdf"]}},
               "required": ["grant", "path", "format"], "additionalProperties": False}, "write", "writer")
    def export(args, ctx):
        r = svc.export(args["grant"], args["path"], args["format"])
        return ToolResult(r, summary=f"Exported {r['path']}", changed=[{"kind": "file", "grant": args["grant"], "path": r["path"]}])

    @reg.tool("writer.import", "Convert a .docx, .odt, .rtf, .html or .txt file into an editable Writer document.",
              {"type": "object", "properties": {"grant": _GRANT, "path": {"type": "string", "minLength": 1}},
               "required": ["grant", "path"], "additionalProperties": False}, "write", "writer")
    def import_(args, ctx):
        r = svc.import_file(args["grant"], args["path"])
        return ToolResult(r, summary=f"Imported into {r['path']} ({r['words']} words)", changed=changed(args["grant"], r["path"]))
