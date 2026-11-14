"""The `.atlasdeck` model shared with the shell (apps/shell/src/slides/model.ts).

A deck is a list of 1280 x 720 slides. Each slide has a layout, positioned text boxes and speaker notes.
"""
from __future__ import annotations

import secrets

FORMAT = "atlas.deck"
SLIDE_W, SLIDE_H = 1280, 720
MAX_SLIDES = 200
MAX_ELEMENTS = 30
LAYOUTS = ("title", "title-content", "section", "two-content", "title-only", "blank")
ROLES = ("title", "subtitle", "body", "text")
ALIGNS = ("left", "center", "right")
# Same colours and fonts as THEMES in model.ts.
THEMES = {
    "atlas": {"name": "Atlas", "bg": "FFFFFF", "fg": "1C2430", "muted": "4F5B6B", "accent": "2A78D6", "font": "Inter"},
    "midnight": {"name": "Midnight", "bg": "101826", "fg": "EEF2F7", "muted": "B4C0D0", "accent": "6AA8FF", "font": "Inter"},
    "ocean": {"name": "Ocean", "bg": "0D4F6B", "fg": "FFFFFF", "muted": "D3ECF5", "accent": "FFD166", "font": "Inter"},
    "paper": {"name": "Paper", "bg": "F7F1E3", "fg": "2D2418", "muted": "5C4E3A", "accent": "A4471C", "font": "Georgia"},
    "forest": {"name": "Forest", "bg": "16352A", "fg": "F1F7F2", "muted": "C3D9CB", "accent": "9FD86B", "font": "Inter"},
}


class DeckError(Exception):
    pass


def new_id(prefix: str) -> str:
    return prefix + secrets.token_hex(5)


def _box(role: str, x: int, y: int, w: int, h: int, size: int, **extra) -> dict:
    return {"id": new_id("e"), "kind": "text", "role": role, "x": x, "y": y, "w": w, "h": h, "text": "", "size": size, **extra}


def layout_elements(layout: str) -> list[dict]:
    """Placeholder boxes for a layout (same geometry as layoutElements() in model.ts)."""
    if layout == "title":
        return [_box("title", 120, 220, 1040, 160, 64, bold=True, align="center"), _box("subtitle", 200, 400, 880, 90, 30, align="center")]
    if layout == "title-content":
        return [_box("title", 80, 48, 1120, 110, 48, bold=True), _box("body", 80, 180, 1120, 480, 30, bullets=True)]
    if layout == "section":
        return [_box("title", 120, 260, 1040, 140, 60, bold=True), _box("subtitle", 120, 410, 1040, 80, 28)]
    if layout == "two-content":
        return [_box("title", 80, 48, 1120, 110, 48, bold=True), _box("body", 80, 180, 540, 480, 28, bullets=True),
                _box("body", 660, 180, 540, 480, 28, bullets=True)]
    if layout == "title-only":
        return [_box("title", 80, 48, 1120, 110, 48, bold=True)]
    return []


def new_slide(layout: str = "title-content") -> dict:
    return {"id": new_id("s"), "layout": layout if layout in LAYOUTS else "blank", "elements": layout_elements(layout), "notes": ""}


def new_deck(title: str, theme: str = "atlas") -> dict:
    first = new_slide("title")
    first["elements"][0]["text"] = title
    return {"format": FORMAT, "version": 1, "title": title.strip()[:200] or "Untitled presentation", "theme": theme if theme in THEMES else "atlas",
            "slides": [first]}


def _num(v: object, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(hi, round(float(v))))  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError):
        return default


def validate(value: object) -> dict:
    """Clean untrusted JSON into a deck (same rules as normalizeDeck() in model.ts)."""
    if not isinstance(value, dict) or value.get("format") != FORMAT or not isinstance(value.get("slides"), list):
        raise DeckError("not an Atlas presentation")
    slides = []
    for s in value["slides"][:MAX_SLIDES]:
        if not isinstance(s, dict):
            continue
        elements = []
        for e in (s.get("elements") if isinstance(s.get("elements"), list) else [])[:MAX_ELEMENTS]:
            if not isinstance(e, dict):
                continue
            out = {"id": str(e.get("id") or new_id("e"))[:40], "kind": "text", "role": e.get("role") if e.get("role") in ROLES else "text",
                   "x": _num(e.get("x"), -SLIDE_W, SLIDE_W * 2, 80), "y": _num(e.get("y"), -SLIDE_H, SLIDE_H * 2, 80),
                   "w": _num(e.get("w"), 20, SLIDE_W * 2, 400), "h": _num(e.get("h"), 20, SLIDE_H * 2, 100),
                   "text": e["text"][:10000] if isinstance(e.get("text"), str) else "", "size": _num(e.get("size"), 8, 200, 28)}
            for k in ("bold", "italic", "underline", "bullets"):
                if e.get(k) is True:
                    out[k] = True
            if e.get("align") in ALIGNS:
                out["align"] = e["align"]
            elements.append(out)
        slides.append({"id": str(s.get("id") or new_id("s"))[:40], "layout": s.get("layout") if s.get("layout") in LAYOUTS else "blank",
                       "elements": elements, "notes": s["notes"][:20000] if isinstance(s.get("notes"), str) else ""})
    if not slides:
        slides.append(new_slide("title"))
    return {"format": FORMAT, "version": 1, "title": str(value.get("title") or "Untitled presentation")[:200],
            "theme": value.get("theme") if value.get("theme") in THEMES else "atlas", "slides": slides}


def fill_slide(layout: str, title: str = "", subtitle: str = "", body: str | list[str] = "", body2: str | list[str] = "", notes: str = "") -> dict:
    """A slide for `layout` with its placeholders filled; text for boxes the layout lacks is dropped."""
    slide = new_slide(layout)
    as_text = lambda v: "\n".join(v) if isinstance(v, list) else str(v or "")  # noqa: E731
    bodies = [as_text(body), as_text(body2)]
    for e in slide["elements"]:
        if e["role"] == "title":
            e["text"] = title
        elif e["role"] == "subtitle":
            e["text"] = subtitle or bodies[0]
        elif e["role"] == "body":
            e["text"] = bodies.pop(0) if bodies else ""
    slide["notes"] = notes
    return slide


def slide_title(slide: dict) -> str:
    return next((e["text"].split("\n")[0] for e in slide["elements"] if e["role"] == "title" and e["text"].strip()), "")
