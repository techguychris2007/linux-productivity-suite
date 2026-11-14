// Atlas Slides editor: ribbon, slide panel with drag-to-reorder, a canvas with movable/resizable text boxes,
// speaker notes, slide sorter, themes, slide show and live updates from Atlas AI.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  LuPresentation, LuUndo2, LuRedo2, LuSparkles, LuCheck, LuX, LuBold, LuItalic, LuUnderline, LuAlignLeft, LuAlignCenter, LuAlignRight,
  LuList, LuPlus, LuCopy, LuTrash2, LuLayoutTemplate, LuType, LuPlay, LuMonitor, LuInfo, LuDownload, LuRefreshCw, LuNotebookText,
  LuLayoutGrid, LuRectangleHorizontal, LuAArrowUp, LuAArrowDown, LuFileDown, LuChevronDown, LuArrowUp, LuArrowDown,
} from "react-icons/lu";
import type { EngineEvent } from "@atlas/shared-types";
import { Button, Spinner } from "@atlas/ui";
import { useAtlas, type DocRef } from "../context";
import { Ribbon, RBig, RSmall, RStack, RRow, BackstageSection, Zoom, type RibbonTab } from "../ribbon/Ribbon";
import {
  type AtlasDeck, type Layout, type Slide, type SlideElement, type Align, LAYOUTS, MAX_ELEMENTS, MAX_SLIDES, SLIDE_H, SLIDE_W, THEMES,
  changeLayout, cloneSlide, newId, newSlide, normalizeDeck, slideTitle, themeById,
} from "./model";
import { ElementText, SlideView, elementStyle } from "./render";
import { Present } from "./Present";
import "./slides.css";

type SaveState = "saved" | "dirty" | "saving" | "error";
type Drag = { id: string; mode: "move" | "nw" | "ne" | "sw" | "se"; x0: number; y0: number; start: SlideElement; before: AtlasDeck; moved: boolean };
const SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 54, 60, 72, 88, 96];

function LayoutMenu({ onPick, onClose, label }: { onPick: (l: Layout) => void; onClose: () => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    window.setTimeout(() => window.addEventListener("mousedown", off), 0);
    return () => window.removeEventListener("mousedown", off);
  }, [onClose]);
  return <div ref={ref} className="sl-menu" role="menu" aria-label={label} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
    {LAYOUTS.map((l) => <button key={l.id} role="menuitem" onClick={() => { onPick(l.id); onClose(); }}>
      <span className={`sl-layout-icon sl-li-${l.id}`} aria-hidden="true"><i /><i /><i /></span>{l.name}</button>)}
  </div>;
}

export function SlideEditor({ docRef, onClose }: { docRef: DocRef; onClose: () => void }) {
  const { bridge, notify, setActiveDoc, askAi, grants } = useAtlas();
  const grantLabel = grants.find((g) => g.id === docRef.grant)?.label ?? "";
  const [deck, setDeck] = useState<AtlasDeck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>("saved");
  const [cur, setCur] = useState(0);
  const [selEl, setSelEl] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [tab, setTab] = useState("home");
  const [zoom, setZoom] = useState(100);
  const [notesOpen, setNotesOpen] = useState(true);
  const [view, setView] = useState<"normal" | "sorter">("normal");
  const [show, setShow] = useState<{ start: number; presenter: boolean } | null>(null);
  const [menu, setMenu] = useState<"new" | "layout" | null>(null);
  const [externalChange, setExternalChange] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [dragSlide, setDragSlide] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const latest = useRef<AtlasDeck | null>(null);
  latest.current = deck;
  const past = useRef<AtlasDeck[]>([]);
  const future = useRef<AtlasDeck[]>([]);
  const saveTimer = useRef<number>(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLOListElement>(null);
  const drag = useRef<Drag | null>(null);
  const editSnapshot = useRef<AtlasDeck | null>(null);
  const mounted = useRef(Date.now() / 1000);
  const [stage, setStage] = useState({ w: 800, h: 450 });

  // ---------- load / save ----------
  const load = useCallback(async () => {
    try {
      const r = await bridge.core<{ content: string }>("fs.read_text", { grant: docRef.grant, path: docRef.path, max_bytes: 4_000_000 });
      const d = normalizeDeck(JSON.parse(r.content), docRef.path.split("/").pop()?.replace(/\.atlasdeck$/, ""));
      latest.current = d; setDeck(d); setSave("saved"); setError(null); setExternalChange(false);
      setCur((c) => Math.min(c, d.slides.length - 1));
    } catch (e: any) { setError(e.message); }
  }, [bridge, docRef]);
  useEffect(() => { load(); past.current = []; future.current = []; }, [load]);
  useEffect(() => { if (deck) setActiveDoc({ ...docRef, app: "slides", title: deck.title }); return () => setActiveDoc(null); }, [docRef, deck?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  const persist = useCallback(async () => {
    const d = latest.current; if (!d) return false;
    window.clearTimeout(saveTimer.current); setSave("saving");
    try {
      await bridge.core("fs.write_text", { grant: docRef.grant, path: docRef.path, content: JSON.stringify(d, null, 1), overwrite: true, backup: false });
      setSave((st) => latest.current === d ? "saved" : st === "saving" ? "dirty" : st);
      return true;
    } catch (e: any) { setSave("error"); notify({ tone: "danger", title: "Couldn't save the presentation", body: e.message }); }
    return false;
  }, [bridge, docRef, notify]);
  const schedule = useCallback(() => { setSave("dirty"); window.clearTimeout(saveTimer.current); saveTimer.current = window.setTimeout(persist, 700); }, [persist]);

  const saveRef = useRef(save); saveRef.current = save;
  useEffect(() => bridge.subscribe(0, (ev: EngineEvent) => {
    if (ev.type !== "resource.changed" || ev.ts < mounted.current) return;
    if (ev.data.grant !== docRef.grant || ev.data.path !== docRef.path) return;
    if (saveRef.current === "saved") { load(); notify({ tone: "info", title: "Atlas AI updated this presentation" }); } else setExternalChange(true);
  }, () => {}), [bridge, docRef, load, notify]);
  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  /** Change the deck as one undo step. */
  const apply = useCallback((fn: (d: AtlasDeck) => AtlasDeck) => {
    const d = latest.current; if (!d) return;
    past.current.push(d); if (past.current.length > 150) past.current.shift(); future.current = [];
    const next = fn(d); latest.current = next; setDeck(next); schedule();
  }, [schedule]);
  /** Change the deck without a new undo step (drags and typing, whose step was recorded when they began). */
  const live = (fn: (d: AtlasDeck) => AtlasDeck) => { const d = latest.current; if (!d) return; const next = fn(d); latest.current = next; setDeck(next); schedule(); };
  const jump = (to: AtlasDeck | undefined, from: AtlasDeck[]) => {
    const now = latest.current; if (!to || !now) return;
    from.push(now); latest.current = to; setDeck(to); setCur((c) => Math.min(c, to.slides.length - 1)); setEditing(null); schedule();
  };
  const undo = () => jump(past.current.pop(), future.current);
  const redo = () => jump(future.current.pop(), past.current);

  // ---------- canvas size ----------
  useLayoutEffect(() => {
    const el = stageRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el); setStage({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [deck === null, view, notesOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  const fitScale = Math.max(0.1, Math.min((stage.w - 48) / SLIDE_W, (stage.h - 48) / SLIDE_H));
  const scale = fitScale * zoom / 100;

  // ---------- helpers ----------
  const slide: Slide | undefined = deck?.slides[cur];
  const theme = themeById(deck?.theme ?? "atlas");
  const element = slide?.elements.find((e) => e.id === selEl) ?? null;
  const setSlide = (fn: (s: Slide) => Slide, history = true) => (history ? apply : live)((d) => ({ ...d, slides: d.slides.map((s, i) => i === cur ? fn(s) : s) }));
  const setElement = (id: string, patch: Partial<SlideElement>, history = true) => setSlide((s) => ({ ...s, elements: s.elements.map((e) => e.id === id ? { ...e, ...patch } : e) }), history);
  const selectSlide = (i: number) => { if (!deck) return; setCur(Math.max(0, Math.min(deck.slides.length - 1, i))); setSelEl(null); setEditing(null); };

  const addSlide = (layout: Layout = "title-content", at = cur + 1) => {
    if (!deck || deck.slides.length >= MAX_SLIDES) { notify({ tone: "warning", title: `A presentation can have up to ${MAX_SLIDES} slides` }); return; }
    apply((d) => { const slides = [...d.slides]; slides.splice(at, 0, newSlide(layout)); return { ...d, slides }; });
    setCur(at); setSelEl(null); setEditing(null);
  };
  const duplicateSlide = (i = cur) => {
    if (!deck || deck.slides.length >= MAX_SLIDES) return;
    apply((d) => { const slides = [...d.slides]; slides.splice(i + 1, 0, cloneSlide(d.slides[i])); return { ...d, slides }; });
    setCur(i + 1);
  };
  const deleteSlide = (i = cur) => {
    if (!deck) return;
    apply((d) => { const slides = d.slides.filter((_, j) => j !== i); return { ...d, slides: slides.length ? slides : [newSlide("title")] }; });
    setCur(Math.max(0, Math.min(i, deck.slides.length - 2))); setSelEl(null); setEditing(null);
  };
  const moveSlide = (from: number, to: number) => {
    if (!deck || from === to || to < 0 || to >= deck.slides.length) return;
    apply((d) => { const slides = [...d.slides]; const [s] = slides.splice(from, 1); slides.splice(to, 0, s); return { ...d, slides }; });
    setCur(to);
  };
  const addTextBox = () => {
    if (!slide || slide.elements.length >= MAX_ELEMENTS) return;
    const e: SlideElement = { id: newId("e"), kind: "text", role: "text", x: 440, y: 300, w: 400, h: 120, text: "", size: 28 };
    setSlide((s) => ({ ...s, elements: [...s.elements, e] }));
    setSelEl(e.id); startEditing(e.id);
  };
  const deleteElement = (id: string) => { setSlide((s) => ({ ...s, elements: s.elements.filter((e) => e.id !== id) })); setSelEl(null); setEditing(null); };
  const startEditing = (id: string) => { editSnapshot.current = null; setEditing(id); setSelEl(id); };
  const typeText = (id: string, text: string) => {
    // The first keystroke of an edit session records one undo step; the rest update in place.
    if (!editSnapshot.current) { editSnapshot.current = latest.current; setElement(id, { text }, true); }
    else setElement(id, { text }, false);
  };
  const stopEditing = () => { setEditing(null); editSnapshot.current = null; canvasRef.current?.focus(); };

  /** Formatting applies to the selected box, or to every box on the slide when none is selected. */
  const targets = () => element ? [element.id] : slide?.elements.map((e) => e.id) ?? [];
  const format = (patch: (e: SlideElement) => Partial<SlideElement>) => {
    const ids = new Set(targets()); if (!ids.size) return;
    setSlide((s) => ({ ...s, elements: s.elements.map((e) => ids.has(e.id) ? { ...e, ...patch(e) } : e) }));
  };
  const toggle = (k: "bold" | "italic" | "underline" | "bullets") => { const on = !(element ?? slide?.elements[0])?.[k]; format(() => ({ [k]: on || undefined })); };
  const grow = (dir: 1 | -1) => format((e) => {
    const i = SIZES.findIndex((s) => s >= e.size);
    const next = dir > 0 ? SIZES[Math.min(SIZES.length - 1, (i < 0 ? SIZES.length - 1 : SIZES[i] === e.size ? i + 1 : i))] : SIZES[Math.max(0, (i < 0 ? SIZES.length : i) - 1)];
    return { size: next };
  });

  // ---------- pointer: move / resize ----------
  const onPointerDown = (e: React.PointerEvent, el: SlideElement, mode: Drag["mode"]) => {
    if (editing === el.id && mode === "move") return;
    e.stopPropagation(); e.preventDefault();
    setSelEl(el.id); if (editing !== el.id) setEditing(null);
    canvasRef.current?.focus();
    drag.current = { id: el.id, mode, x0: e.clientX, y0: e.clientY, start: el, before: latest.current!, moved: false };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = (e.clientX - d.x0) / scale, dy = (e.clientY - d.y0) / scale;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    if (!d.moved) { d.moved = true; past.current.push(d.before); future.current = []; }
    const s = d.start; let { x, y, w, h } = s;
    if (d.mode === "move") { x = s.x + dx; y = s.y + dy; }
    else {
      if (d.mode.includes("e")) w = s.w + dx;
      if (d.mode.includes("s")) h = s.h + dy;
      if (d.mode.includes("w")) { w = s.w - dx; x = s.x + dx; }
      if (d.mode.includes("n")) { h = s.h - dy; y = s.y + dy; }
      if (w < 40) { if (d.mode.includes("w")) x -= 40 - w; w = 40; }
      if (h < 30) { if (d.mode.includes("n")) y -= 30 - h; h = 30; }
    }
    const snap = (v: number) => e.altKey ? Math.round(v) : Math.round(v / 8) * 8; // hold Alt for free placement
    setElement(d.id, { x: snap(x), y: snap(y), w: snap(w), h: snap(h) }, false);
  };
  const onPointerUp = () => { drag.current = null; };

  // ---------- keyboard ----------
  const onCanvasKey = (e: React.KeyboardEvent) => {
    if (editing) return;
    if (element && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); deleteElement(element.id); return; }
    if (element && (e.key === "Enter" || e.key === "F2")) { e.preventDefault(); startEditing(element.id); return; }
    if (element && e.key.startsWith("Arrow")) {
      e.preventDefault(); const step = e.shiftKey ? 32 : 8;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0, dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      setElement(element.id, { x: element.x + dx, y: element.y + dy }); return;
    }
    if (e.key === "Tab" && slide?.elements.length) {
      e.preventDefault(); const i = slide.elements.findIndex((x) => x.id === selEl);
      setSelEl(slide.elements[(i + (e.shiftKey ? -1 : 1) + slide.elements.length) % slide.elements.length].id); return;
    }
    if (e.key === "Escape") { setSelEl(null); return; }
    if (!element && (e.key === "PageDown" || e.key === "ArrowDown" || e.key === "ArrowRight")) { e.preventDefault(); selectSlide(cur + 1); }
    if (!element && (e.key === "PageUp" || e.key === "ArrowUp" || e.key === "ArrowLeft")) { e.preventDefault(); selectSlide(cur - 1); }
  };
  const onPanelKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); e.altKey ? moveSlide(cur, cur + 1) : selectSlide(cur + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); e.altKey ? moveSlide(cur, cur - 1) : selectSlide(cur - 1); }
    else if (e.key === "Home") selectSlide(0);
    else if (e.key === "End" && deck) selectSlide(deck.slides.length - 1);
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSlide(); }
    else if (e.key === "Enter") { e.preventDefault(); addSlide(); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (show) return;
      const mod = e.ctrlKey || e.metaKey;
      const inText = (e.target as HTMLElement)?.matches?.("input, textarea, select");
      if (e.key === "F5") { e.preventDefault(); setShow({ start: e.shiftKey ? cur : 0, presenter: false }); return; }
      if (mod && e.key.toLowerCase() === "m") { e.preventDefault(); addSlide(); return; }
      if (inText) return;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
      else if (mod && e.key.toLowerCase() === "d" && !element) { e.preventDefault(); duplicateSlide(); }
      else if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); toggle("bold"); }
      else if (mod && e.key.toLowerCase() === "i") { e.preventDefault(); toggle("italic"); }
      else if (mod && e.key.toLowerCase() === "u") { e.preventDefault(); toggle("underline"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // Keep the current thumbnail in view.
  useEffect(() => { panelRef.current?.querySelector<HTMLElement>(`[data-index="${cur}"]`)?.scrollIntoView({ block: "nearest" }); }, [cur]);

  // ---------- file ----------
  const close = async () => { setEditing(null); if (await persist()) onClose(); };
  const exportPptx = async () => {
    setExporting(true);
    try {
      if (!await persist()) return;
      const r = await bridge.engine<{ path: string }>("POST", "/slides/export", { grant: docRef.grant, path: docRef.path });
      notify({ tone: "success", title: "Exported to PowerPoint", body: `Saved ${r.path} in ${grantLabel}` });
    } catch (e: any) { notify({ tone: "danger", title: "PowerPoint export failed", body: e.message }); }
    finally { setExporting(false); }
  };
  const exportOutline = () => {
    if (!deck) return;
    const text = deck.slides.map((s, i) => [`${i + 1}. ${slideTitle(s) || "(untitled)"}`, ...s.elements.filter((e) => e.role !== "title" && e.text.trim()).map((e) => e.text.split("\n").map((l) => `   ${e.bullets ? "• " : ""}${l}`).join("\n")),
      s.notes.trim() ? `   Notes: ${s.notes.trim()}` : ""].filter(Boolean).join("\n")).join("\n\n");
    const url = URL.createObjectURL(new Blob([text + "\n"], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `${deck.title || "presentation"} outline.txt`; a.click(); URL.revokeObjectURL(url);
  };

  if (error) return <div className="page"><div className="banner banner-danger">Could not open this presentation: {error}</div><Button onClick={onClose}>Back</Button></div>;
  if (!deck || !slide) return <div className="page"><p className="muted"><Spinner /> Opening…</p></div>;
  if (show) return <Present deck={deck} start={show.start} presenter={show.presenter} onExit={(at) => { setShow(null); selectSlide(at); }} />;

  const saveLabel = save === "saved" ? <><LuCheck /> Saved to {grantLabel}</> : save === "saving" ? "Saving…" : save === "dirty" ? "Unsaved changes" : "Not saved";
  const ref = element ?? slide.elements[0];
  const alignBtn = (a: Align, icon: React.ReactNode, label: string) => <RSmall icon={icon} label={label} active={(ref?.align ?? "left") === a} onClick={() => format(() => ({ align: a === "left" ? undefined : a }))} />;

  const tabs: RibbonTab[] = [
    { id: "home", label: "Home", groups: [
      { label: "Slides", content: <>
        <div className="sl-split"><RBig icon={<LuPlus />} label="New slide" onClick={() => addSlide()} title="New slide (Ctrl M)" />
          <button className="sl-split-arrow" aria-label="New slide with a layout" aria-haspopup="menu" aria-expanded={menu === "new"} onClick={() => setMenu(menu === "new" ? null : "new")}><LuChevronDown /></button>
          {menu === "new" && <LayoutMenu label="New slide layout" onPick={(l) => addSlide(l)} onClose={() => setMenu(null)} />}</div>
        <RStack>
          <div className="sl-split-inline"><RSmall icon={<LuLayoutTemplate />} label="Layout" showLabel onClick={() => setMenu(menu === "layout" ? null : "layout")} />
            {menu === "layout" && <LayoutMenu label="Slide layout" onPick={(l) => setSlide((s) => changeLayout(s, l))} onClose={() => setMenu(null)} />}</div>
          <RSmall icon={<LuCopy />} label="Duplicate" showLabel onClick={() => duplicateSlide()} title="Duplicate slide (Ctrl D)" />
          <RSmall icon={<LuTrash2 />} label="Delete" showLabel onClick={() => deleteSlide()} />
        </RStack></> },
      { label: "Font", content: <RStack>
        <RRow>
          <select className="rb-select" aria-label="Font size" value={ref?.size ?? 28} onChange={(e) => format(() => ({ size: Number(e.target.value) }))}>
            {[...new Set([...SIZES, ref?.size ?? 28])].sort((a, b) => a - b).map((s) => <option key={s} value={s}>{s}</option>)}</select>
          <RSmall icon={<LuAArrowUp />} label="Increase font size" onClick={() => grow(1)} />
          <RSmall icon={<LuAArrowDown />} label="Decrease font size" onClick={() => grow(-1)} />
        </RRow>
        <RRow>
          <RSmall icon={<LuBold />} label="Bold (Ctrl B)" active={!!ref?.bold} onClick={() => toggle("bold")} />
          <RSmall icon={<LuItalic />} label="Italic (Ctrl I)" active={!!ref?.italic} onClick={() => toggle("italic")} />
          <RSmall icon={<LuUnderline />} label="Underline (Ctrl U)" active={!!ref?.underline} onClick={() => toggle("underline")} />
        </RRow></RStack> },
      { label: "Paragraph", content: <RStack>
        <RRow>{alignBtn("left", <LuAlignLeft />, "Align left")}{alignBtn("center", <LuAlignCenter />, "Center")}{alignBtn("right", <LuAlignRight />, "Align right")}</RRow>
        <RRow><RSmall icon={<LuList />} label="Bullets" showLabel active={!!ref?.bullets} onClick={() => toggle("bullets")} /></RRow></RStack> },
      { label: "Insert", content: <RBig icon={<LuType />} label="Text box" onClick={addTextBox} /> },
      { label: "Atlas AI", content: <RBig icon={<LuSparkles />} label="Ask Atlas AI" onClick={() => askAi(`In the open presentation "${docRef.path}" (slide ${cur + 1}), `)} /> },
    ] },
    { id: "insert", label: "Insert", groups: [
      { label: "Slides", content: <><RBig icon={<LuPlus />} label="New slide" onClick={() => addSlide()} /><RBig icon={<LuCopy />} label="Duplicate" onClick={() => duplicateSlide()} /></> },
      { label: "Text", content: <RBig icon={<LuType />} label="Text box" onClick={addTextBox} /> },
    ] },
    { id: "design", label: "Design", groups: [
      { label: "Themes", content: <div className="sl-themes" role="radiogroup" aria-label="Theme">
        {THEMES.map((t) => <button key={t.id} role="radio" aria-checked={deck.theme === t.id} className={`sl-theme ${deck.theme === t.id ? "is-active" : ""}`}
          onClick={() => apply((d) => ({ ...d, theme: t.id }))} title={t.name}>
          <span className="sl-theme-swatch" style={{ background: t.bg, color: t.fg, fontFamily: t.heading }}>Aa<i style={{ background: t.accent }} /></span>
          <span className="sl-theme-name">{t.name}</span></button>)}
      </div> },
    ] },
    { id: "show", label: "Slide Show", groups: [
      { label: "Start slide show", content: <>
        <RBig icon={<LuPlay />} label="From beginning" onClick={() => setShow({ start: 0, presenter: false })} title="From beginning (F5)" />
        <RBig icon={<LuRectangleHorizontal />} label="From current slide" onClick={() => setShow({ start: cur, presenter: false })} title="From current slide (Shift F5)" />
        <RBig icon={<LuMonitor />} label="Presenter view" onClick={() => setShow({ start: cur, presenter: true })} title="Slide show with notes, next slide and a timer" />
      </> },
    ] },
    { id: "view", label: "View", groups: [
      { label: "Presentation views", content: <>
        <RBig icon={<LuPresentation />} label="Normal" active={view === "normal"} onClick={() => setView("normal")} />
        <RBig icon={<LuLayoutGrid />} label="Slide sorter" active={view === "sorter"} onClick={() => setView("sorter")} />
      </> },
      { label: "Show", content: <RBig icon={<LuNotebookText />} label="Notes" active={notesOpen} onClick={() => setNotesOpen((o) => !o)} /> },
    ] },
  ];

  const thumbW = 168;
  const dropHandlers = (i: number) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => { setDragSlide(i); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); },
    onDragOver: (e: React.DragEvent) => { if (dragSlide === null) return; e.preventDefault(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const after = view === "sorter" ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2; setDropAt(after ? i + 1 : i); },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); if (dragSlide !== null && dropAt !== null) moveSlide(dragSlide, dropAt > dragSlide ? dropAt - 1 : dropAt); setDragSlide(null); setDropAt(null); },
    onDragEnd: () => { setDragSlide(null); setDropAt(null); },
  });

  return (
    <div className="sl-editor app-slides">
      <Ribbon appName="Slides" appIcon={<LuPresentation />} title={deck.title} status={<span className={`w-save w-save-${save}`} aria-live="polite">{saveLabel}</span>}
        onBack={close} tabs={tabs} activeTab={tab} onTab={setTab}
        quick={<>
          <button onClick={undo} disabled={!past.current.length} aria-label="Undo" title="Undo (Ctrl Z)"><LuUndo2 /></button>
          <button onClick={redo} disabled={!future.current.length} aria-label="Redo" title="Redo (Ctrl Y)"><LuRedo2 /></button>
          <button onClick={() => setShow({ start: cur, presenter: false })} aria-label="Start the slide show from this slide" title="Present (Shift F5)"><LuPlay /></button>
          <button onClick={() => askAi(`In the open presentation "${docRef.path}" (slide ${cur + 1}), `)} title="Ask Atlas AI about this presentation"><LuSparkles /> Atlas AI</button>
        </>}
        backstage={[
          { id: "info", label: "Info", icon: <LuInfo />, content: <BackstageSection title="Info">
            <dl className="rb-bs-facts"><dt>Name</dt><dd>{deck.title}</dd><dt>Location</dt><dd>{grantLabel} / {docRef.path}</dd>
              <dt>Slides</dt><dd>{deck.slides.length}</dd><dt>Theme</dt><dd>{theme.name}</dd><dt>Status</dt><dd>{saveLabel}</dd></dl>
          </BackstageSection> },
          { id: "export", label: "Export", icon: <LuDownload />, content: <BackstageSection title="Export">
            <div className="rb-bs-tiles">
              <button className="rb-bs-tile" disabled={exporting} onClick={exportPptx}>{exporting ? <Spinner size={20} /> : <LuPresentation />}<strong>PowerPoint</strong><span>.pptx, saved next to this file in {grantLabel}. Keeps text, layout, theme colours and notes.</span></button>
              <button className="rb-bs-tile" onClick={exportOutline}><LuFileDown /><strong>Outline</strong><span>.txt download of slide titles, text and notes</span></button>
            </div>
          </BackstageSection> },
          { id: "close", label: "Close", icon: <LuX />, onSelect: close },
        ]} />

      {externalChange && <div className="banner banner-info w-banner">Atlas AI changed this presentation while you were editing.
        <Button size="sm" icon={<LuRefreshCw />} onClick={() => load()}>Load its version</Button></div>}

      {view === "sorter" ? <div className="sl-sorter" ref={stageRef}>
        <ol className="sl-sorter-grid" aria-label="Slides">
          {deck.slides.map((s, i) => <li key={s.id} className={`sl-sorter-item ${i === cur ? "is-current" : ""} ${dropAt === i ? "drop-before" : ""} ${dropAt === i + 1 && i === deck.slides.length - 1 ? "drop-after" : ""}`} {...dropHandlers(i)}>
            <button onClick={() => setCur(i)} onDoubleClick={() => { setCur(i); setView("normal"); }} aria-current={i === cur ? "true" : undefined} aria-label={`Slide ${i + 1}${slideTitle(s) ? ": " + slideTitle(s) : ""}`}>
              <SlideView slide={s} theme={theme} width={240} /></button>
            <span className="sl-sorter-num">{i + 1}</span>
          </li>)}
        </ol>
      </div> : <div className="sl-body">
        <ol className="sl-panel" ref={panelRef} tabIndex={0} aria-label="Slides" onKeyDown={onPanelKey} aria-activedescendant={`sl-thumb-${cur}`}>
          {deck.slides.map((s, i) => <li key={s.id} id={`sl-thumb-${i}`} data-index={i} className={`sl-thumb ${i === cur ? "is-current" : ""} ${dropAt === i ? "drop-before" : ""} ${dropAt === i + 1 && i === deck.slides.length - 1 ? "drop-after" : ""}`}
            {...dropHandlers(i)} onClick={() => selectSlide(i)} aria-selected={i === cur} aria-label={`Slide ${i + 1}${slideTitle(s) ? ": " + slideTitle(s) : ""}`} role="option">
            <span className="sl-thumb-num">{i + 1}</span>
            <SlideView slide={s} theme={theme} width={thumbW} />
          </li>)}
          <li className="sl-panel-add"><button onClick={() => addSlide("title-content", deck.slides.length)}><LuPlus /> New slide</button></li>
        </ol>

        <div className="sl-main">
          <div className="sl-stage" ref={stageRef} onPointerDown={() => { setSelEl(null); setEditing(null); }}>
            <div className="sl-canvas-wrap" style={{ width: SLIDE_W * scale, height: SLIDE_H * scale }}>
              <div ref={canvasRef} className="sl-canvas" tabIndex={0} onKeyDown={onCanvasKey} aria-label={`Slide ${cur + 1} canvas`}
                style={{ width: SLIDE_W, height: SLIDE_H, transform: `scale(${scale})`, background: theme.bg, color: theme.fg }}
                onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
                {slide.layout === "section" && <div className="sl-section-bar" style={{ background: theme.accent }} />}
                {slide.elements.map((el) => {
                  const selected = el.id === selEl, isEditing = el.id === editing;
                  const style = elementStyle(el, theme);
                  return <div key={el.id} className={`sl-el ${selected ? "is-selected" : ""} ${isEditing ? "is-editing" : ""}`} style={{ ...style, overflow: "visible" }}
                    onPointerDown={(e) => onPointerDown(e, el, "move")} onDoubleClick={() => startEditing(el.id)}>
                    {isEditing
                      ? <textarea className="sl-el-input" autoFocus value={el.text} placeholder={el.role === "text" ? "Text" : undefined} aria-label={`${el.role} text`}
                          style={{ font: "inherit", color: "inherit", textAlign: style.textAlign, lineHeight: style.lineHeight, textDecoration: style.textDecoration }}
                          onChange={(e) => typeText(el.id, e.target.value)} onPointerDown={(e) => e.stopPropagation()}
                          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); stopEditing(); } if (e.key === "Tab" && el.bullets) { e.preventDefault(); const t = e.currentTarget; const at = t.value.lastIndexOf("\n", t.selectionStart - 1) + 1;
                            const v = e.shiftKey ? (t.value.slice(at).startsWith("\t") ? t.value.slice(0, at) + t.value.slice(at + 1) : t.value) : t.value.slice(0, at) + "\t" + t.value.slice(at);
                            typeText(el.id, v); } }}
                          onBlur={() => { setEditing((cur) => cur === el.id ? null : cur); editSnapshot.current = null; }} />
                      : <div className="sl-el-text"><ElementText e={el} theme={theme} placeholders /></div>}
                    {selected && !isEditing && (["nw", "ne", "sw", "se"] as const).map((h) => <span key={h} className={`sl-handle sl-h-${h}`} style={{ transform: `scale(${1 / scale})` }}
                      onPointerDown={(e) => onPointerDown(e, el, h)} aria-hidden="true" />)}
                  </div>;
                })}
              </div>
            </div>
          </div>
          {notesOpen && <div className="sl-notes">
            <label htmlFor="sl-notes-input" className="visually-hidden">Speaker notes for slide {cur + 1}</label>
            <textarea id="sl-notes-input" placeholder="Click to add speaker notes" value={slide.notes}
              onFocus={() => { editSnapshot.current = null; }}
              onChange={(e) => { const v = e.target.value; if (!editSnapshot.current) { editSnapshot.current = latest.current; setSlide((s) => ({ ...s, notes: v })); } else setSlide((s) => ({ ...s, notes: v }), false); }}
              onBlur={() => { editSnapshot.current = null; }} />
          </div>}
        </div>
      </div>}

      <footer className="doc-statusbar">
        <span>Slide {cur + 1} of {deck.slides.length}</span>
        <span>{theme.name}</span>
        {element && <span>{element.role === "text" ? "Text box" : element.role[0].toUpperCase() + element.role.slice(1)} · {element.w} × {element.h}</span>}
        <span className="grow" />
        {view === "normal" && <>
          <button className="link" onClick={() => moveSlide(cur, cur - 1)} disabled={cur === 0} title="Move slide up (Alt ↑ in the slide panel)"><LuArrowUp /> Move up</button>
          <button className="link" onClick={() => moveSlide(cur, cur + 1)} disabled={cur === deck.slides.length - 1} title="Move slide down (Alt ↓ in the slide panel)"><LuArrowDown /> Move down</button>
        </>}
        <button className="link" onClick={() => setNotesOpen((o) => !o)} aria-pressed={notesOpen}><LuNotebookText /> Notes</button>
        <Zoom value={zoom} onChange={setZoom} min={30} max={200} />
      </footer>
    </div>
  );
}
