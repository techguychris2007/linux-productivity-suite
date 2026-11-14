"""`slides.*` Atlas AI tools: create, read, edit and export `.atlasdeck` presentations."""
from __future__ import annotations

from ..tools import ToolContext, ToolError, ToolRegistry, ToolResult
from . import atlasdeck as dk
from .service import EXT, SlidesService

_GRANT = {"type": "string", "minLength": 1, "description": "Folder grant id from drive.list_folders"}
_PATH = {"type": "string", "minLength": 1, "description": "Path of the .atlasdeck file inside the shared folder"}
_LINES = {"type": "array", "maxItems": 12, "items": {"type": "string", "maxLength": 400},
          "description": "Bullet points, one per item. Start an item with a tab to indent it one level."}
_SLIDE = {
    "type": "object", "additionalProperties": False, "required": ["layout"],
    "properties": {
        "layout": {"type": "string", "enum": list(dk.LAYOUTS),
                   "description": "title: opening slide (title + subtitle); title-content: title + bullets; section: section divider; "
                                  "two-content: title + two bullet columns; title-only; blank"},
        "title": {"type": "string", "maxLength": 200},
        "subtitle": {"type": "string", "maxLength": 400, "description": "For title and section slides"},
        "bullets": _LINES,
        "bullets_right": {**_LINES, "description": "Right-hand column for two-content slides"},
        "notes": {"type": "string", "maxLength": 4000, "description": "Speaker notes: what the presenter says on this slide"},
    },
}


def _norm_path(path: str) -> str:
    return path if path.endswith(EXT) else path + EXT


def _build(spec: dict) -> dict:
    return dk.fill_slide(spec["layout"], spec.get("title", ""), spec.get("subtitle", ""), spec.get("bullets", []),
                         spec.get("bullets_right", []), spec.get("notes", ""))


def _index(deck: dict, n: int) -> int:
    if not 1 <= n <= len(deck["slides"]):
        raise ToolError(f"slide {n} does not exist; the presentation has {len(deck['slides'])} slides (numbered from 1)", "invalid_arguments")
    return n - 1


def register(reg: ToolRegistry, svc: SlidesService) -> None:
    def changed(grant: str, path: str) -> list[dict]:
        return [{"kind": "document", "grant": grant, "path": path}]

    @reg.tool("slides.create",
              "Create a presentation (.atlasdeck) from a list of slides. Start with a 'title' slide, keep bullets short (under ~10 words, "
              "3-6 per slide) and put talking points in notes.",
              {"type": "object", "additionalProperties": False, "required": ["grant", "path", "title", "slides"], "properties": {
                  "grant": _GRANT, "path": _PATH, "title": {"type": "string", "minLength": 1, "maxLength": 200},
                  "theme": {"type": "string", "enum": list(dk.THEMES), "description": "atlas (light), midnight (dark), ocean, paper (warm serif), forest"},
                  "slides": {"type": "array", "minItems": 1, "maxItems": 60, "items": _SLIDE}}}, "write", "slides")
    def create(args, ctx: ToolContext):
        path = _norm_path(args["path"])
        deck = dk.new_deck(args["title"], args.get("theme", "atlas"))
        deck["slides"] = [_build(s) for s in args["slides"]]
        svc.save(args["grant"], path, deck, create=True)
        return ToolResult({"path": path, "slides": len(deck["slides"])}, summary=f"Created {path} ({len(deck['slides'])} slides)",
                          changed=changed(args["grant"], path))

    @reg.tool("slides.read", "Read a presentation: theme and each slide's number, layout, text and speaker notes.",
              {"type": "object", "additionalProperties": False, "required": ["grant", "path"], "properties": {"grant": _GRANT, "path": _PATH}},
              "read", "slides")
    def read(args, ctx):
        deck = svc.load(args["grant"], args["path"])
        slides = [{"slide": i + 1, "layout": s["layout"],
                   "text": [{"role": e["role"], "text": e["text"]} for e in s["elements"] if e["text"].strip()], "notes": s["notes"]}
                  for i, s in enumerate(deck["slides"])]
        return ToolResult({"title": deck["title"], "theme": deck["theme"], "slides": slides}, untrusted=True,
                          source=f"presentation {args['path']}", summary=f"Read {args['path']} ({len(slides)} slides)")

    @reg.tool("slides.add_slides", "Insert slides into a presentation after slide `after` (0 = at the start; omit to append).",
              {"type": "object", "additionalProperties": False, "required": ["grant", "path", "slides"], "properties": {
                  "grant": _GRANT, "path": _PATH, "after": {"type": "integer", "minimum": 0},
                  "slides": {"type": "array", "minItems": 1, "maxItems": 40, "items": _SLIDE}}}, "write", "slides")
    def add_slides(args, ctx):
        deck = svc.load(args["grant"], args["path"])
        at = min(args.get("after", len(deck["slides"])), len(deck["slides"]))
        new = [_build(s) for s in args["slides"]]
        if len(deck["slides"]) + len(new) > dk.MAX_SLIDES:
            raise ToolError(f"a presentation can have up to {dk.MAX_SLIDES} slides", "invalid_arguments")
        deck["slides"][at:at] = new
        svc.save(args["grant"], args["path"], deck)
        return ToolResult({"inserted": [at + 1 + i for i in range(len(new))], "slides": len(deck["slides"])},
                          summary=f"Added {len(new)} slide(s) to {args['path']}", changed=changed(args["grant"], args["path"]))

    @reg.tool("slides.update_slide",
              "Change one slide. Only the fields you pass change; passing `layout` rebuilds the slide on that layout using the given text.",
              {"type": "object", "additionalProperties": False, "required": ["grant", "path", "slide"], "properties": {
                  "grant": _GRANT, "path": _PATH, "slide": {"type": "integer", "minimum": 1, "description": "Slide number, from 1"},
                  **{k: v for k, v in _SLIDE["properties"].items()}}}, "write", "slides")
    def update_slide(args, ctx):
        deck = svc.load(args["grant"], args["path"])
        i = _index(deck, args["slide"])
        old = deck["slides"][i]
        if "layout" in args:
            texts = {r: [e["text"] for e in old["elements"] if e["role"] == r] for r in dk.ROLES}
            spec = {"layout": args["layout"], "title": args.get("title", (texts["title"] or [""])[0]),
                    "subtitle": args.get("subtitle", (texts["subtitle"] or [""])[0]),
                    "bullets": args.get("bullets", (texts["body"] or [""])[0].split("\n") if texts["body"] else []),
                    "bullets_right": args.get("bullets_right", texts["body"][1].split("\n") if len(texts["body"]) > 1 else []),
                    "notes": args.get("notes", old["notes"])}
            new = _build(spec)
            new["id"] = old["id"]
            new["elements"] += [e for e in old["elements"] if e["role"] == "text"]  # keep free text boxes
            deck["slides"][i] = new
        else:
            bodies = [e for e in old["elements"] if e["role"] == "body"]
            for e in old["elements"]:
                if e["role"] == "title" and "title" in args:
                    e["text"] = args["title"]
                if e["role"] == "subtitle" and "subtitle" in args:
                    e["text"] = args["subtitle"]
            for key, n in (("bullets", 0), ("bullets_right", 1)):
                if key in args:
                    if n >= len(bodies):
                        raise ToolError(f"slide {args['slide']} has no box for {key}; pass a layout such as two-content", "invalid_arguments")
                    bodies[n]["text"] = "\n".join(args[key])
            missing = [k for k in ("title", "subtitle") if k in args and not any(e["role"] == k for e in old["elements"])]
            if missing:
                raise ToolError(f"slide {args['slide']} has no {missing[0]} box on its '{old['layout']}' layout; pass a layout too", "invalid_arguments")
            if "notes" in args:
                old["notes"] = args["notes"]
        svc.save(args["grant"], args["path"], deck)
        return ToolResult({"slide": args["slide"]}, summary=f"Updated slide {args['slide']} of {args['path']}", changed=changed(args["grant"], args["path"]))

    @reg.tool("slides.delete_slides", "Delete slides by number (numbered from 1).",
              {"type": "object", "additionalProperties": False, "required": ["grant", "path", "slides"], "properties": {
                  "grant": _GRANT, "path": _PATH, "slides": {"type": "array", "minItems": 1, "maxItems": 200, "items": {"type": "integer", "minimum": 1}}}},
              "write", "slides")
    def delete_slides(args, ctx):
        deck = svc.load(args["grant"], args["path"])
        drop = {_index(deck, n) for n in args["slides"]}
        if len(drop) >= len(deck["slides"]):
            raise ToolError("a presentation needs at least one slide", "invalid_arguments")
        deck["slides"] = [s for i, s in enumerate(deck["slides"]) if i not in drop]
        svc.save(args["grant"], args["path"], deck)
        return ToolResult({"slides": len(deck["slides"])}, summary=f"Deleted {len(drop)} slide(s) from {args['path']}",
                          changed=changed(args["grant"], args["path"]))

    @reg.tool("slides.move_slide", "Move a slide to a new position (both numbered from 1).",
              {"type": "object", "additionalProperties": False, "required": ["grant", "path", "slide", "to"], "properties": {
                  "grant": _GRANT, "path": _PATH, "slide": {"type": "integer", "minimum": 1}, "to": {"type": "integer", "minimum": 1}}},
              "write", "slides")
    def move_slide(args, ctx):
        deck = svc.load(args["grant"], args["path"])
        i, j = _index(deck, args["slide"]), _index(deck, args["to"])
        deck["slides"].insert(j, deck["slides"].pop(i))
        svc.save(args["grant"], args["path"], deck)
        return ToolResult({"slide": j + 1}, summary=f"Moved slide {i + 1} to {j + 1} in {args['path']}", changed=changed(args["grant"], args["path"]))

    @reg.tool("slides.set_theme", "Change a presentation's theme.",
              {"type": "object", "additionalProperties": False, "required": ["grant", "path", "theme"], "properties": {
                  "grant": _GRANT, "path": _PATH, "theme": {"type": "string", "enum": list(dk.THEMES)}}}, "write", "slides")
    def set_theme(args, ctx):
        deck = svc.load(args["grant"], args["path"])
        deck["theme"] = args["theme"]
        svc.save(args["grant"], args["path"], deck)
        return ToolResult({"theme": args["theme"]}, summary=f"Applied the {dk.THEMES[args['theme']]['name']} theme to {args['path']}",
                          changed=changed(args["grant"], args["path"]))

    @reg.tool("slides.export_pptx", "Export a presentation to PowerPoint (.pptx) next to it, with speaker notes.",
              {"type": "object", "additionalProperties": False, "required": ["grant", "path"], "properties": {"grant": _GRANT, "path": _PATH}},
              "write", "slides")
    def export(args, ctx):
        r = svc.export_file(args["grant"], args["path"])
        return ToolResult(r, summary=f"Exported {r['path']}", changed=[{"kind": "file", "grant": args["grant"], "path": r["path"]}])
