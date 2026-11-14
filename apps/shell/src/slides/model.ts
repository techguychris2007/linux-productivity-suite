// The `.atlasdeck` presentation model, shared with services/engine/atlas_engine/slides/atlasdeck.py.
// Slides use a fixed 1280 × 720 (16:9) coordinate space; elements are positioned text boxes.

export const SLIDE_W = 1280;
export const SLIDE_H = 720;
export const FORMAT = "atlas.deck";
export const MAX_SLIDES = 200;
export const MAX_ELEMENTS = 30;

export type Layout = "title" | "title-content" | "section" | "two-content" | "title-only" | "blank";
export type Role = "title" | "subtitle" | "body" | "text";
export type Align = "left" | "center" | "right";

export interface SlideElement {
  id: string; kind: "text"; role: Role;
  x: number; y: number; w: number; h: number;
  text: string;
  /** Font size in slide pixels. */
  size: number;
  bold?: boolean; italic?: boolean; underline?: boolean;
  align?: Align;
  /** Show each line as a bullet. */
  bullets?: boolean;
}
export interface Slide { id: string; layout: Layout; elements: SlideElement[]; notes: string }
export interface AtlasDeck { format: typeof FORMAT; version: 1; title: string; theme: ThemeId; slides: Slide[] }

export type ThemeId = "atlas" | "midnight" | "ocean" | "paper" | "forest";
export interface Theme { id: ThemeId; name: string; bg: string; fg: string; muted: string; accent: string; heading: string; body: string }
// Each theme's text colours meet WCAG AA contrast (4.5:1) on its background.
export const THEMES: Theme[] = [
  { id: "atlas", name: "Atlas", bg: "#ffffff", fg: "#1c2430", muted: "#4f5b6b", accent: "#2a78d6", heading: "Inter, system-ui, sans-serif", body: "Inter, system-ui, sans-serif" },
  { id: "midnight", name: "Midnight", bg: "#101826", fg: "#eef2f7", muted: "#b4c0d0", accent: "#6aa8ff", heading: "Inter, system-ui, sans-serif", body: "Inter, system-ui, sans-serif" },
  { id: "ocean", name: "Ocean", bg: "#0d4f6b", fg: "#ffffff", muted: "#d3ecf5", accent: "#ffd166", heading: "Inter, system-ui, sans-serif", body: "Inter, system-ui, sans-serif" },
  { id: "paper", name: "Paper", bg: "#f7f1e3", fg: "#2d2418", muted: "#5c4e3a", accent: "#a4471c", heading: "Georgia, 'Times New Roman', serif", body: "Georgia, 'Times New Roman', serif" },
  { id: "forest", name: "Forest", bg: "#16352a", fg: "#f1f7f2", muted: "#c3d9cb", accent: "#9fd86b", heading: "Inter, system-ui, sans-serif", body: "Inter, system-ui, sans-serif" },
];
export const themeById = (id: string) => THEMES.find((t) => t.id === id) ?? THEMES[0];

export const LAYOUTS: { id: Layout; name: string }[] = [
  { id: "title", name: "Title slide" },
  { id: "title-content", name: "Title and content" },
  { id: "section", name: "Section header" },
  { id: "two-content", name: "Two content" },
  { id: "title-only", name: "Title only" },
  { id: "blank", name: "Blank" },
];
const LAYOUT_IDS = LAYOUTS.map((l) => l.id);
const ROLES: Role[] = ["title", "subtitle", "body", "text"];

let counter = 0;
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const box = (role: Role, x: number, y: number, w: number, h: number, size: number, extra: Partial<SlideElement> = {}): SlideElement =>
  ({ id: newId("e"), kind: "text", role, x, y, w, h, text: "", size, ...extra });

/** Placeholder text boxes for a layout. */
export function layoutElements(layout: Layout): SlideElement[] {
  switch (layout) {
    case "title": return [box("title", 120, 220, 1040, 160, 64, { bold: true, align: "center" }), box("subtitle", 200, 400, 880, 90, 30, { align: "center" })];
    case "title-content": return [box("title", 80, 48, 1120, 110, 48, { bold: true }), box("body", 80, 180, 1120, 480, 30, { bullets: true })];
    case "section": return [box("title", 120, 260, 1040, 140, 60, { bold: true }), box("subtitle", 120, 410, 1040, 80, 28)];
    case "two-content": return [box("title", 80, 48, 1120, 110, 48, { bold: true }), box("body", 80, 180, 540, 480, 28, { bullets: true }), box("body", 660, 180, 540, 480, 28, { bullets: true })];
    case "title-only": return [box("title", 80, 48, 1120, 110, 48, { bold: true })];
    default: return [];
  }
}
export const PLACEHOLDER: Record<Role, string> = { title: "Click to add title", subtitle: "Click to add subtitle", body: "Click to add text", text: "Text" };

export const newSlide = (layout: Layout = "title-content"): Slide => ({ id: newId("s"), layout, elements: layoutElements(layout), notes: "" });

export function newDeck(title: string): AtlasDeck {
  const first = newSlide("title");
  first.elements[0].text = title;
  return { format: FORMAT, version: 1, title, theme: "atlas", slides: [first] };
}

/** Give a slide fresh ids (for duplicate / paste). */
export const cloneSlide = (s: Slide): Slide => ({ ...s, id: newId("s"), elements: s.elements.map((e) => ({ ...e, id: newId("e") })) });

/** Move an element's placeholder boxes onto another layout, keeping text by role and order. */
export function changeLayout(slide: Slide, layout: Layout): Slide {
  const next = layoutElements(layout);
  const pool = slide.elements.filter((e) => e.role !== "text");
  for (const target of next) {
    const i = pool.findIndex((e) => e.role === target.role || (target.role === "subtitle" && e.role === "body") || (target.role === "body" && e.role === "subtitle"));
    if (i >= 0) { target.text = pool[i].text; pool.splice(i, 1); }
  }
  // Text that has no box on the new layout is kept as free text boxes so nothing is lost.
  const kept = pool.filter((e) => e.text.trim()).map((e) => ({ ...e, role: "text" as Role }));
  return { ...slide, layout, elements: [...next, ...kept, ...slide.elements.filter((e) => e.role === "text")] };
}

const n = (v: unknown, min: number, max: number, d: number) => { const x = Number(v); return Number.isFinite(x) ? Math.min(max, Math.max(min, Math.round(x))) : d; };

/** Validate untrusted JSON into a deck (same rules as atlasdeck.validate in the engine). */
export function normalizeDeck(value: any, fallbackTitle = "Untitled presentation"): AtlasDeck {
  if (!value || value.format !== FORMAT || !Array.isArray(value.slides)) throw new Error("This is not an Atlas presentation");
  const slides: Slide[] = value.slides.slice(0, MAX_SLIDES).filter((s: any) => s && typeof s === "object").map((s: any): Slide => ({
    id: typeof s.id === "string" && s.id ? s.id.slice(0, 40) : newId("s"),
    layout: LAYOUT_IDS.includes(s.layout) ? s.layout : "blank",
    notes: typeof s.notes === "string" ? s.notes.slice(0, 20000) : "",
    elements: (Array.isArray(s.elements) ? s.elements : []).slice(0, MAX_ELEMENTS).filter((e: any) => e && typeof e === "object").map((e: any): SlideElement => {
      const out: SlideElement = {
        id: typeof e.id === "string" && e.id ? e.id.slice(0, 40) : newId("e"), kind: "text",
        role: ROLES.includes(e.role) ? e.role : "text",
        x: n(e.x, -SLIDE_W, SLIDE_W * 2, 80), y: n(e.y, -SLIDE_H, SLIDE_H * 2, 80), w: n(e.w, 20, SLIDE_W * 2, 400), h: n(e.h, 20, SLIDE_H * 2, 100),
        text: typeof e.text === "string" ? e.text.slice(0, 10000) : "", size: n(e.size, 8, 200, 28),
      };
      for (const k of ["bold", "italic", "underline", "bullets"] as const) if (e[k] === true) out[k] = true;
      if (["left", "center", "right"].includes(e.align)) out.align = e.align;
      return out;
    }),
  }));
  if (!slides.length) slides.push(newSlide("title"));
  return { format: FORMAT, version: 1, title: String(value.title || fallbackTitle).slice(0, 200), theme: themeById(value.theme).id, slides };
}

/** First non-empty title on a slide, for the outline and thumbnails' accessible names. */
export const slideTitle = (s: Slide) => s.elements.find((e) => e.role === "title" && e.text.trim())?.text.split("\n")[0] ?? "";
