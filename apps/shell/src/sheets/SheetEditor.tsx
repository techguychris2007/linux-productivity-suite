// Atlas Sheets editor: ribbon, formula bar, keyboard-driven grid with range selection, clipboard,
// undo/redo, cell formatting, AutoSum, sorting, find, charts and live updates from Atlas AI.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  LuSheet, LuUndo2, LuRedo2, LuSparkles, LuCheck, LuX, LuBold, LuItalic, LuUnderline, LuAlignLeft, LuAlignCenter, LuAlignRight,
  LuSigma, LuEraser, LuClipboardPaste, LuCopy, LuScissors, LuChartColumn, LuChartBar, LuChartLine, LuChartPie, LuTrash2,
  LuArrowDownAZ, LuArrowUpZA, LuInfo, LuDownload, LuGrid3X3, LuPanelTop, LuZoomIn, LuZoomOut, LuSearch, LuPercent,
  LuDollarSign, LuHash, LuCalendar, LuRefreshCw, LuFileSpreadsheet, LuFileDown, LuSquareFunction,
  LuBetweenHorizontalStart, LuBetweenVerticalStart, LuPaintBucket, LuBaseline, LuRows3, LuColumns3,
} from "react-icons/lu";
import type { EngineEvent } from "@atlas/shared-types";
import { Button, Spinner } from "@atlas/ui";
import { useAtlas, type DocRef } from "../context";
import { Ribbon, RBig, RSmall, RStack, RRow, BackstageSection, Zoom, type RibbonTab } from "../ribbon/Ribbon";
import {
  type AtlasSheet, type CellFormat, type ChartType, type NumFormat, type SheetChart, COLS, ROWS, CHART_TYPES, CURRENCIES,
  cellName, columnName, evaluateGrid, evaluateTyped, formatValue, isNumeric, normalizeSheet, rangeBounds, rangeName, shiftSheet, toCsv,
} from "./model";
import { FUNCTION_NAMES } from "./formula";
import { ChartView, chartData, CHART_LABELS } from "./charts";

const COL_W = 96, ROW_H = 24, HEAD_W = 44, HEAD_H = 24;
type Sel = { r: number; c: number; r2: number; c2: number };
type Bounds = [number, number, number, number];
type SaveState = "saved" | "dirty" | "saving" | "error";
const bounds = (s: Sel): Bounds => [Math.min(s.r, s.r2), Math.min(s.c, s.c2), Math.max(s.r, s.r2), Math.max(s.c, s.c2)];
const clampR = (r: number) => Math.max(0, Math.min(ROWS - 1, r));
const clampC = (c: number) => Math.max(0, Math.min(COLS - 1, c));
const download = (name: string, content: string, type: string) => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
};
const safeName = (s: string) => s.trim().replace(/[/\\]/g, "-").replace(/^\.+/, "") || "Untitled spreadsheet";
const CHART_ICONS: Record<ChartType, React.ReactNode> = { column: <LuChartColumn />, bar: <LuChartBar />, line: <LuChartLine />, pie: <LuChartPie /> };

export function SheetEditor({ docRef, onClose }: { docRef: DocRef; onClose: () => void }) {
  const { bridge, notify, setActiveDoc, askAi, grants } = useAtlas();
  const grantLabel = grants.find((g) => g.id === docRef.grant)?.label ?? "";
  const [sheet, setSheet] = useState<AtlasSheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>("saved");
  const [sel, setSel] = useState<Sel>({ r: 0, c: 0, r2: 0, c2: 0 });
  const [edit, setEdit] = useState<{ value: string; via: "cell" | "bar" } | null>(null);
  const [zoom, setZoom] = useState(100);
  const [gridlines, setGridlines] = useState(true);
  const [freeze, setFreeze] = useState(false);
  const [chartSel, setChartSel] = useState<string | null>(null);
  const [tab, setTab] = useState("home");
  const [find, setFind] = useState("");
  const [nameBox, setNameBox] = useState<string | null>(null);
  const [externalChange, setExternalChange] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const latest = useRef<AtlasSheet | null>(null);
  latest.current = sheet;
  const past = useRef<AtlasSheet[]>([]);
  const future = useRef<AtlasSheet[]>([]);
  const saveTimer = useRef<number>(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const cellInput = useRef<HTMLInputElement>(null);
  const dragging = useRef(false);
  const clip = useRef<{ text: string; cells: string[][]; formats: (CellFormat | undefined)[][] } | null>(null);
  const mounted = useRef(Date.now() / 1000);

  // ---------- load / save ----------
  const load = useCallback(async () => {
    try {
      const r = await bridge.core<{ content: string }>("fs.read_text", { grant: docRef.grant, path: docRef.path, max_bytes: 2_000_000 });
      const s = normalizeSheet(JSON.parse(r.content), docRef.path.split("/").pop());
      latest.current = s; setSheet(s); setSave("saved"); setError(null); setExternalChange(false);
    } catch (e: any) { setError(e.message); }
  }, [bridge, docRef]);
  useEffect(() => { load(); past.current = []; future.current = []; }, [load]);
  useEffect(() => { if (sheet) setActiveDoc({ ...docRef, app: "sheets", title: sheet.title }); return () => setActiveDoc(null); }, [docRef, sheet?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  const persist = useCallback(async () => {
    const s = latest.current; if (!s) return;
    window.clearTimeout(saveTimer.current); setSave("saving");
    try {
      await bridge.core("fs.write_text", { grant: docRef.grant, path: docRef.path, content: JSON.stringify(s, null, 1), overwrite: true, backup: false });
      setSave((st) => latest.current === s ? "saved" : st === "saving" ? "dirty" : st);
    } catch (e: any) { setSave("error"); notify({ tone: "danger", title: "Couldn't save the spreadsheet", body: e.message }); }
  }, [bridge, docRef, notify]);

  const saveRef = useRef(save); saveRef.current = save;
  useEffect(() => bridge.subscribe(0, (ev: EngineEvent) => {
    if (ev.type !== "resource.changed" || ev.ts < mounted.current) return;
    if (ev.data.grant !== docRef.grant || ev.data.path !== docRef.path) return;
    if (saveRef.current === "saved") { load(); notify({ tone: "info", title: "Atlas AI updated this spreadsheet" }); } else setExternalChange(true);
  }, () => {}), [bridge, docRef, load, notify]);
  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  const apply = useCallback((fn: (s: AtlasSheet) => AtlasSheet) => {
    const s = latest.current; if (!s) return;
    past.current.push(s); if (past.current.length > 150) past.current.shift(); future.current = [];
    const next = fn(s); latest.current = next; setSheet(next); setSave("dirty");
    window.clearTimeout(saveTimer.current); saveTimer.current = window.setTimeout(persist, 700);
  }, [persist]);
  const jump = (to: AtlasSheet | undefined, from: AtlasSheet[]) => {
    const cur = latest.current; if (!to || !cur) return;
    from.push(cur); latest.current = to; setSheet(to); setSave("dirty");
    window.clearTimeout(saveTimer.current); saveTimer.current = window.setTimeout(persist, 700);
  };
  const undo = () => jump(past.current.pop(), future.current);
  const redo = () => jump(future.current.pop(), past.current);

  // ---------- derived ----------
  const values = useMemo(() => sheet ? evaluateGrid(sheet.cells) : [], [sheet]);
  const typed = useMemo(() => sheet ? evaluateTyped(sheet.cells) : [], [sheet]);
  const [t, l, b, rt] = bounds(sel);
  const active = sheet?.cells[sel.r][sel.c] ?? "";
  const fmtAt = (r: number, c: number): CellFormat | undefined => sheet?.formats?.[cellName(r, c)];
  const activeFmt = fmtAt(sel.r, sel.c) ?? {};
  const stats = useMemo(() => {
    if (!sheet || (t === b && l === rt)) return null;
    let sum = 0, n = 0, count = 0;
    for (let r = t; r <= b; r++) for (let c = l; c <= rt; c++) {
      const v = typed[r][c];
      if (v !== null && v !== "") count++;
      if (typeof v === "number") { sum += v; n++; }
    }
    return { sum, n, count, avg: n ? sum / n : 0 };
  }, [sheet, typed, t, l, b, rt]);

  // ---------- editing ----------
  const setCells = (writes: [number, number, string][]) => apply((s) => {
    const cells = s.cells.map((row) => [...row]);
    for (const [r, c, v] of writes) if (r < ROWS && c < COLS) cells[r][c] = v;
    return { ...s, cells };
  });
  const tabOrigin = useRef<number | null>(null);
  const move = (dr: number, dc: number, extend = false, key?: "tab" | "enter") => {
    // Enter after a run of Tabs returns to the column where the run started.
    if (key === "tab") { if (tabOrigin.current === null) tabOrigin.current = sel.c; }
    else if (key === "enter" && tabOrigin.current !== null && dr === 1) { const c0 = tabOrigin.current; tabOrigin.current = null; setSel((s) => ({ r: clampR(s.r + 1), c: c0, r2: clampR(s.r + 1), c2: c0 })); setChartSel(null); return; }
    else tabOrigin.current = null;
    setSel((s) => extend ? { ...s, r2: clampR(s.r2 + dr), c2: clampC(s.c2 + dc) } : { r: clampR(s.r + dr), c: clampC(s.c + dc), r2: clampR(s.r + dr), c2: clampC(s.c + dc) });
    setChartSel(null);
  };
  const startEdit = (value: string, via: "cell" | "bar" = "cell") => { setEdit({ value, via }); };
  // Focus the in-cell editor as soon as it renders, caret at the end.
  useLayoutEffect(() => {
    const el = cellInput.current;
    if (edit?.via === "cell" && el && document.activeElement !== el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }, [edit?.via, sel.r, sel.c, !!edit]); // eslint-disable-line react-hooks/exhaustive-deps
  const closing = useRef(false);
  /** Move focus back to the grid without the in-cell editor's blur committing a second time. */
  const focusGrid = () => { closing.current = true; gridRef.current?.focus(); closing.current = false; };
  const commit = (dr = 0, dc = 0, key?: "tab" | "enter") => {
    const e = edit;
    if (e) { focusGrid(); if (e.value !== active) setCells([[sel.r, sel.c, e.value]]); setEdit(null); }
    if (dr || dc) move(dr, dc, false, key);
  };
  const cancel = () => { focusGrid(); setEdit(null); };
  const clearRange = (what: "contents" | "formats" | "all" = "contents") => apply((s) => {
    const cells = s.cells.map((row) => [...row]); const formats = { ...(s.formats ?? {}) };
    for (let r = t; r <= b; r++) for (let c = l; c <= rt; c++) {
      if (what !== "formats") cells[r][c] = "";
      if (what !== "contents") delete formats[cellName(r, c)];
    }
    return { ...s, cells, formats };
  });
  const formatRange = (patch: (f: CellFormat) => CellFormat) => apply((s) => {
    const formats = { ...(s.formats ?? {}) };
    for (let r = t; r <= b; r++) for (let c = l; c <= rt; c++) {
      const key = cellName(r, c); const next = patch({ ...(formats[key] ?? {}) });
      for (const k of Object.keys(next) as (keyof CellFormat)[]) if (next[k] === undefined || next[k] === false) delete next[k];
      if (Object.keys(next).length) formats[key] = next; else delete formats[key];
    }
    return { ...s, formats };
  });
  const toggle = (k: "b" | "i" | "u") => { const on = !activeFmt[k]; formatRange((f) => ({ ...f, [k]: on })); };
  const setNum = (num: NumFormat) => formatRange((f) => ({ ...f, num: num === "general" ? undefined : num, ...(num === "currency" && !f.cur ? { cur: defaultCurrency() } : {}) }));
  const decimals = (d: number) => formatRange((f) => ({ ...f, num: f.num ?? "number", dp: Math.max(0, Math.min(6, (f.dp ?? (f.num === "percent" ? 0 : 2)) + d)) }));

  const structure = (axis: "row" | "col", insert: boolean) => {
    const at = axis === "row" ? t : l;
    const n = axis === "row" ? b - t + 1 : rt - l + 1;
    const full = axis === "row" ? n === ROWS : n === COLS;
    if (full && !insert) { notify({ tone: "warning", title: `A sheet needs at least one ${axis === "row" ? "row" : "column"}` }); return; }
    const res = shiftSheet(latest.current!, axis, at, insert ? n : -n);
    if (typeof res === "string") { notify({ tone: "warning", title: "Can't insert", body: res }); return; }
    apply(() => res);
    const label = axis === "row" ? `${n} row${n === 1 ? "" : "s"}` : `${n} column${n === 1 ? "" : "s"}`;
    notify({ tone: "info", title: `${insert ? "Inserted" : "Deleted"} ${label}`, body: "Formula references were updated." });
  };
  const colourInput = (key: "color" | "fill", label: string, icon: React.ReactNode, fallback: string) => (
    <label className="rb-small rb-colour" title={label}>
      {icon}<span className="rb-colour-bar" style={{ background: activeFmt[key] ?? fallback }} />
      <input type="color" aria-label={label} value={activeFmt[key] ?? (key === "fill" ? "#ffff00" : "#c00000")} onChange={(e) => formatRange((f) => ({ ...f, [key]: e.target.value }))} />
    </label>
  );

  const autoSum = (fn = "SUM") => {
    if (!sheet) return;
    if (t !== b || l !== rt) {
      // Range selected: put a total under each column of the selection.
      const row = Math.min(ROWS - 1, b + 1);
      setCells(Array.from({ length: rt - l + 1 }, (_, i) => [row, l + i, `=${fn}(${cellName(t, l + i)}:${cellName(b, l + i)})`] as [number, number, string]));
      setSel({ r: row, c: l, r2: row, c2: rt });
      return;
    }
    const numAt = (r: number, c: number) => r >= 0 && c >= 0 && typeof typed[r][c] === "number";
    let r0 = sel.r - 1; while (numAt(r0, sel.c)) r0--;
    if (r0 < sel.r - 1) { startEdit(`=${fn}(${cellName(r0 + 1, sel.c)}:${cellName(sel.r - 1, sel.c)})`); return; }
    let c0 = sel.c - 1; while (numAt(sel.r, c0)) c0--;
    if (c0 < sel.c - 1) { startEdit(`=${fn}(${cellName(sel.r, c0 + 1)}:${cellName(sel.r, sel.c - 1)})`); return; }
    startEdit(`=${fn}()`);
  };
  const insertFunction = (fn: string) => startEdit(edit?.value.startsWith("=") ? `${edit.value}${fn}(` : `=${fn}(`);

  const sortRange = (asc: boolean) => {
    if (!sheet) return;
    let top = t, bottom = b, left = l, right = rt;
    if (t === b) { // single row/cell: sort the whole used block, keeping a text header row in place
      bottom = sheet.cells.reduce((n, row, i) => row.some((v) => v !== "") ? i : n, 0);
      left = 0; right = sheet.cells.reduce((n, row) => Math.max(n, row.reduce((m, v, j) => v !== "" ? j : m, 0)), 0);
      top = 0;
      const header = sheet.cells[0].slice(left, right + 1).every((v) => v === "" || !isNumeric(v)) && sheet.cells.slice(1, bottom + 1).some((row) => row.some(isNumeric));
      if (header) top = 1;
    }
    if (bottom <= top) return;
    const key = sel.c;
    apply((s) => {
      const rows = Array.from({ length: bottom - top + 1 }, (_, i) => ({ i, cells: s.cells[top + i].slice(left, right + 1), v: typed[top + i][key] }));
      rows.sort((x, y) => {
        const a = x.v, z = y.v;
        if (a === null || a === "") return 1; if (z === null || z === "") return -1;
        const cmp = typeof a === "number" && typeof z === "number" ? a - z : String(a).localeCompare(String(z), undefined, { numeric: true, sensitivity: "base" });
        return asc ? cmp : -cmp;
      });
      const cells = s.cells.map((row) => [...row]);
      rows.forEach((row, i) => row.cells.forEach((v, j) => { cells[top + i][left + j] = v; }));
      return { ...s, cells };
    });
    notify({ tone: "info", title: `Sorted ${rangeName(top, left, bottom, right)} by column ${columnName(key)}`, body: "Formulas move with their rows; references inside them are not adjusted." });
  };

  const findNext = () => {
    if (!sheet || !find) return;
    const q = find.toLowerCase();
    for (let k = 1; k <= ROWS * COLS; k++) {
      const idx = (sel.r * COLS + sel.c + k) % (ROWS * COLS);
      const r = Math.floor(idx / COLS), c = idx % COLS;
      if (values[r][c].toLowerCase().includes(q) || sheet.cells[r][c].toLowerCase().includes(q)) { setSel({ r, c, r2: r, c2: c }); scrollTo(r, c); return; }
    }
    notify({ tone: "info", title: `No cells contain "${find}"` });
  };
  const scrollTo = (r: number, c: number) => {
    const el = gridRef.current; if (!el) return;
    const z = zoom / 100, x = (HEAD_W + c * COL_W) * z, y = (HEAD_H + r * ROW_H) * z;
    if (x < el.scrollLeft + HEAD_W * z || x + COL_W * z > el.scrollLeft + el.clientWidth) el.scrollLeft = x - el.clientWidth / 3;
    if (y < el.scrollTop + HEAD_H * z || y + ROW_H * z > el.scrollTop + el.clientHeight) el.scrollTop = y - el.clientHeight / 3;
  };
  useEffect(() => { scrollTo(sel.r2, sel.c2); }, [sel.r2, sel.c2]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- clipboard ----------
  const copyText = () => {
    if (!sheet) return "";
    const cells: string[][] = [], formats: (CellFormat | undefined)[][] = [];
    for (let r = t; r <= b; r++) { cells.push(sheet.cells[r].slice(l, rt + 1)); formats.push(Array.from({ length: rt - l + 1 }, (_, j) => fmtAt(r, l + j))); }
    const text = Array.from({ length: b - t + 1 }, (_, i) => values[t + i].slice(l, rt + 1).join("\t")).join("\n");
    clip.current = { text, cells, formats };
    return text;
  };
  const pasteText = (text: string) => {
    if (!sheet) return;
    const internal = clip.current && clip.current.text === text.replace(/\r\n/g, "\n").replace(/\n$/, "") ? clip.current : null;
    const rows = internal ? internal.cells : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").map((line) => line.split("\t"));
    apply((s) => {
      const cells = s.cells.map((row) => [...row]); const formats = { ...(s.formats ?? {}) };
      rows.forEach((row, i) => row.forEach((v, j) => {
        const r = sel.r + i, c = sel.c + j; if (r >= ROWS || c >= COLS) return;
        cells[r][c] = v;
        if (internal) { const f = internal.formats[i][j]; if (f) formats[cellName(r, c)] = f; else delete formats[cellName(r, c)]; }
      }));
      return { ...s, cells, formats };
    });
    setSel({ r: sel.r, c: sel.c, r2: clampR(sel.r + rows.length - 1), c2: clampC(sel.c + Math.max(...rows.map((x) => x.length)) - 1) });
  };
  const cutPending = useRef(false);
  const ribbonCopy = async (cut = false) => {
    const text = copyText();
    try { await navigator.clipboard.writeText(text); } catch { /* internal clipboard still works */ }
    if (cut) clearRange("all");
    notify({ tone: "info", title: `${cut ? "Cut" : "Copied"} ${rangeName(t, l, b, rt)}` });
  };
  const ribbonPaste = async () => {
    let text = clip.current?.text ?? "";
    try { text = await navigator.clipboard.readText(); } catch { /* fall back to Atlas's own clipboard */ }
    if (text) pasteText(text); else notify({ tone: "info", title: "Nothing to paste yet", body: "Copy some cells first, or press Ctrl V." });
  };

  // ---------- charts ----------
  const addChart = (type: ChartType) => {
    if (!sheet) return;
    let range = rangeName(t, l, b, rt);
    if (t === b && l === rt) { // single cell: chart the used block around it
      const bottom = sheet.cells.reduce((n, row, i) => row.some((v) => v !== "") ? i : n, 0);
      const right = sheet.cells.reduce((n, row) => Math.max(n, row.reduce((m, v, j) => v !== "" ? j : m, 0)), 0);
      range = rangeName(0, 0, bottom, right);
    }
    if (!chartData(values, range)) { notify({ tone: "warning", title: "Select numbers to chart", body: "Select a range with labels in the first column and numbers beside them." }); return; }
    const [, , , right] = rangeBounds(range)!;
    const id = `chart${Date.now().toString(36)}`;
    const ch: SheetChart = { id, type, range, title: sheet.cells[t]?.[l + 1] && !isNumeric(sheet.cells[t][l + 1]) ? sheet.cells[t][l + 1] : "Chart", x: HEAD_W + Math.min(right + 2, COLS - 5) * COL_W, y: HEAD_H + t * ROW_H, w: 440, h: 280 };
    apply((s) => ({ ...s, charts: [...(s.charts ?? []), ch] }));
    setChartSel(id); setTab("chart");
  };
  const updateChart = (id: string, patch: Partial<SheetChart>, snapshot = true) => {
    if (snapshot) apply((s) => ({ ...s, charts: (s.charts ?? []).map((c) => c.id === id ? { ...c, ...patch } : c) }));
    else setSheet((s) => s && { ...s, charts: (s.charts ?? []).map((c) => c.id === id ? { ...c, ...patch } : c) });
  };
  const removeChart = (id: string) => { apply((s) => ({ ...s, charts: (s.charts ?? []).filter((c) => c.id !== id) })); setChartSel(null); setTab("home"); };
  const selectedChart = sheet?.charts?.find((c) => c.id === chartSel) ?? null;

  const dragChart = (e: React.PointerEvent, ch: SheetChart, mode: "move" | "resize") => {
    e.preventDefault(); e.stopPropagation(); setChartSel(ch.id);
    const start = { x: e.clientX, y: e.clientY }, z = zoom / 100, orig = { ...ch };
    const before = latest.current;
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / z, dy = (ev.clientY - start.y) / z;
      updateChart(ch.id, mode === "move" ? { x: Math.max(0, Math.round(orig.x + dx)), y: Math.max(0, Math.round(orig.y + dy)) } : { w: Math.max(240, Math.round(orig.w + dx)), h: Math.max(180, Math.round(orig.h + dy)) }, false);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
      if (before && latest.current !== before) { past.current.push(before); future.current = []; setSave("dirty"); window.clearTimeout(saveTimer.current); saveTimer.current = window.setTimeout(persist, 700); }
    };
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
  };

  // ---------- keyboard ----------
  const onGridKey = (e: React.KeyboardEvent) => {
    if (edit) {
      // Keys typed before the in-cell editor took focus still belong to it.
      if (e.target === cellInput.current || (e.target as HTMLElement).id === "sheet-fx-input") return;
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); setEdit((x) => x && { ...x, value: x.value + e.key }); }
      else if (["Enter", "Tab", "Escape"].includes(e.key)) onCellKey(e);
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (mod && k.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && k.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
    if (mod && k.toLowerCase() === "b") { e.preventDefault(); toggle("b"); return; }
    if (mod && k.toLowerCase() === "i") { e.preventDefault(); toggle("i"); return; }
    if (mod && k.toLowerCase() === "u") { e.preventDefault(); toggle("u"); return; }
    if (mod && k.toLowerCase() === "a") { e.preventDefault(); setSel({ r: 0, c: 0, r2: ROWS - 1, c2: COLS - 1 }); return; }
    if (mod && k === "Home") { e.preventDefault(); setSel({ r: 0, c: 0, r2: 0, c2: 0 }); return; }
    if (e.altKey && k === "=") { e.preventDefault(); autoSum(); return; }
    if (mod) return;
    if (chartSel && (k === "Delete" || k === "Backspace")) { e.preventDefault(); removeChart(chartSel); return; }
    const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[k]) { e.preventDefault(); move(...arrows[k], e.shiftKey); return; }
    if (k === "Enter") { e.preventDefault(); move(e.shiftKey ? -1 : 1, 0, false, "enter"); return; }
    if (k === "Tab") { e.preventDefault(); move(0, e.shiftKey ? -1 : 1, false, "tab"); return; }
    if (k === "Home") { e.preventDefault(); setSel({ r: sel.r, c: 0, r2: sel.r, c2: 0 }); return; }
    if (k === "PageDown" || k === "PageUp") { e.preventDefault(); move(k === "PageDown" ? 20 : -20, 0, e.shiftKey); return; }
    if (k === "Delete" || k === "Backspace") { e.preventDefault(); clearRange(); return; }
    if (k === "F2") { e.preventDefault(); startEdit(active); return; }
    if (k === "Escape") { setChartSel(null); return; }
    if (k.length === 1 && !e.altKey) { e.preventDefault(); startEdit(k); }
  };
  const onCellKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); commit(e.shiftKey ? -1 : 1, 0, "enter"); }
    else if (e.key === "Tab") { e.preventDefault(); commit(0, e.shiftKey ? -1 : 1, "tab"); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    else if (edit?.via === "cell" && !edit.value.startsWith("=") && ["ArrowUp", "ArrowDown"].includes(e.key)) { e.preventDefault(); commit(e.key === "ArrowUp" ? -1 : 1, 0); }
  };

  // ---------- mouse ----------
  const onCellDown = (e: React.MouseEvent, r: number, c: number) => {
    if (e.button !== 0) return;
    if (edit && edit.value.startsWith("=") && !(r === sel.r && c === sel.c)) {
      // Formula mode: clicking a cell inserts its reference.
      e.preventDefault();
      setEdit({ ...edit, value: edit.value + cellName(r, c) });
      (edit.via === "cell" ? cellInput.current : document.getElementById("sheet-fx-input") as HTMLInputElement | null)?.focus();
      return;
    }
    if (edit) commit();
    setChartSel(null); tabOrigin.current = null;
    if (e.shiftKey) setSel((s) => ({ ...s, r2: r, c2: c })); else setSel({ r, c, r2: r, c2: c });
    dragging.current = true;
    gridRef.current?.focus();
  };
  useEffect(() => { const up = () => { dragging.current = false; }; window.addEventListener("mouseup", up); return () => window.removeEventListener("mouseup", up); }, []);

  // ---------- ribbon ----------
  const close = async () => { if (edit) commit(); await persist(); onClose(); };
  const exportFile = async (fmt: "xlsx" | "csv") => {
    if (!sheet) return;
    if (fmt === "csv") { download(`${safeName(sheet.title)}.csv`, toCsv(values), "text/csv;charset=utf-8"); return; }
    setExporting(fmt);
    try {
      await persist();
      const r = await bridge.engine<{ path: string }>("POST", "/sheets/export", { grant: docRef.grant, path: docRef.path });
      notify({ tone: "success", title: `Exported ${r.path}`, body: `Saved in ${grantLabel}` });
    } catch (e: any) { notify({ tone: "danger", title: "Export failed", body: e.message }); }
    finally { setExporting(null); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (edit) commit(); persist(); } };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  });

  if (error) return <div className="page"><div className="banner banner-danger">{error}</div><Button onClick={onClose}>Back to spreadsheets</Button></div>;
  if (!sheet) return <div className="page muted"><Spinner /> Opening…</div>;

  const saveLabel = save === "saved" ? <><LuCheck /> Saved to {grantLabel}</> : save === "saving" ? "Saving…" : save === "dirty" ? "Unsaved changes" : "Not saved";
  const numFormat: NumFormat = activeFmt.num ?? "general";
  const tabs: RibbonTab[] = [
    { id: "home", label: "Home", groups: [
      { label: "Clipboard", content: <><RBig icon={<LuClipboardPaste />} label="Paste" onClick={ribbonPaste} />
        <RStack><RSmall icon={<LuScissors />} label="Cut" showLabel onClick={() => ribbonCopy(true)} /><RSmall icon={<LuCopy />} label="Copy" showLabel onClick={() => ribbonCopy()} /></RStack></> },
      { label: "Font", content: <RRow>
        <RSmall icon={<LuBold />} label="Bold (Ctrl B)" active={!!activeFmt.b} onClick={() => toggle("b")} />
        <RSmall icon={<LuItalic />} label="Italic (Ctrl I)" active={!!activeFmt.i} onClick={() => toggle("i")} />
        <RSmall icon={<LuUnderline />} label="Underline (Ctrl U)" active={!!activeFmt.u} onClick={() => toggle("u")} />
        {colourInput("color", "Font colour", <LuBaseline />, "transparent")}
        {colourInput("fill", "Fill colour", <LuPaintBucket />, "transparent")}
        <RSmall icon={<LuEraser />} label="Remove colours" onClick={() => formatRange((f) => ({ ...f, color: undefined, fill: undefined }))} />
      </RRow> },
      { label: "Alignment", content: <RRow>
        <RSmall icon={<LuAlignLeft />} label="Align left" active={activeFmt.align === "left"} onClick={() => formatRange((f) => ({ ...f, align: f.align === "left" ? undefined : "left" }))} />
        <RSmall icon={<LuAlignCenter />} label="Centre" active={activeFmt.align === "center"} onClick={() => formatRange((f) => ({ ...f, align: f.align === "center" ? undefined : "center" }))} />
        <RSmall icon={<LuAlignRight />} label="Align right" active={activeFmt.align === "right"} onClick={() => formatRange((f) => ({ ...f, align: f.align === "right" ? undefined : "right" }))} />
      </RRow> },
      { label: "Number", content: <RStack>
        <RRow>
          <select aria-label="Number format" value={numFormat} onChange={(e) => setNum(e.target.value as NumFormat)}>
            <option value="general">General</option><option value="number">Number</option><option value="currency">Currency</option><option value="percent">Percentage</option><option value="date">Date</option>
          </select>
          {numFormat === "currency" && <select aria-label="Currency" value={activeFmt.cur ?? "USD"} onChange={(e) => formatRange((f) => ({ ...f, cur: e.target.value }))}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>}
        </RRow>
        <RRow>
          <RSmall icon={<LuDollarSign />} label="Currency format" onClick={() => setNum("currency")} />
          <RSmall icon={<LuPercent />} label="Percent style" onClick={() => setNum("percent")} />
          <RSmall icon={<LuHash />} label="Number style (1,234.00)" onClick={() => setNum("number")} />
          <RSmall icon={<LuCalendar />} label="Date format" onClick={() => setNum("date")} />
          <button className="rb-small" title="Increase decimals" aria-label="Increase decimals" onClick={() => decimals(1)}>.0→.00</button>
          <button className="rb-small" title="Decrease decimals" aria-label="Decrease decimals" onClick={() => decimals(-1)}>.00→.0</button>
        </RRow>
      </RStack> },
      { label: "Cells", content: <RStack>
        <RRow><RSmall icon={<LuBetweenHorizontalStart />} label="Insert rows above" showLabel onClick={() => structure("row", true)} /><RSmall icon={<LuBetweenVerticalStart />} label="Insert columns left" showLabel onClick={() => structure("col", true)} /></RRow>
        <RRow><RSmall icon={<LuRows3 />} label="Delete rows" showLabel onClick={() => structure("row", false)} /><RSmall icon={<LuColumns3 />} label="Delete columns" showLabel onClick={() => structure("col", false)} /></RRow>
      </RStack> },
      { label: "Editing", content: <>
        <RBig icon={<LuSigma />} label="AutoSum" onClick={() => autoSum()} title="AutoSum (Alt =)" />
        <RStack>
          <RSmall icon={<LuArrowDownAZ />} label="Sort A to Z" showLabel onClick={() => sortRange(true)} />
          <RSmall icon={<LuArrowUpZA />} label="Sort Z to A" showLabel onClick={() => sortRange(false)} />
          <RSmall icon={<LuEraser />} label="Clear" showLabel onClick={() => clearRange("all")} />
        </RStack>
        <RStack>
          <RRow><input aria-label="Find in sheet" placeholder="Find" value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") findNext(); }} style={{ width: 110 }} />
            <RSmall icon={<LuSearch />} label="Find next" onClick={findNext} /></RRow>
        </RStack>
      </> },
    ] },
    { id: "insert", label: "Insert", groups: [
      { label: "Charts", content: <>{CHART_TYPES.map((ct) => <RBig key={ct} icon={CHART_ICONS[ct]} label={CHART_LABELS[ct]} onClick={() => addChart(ct)} title={`Insert a ${CHART_LABELS[ct].toLowerCase()} chart from the selection`} />)}</> },
      { label: "Functions", content: <RBig icon={<LuSquareFunction />} label="Function" onClick={() => setTab("formulas")} /> },
    ] },
    { id: "formulas", label: "Formulas", groups: [
      { label: "AutoSum", content: <><RBig icon={<LuSigma />} label="Sum" onClick={() => autoSum("SUM")} />
        <RStack><RSmall icon={<span className="rb-fn">x̄</span>} label="Average" showLabel onClick={() => autoSum("AVERAGE")} /><RSmall icon={<span className="rb-fn">#</span>} label="Count" showLabel onClick={() => autoSum("COUNT")} /></RStack>
        <RStack><RSmall icon={<span className="rb-fn">↑</span>} label="Max" showLabel onClick={() => autoSum("MAX")} /><RSmall icon={<span className="rb-fn">↓</span>} label="Min" showLabel onClick={() => autoSum("MIN")} /></RStack></> },
      { label: "Function library", content: <div className="rb-fnlib">
        {[["Logical", ["IF", "IFS", "IFERROR", "AND", "OR", "NOT", "SWITCH"]], ["Lookup", ["XLOOKUP", "VLOOKUP", "INDEX", "MATCH", "CHOOSE"]], ["Math", ["SUMIF", "SUMIFS", "ROUND", "SUMPRODUCT", "MOD", "ABS"]],
          ["Statistical", ["COUNTIF", "AVERAGEIF", "MEDIAN", "STDEV", "LARGE", "RANK"]], ["Text", ["CONCAT", "TEXTJOIN", "LEFT", "MID", "TEXT", "TRIM", "UPPER"]], ["Date", ["TODAY", "DATE", "YEAR", "EOMONTH", "DATEDIF", "NETWORKDAYS"]],
          ["Financial", ["PMT", "FV", "PV", "NPV", "IRR"]]].map(([cat, fns]) => (
          <select key={cat as string} aria-label={`${cat} functions`} value="" onChange={(e) => { if (e.target.value) insertFunction(e.target.value); }}>
            <option value="">{cat as string}</option>{(fns as string[]).map((f) => <option key={f}>{f}</option>)}
          </select>))}
        <select aria-label="All functions" value="" onChange={(e) => { if (e.target.value) insertFunction(e.target.value); }}>
          <option value="">All ({FUNCTION_NAMES.length})</option>{FUNCTION_NAMES.map((f) => <option key={f}>{f}</option>)}
        </select>
      </div> },
    ] },
    { id: "data", label: "Data", groups: [
      { label: "Sort", content: <><RBig icon={<LuArrowDownAZ />} label="Sort A to Z" onClick={() => sortRange(true)} /><RBig icon={<LuArrowUpZA />} label="Sort Z to A" onClick={() => sortRange(false)} /></> },
      { label: "Get data", content: <RBig icon={<LuRefreshCw />} label="Reload from disk" onClick={() => load()} /> },
    ] },
    { id: "view", label: "View", groups: [
      { label: "Show", content: <><RBig icon={<LuGrid3X3 />} label="Gridlines" active={gridlines} onClick={() => setGridlines(!gridlines)} />
        <RBig icon={<LuPanelTop />} label="Freeze top row" active={freeze} onClick={() => setFreeze(!freeze)} /></> },
      { label: "Zoom", content: <><RBig icon={<LuZoomOut />} label="Zoom out" onClick={() => setZoom((z) => Math.max(50, z - 10))} />
        <RBig icon={<LuSearch />} label="100%" onClick={() => setZoom(100)} /><RBig icon={<LuZoomIn />} label="Zoom in" onClick={() => setZoom((z) => Math.min(200, z + 10))} /></> },
      { label: "Atlas AI", content: <RBig icon={<LuSparkles />} label="Ask about this sheet" onClick={() => askAi(`In the open spreadsheet "${docRef.path}" (selection ${rangeName(t, l, b, rt)}), `)} /> },
    ] },
    ...(selectedChart ? [{ id: "chart", label: "Chart Design", contextual: true, groups: [
      { label: "Type", content: <>{CHART_TYPES.map((ct) => <RBig key={ct} icon={CHART_ICONS[ct]} label={CHART_LABELS[ct]} active={selectedChart.type === ct} onClick={() => updateChart(selectedChart.id, { type: ct })} />)}</> },
      { label: "Chart elements", content: <RStack>
        <RRow><label className="rb-field">Title <input value={selectedChart.title} onChange={(e) => updateChart(selectedChart.id, { title: e.target.value })} /></label></RRow>
        <RRow><label className="rb-field">Data <input defaultValue={selectedChart.range} key={selectedChart.range} onBlur={(e) => { if (rangeBounds(e.target.value)) updateChart(selectedChart.id, { range: e.target.value.toUpperCase() }); else e.target.value = selectedChart.range; }} /></label>
          <RSmall icon={<LuRefreshCw />} label="Use the current selection" onClick={() => updateChart(selectedChart.id, { range: rangeName(t, l, b, rt) })} /></RRow>
      </RStack> },
      { label: "Delete", content: <RBig icon={<LuTrash2 />} label="Delete chart" onClick={() => removeChart(selectedChart.id)} /> },
    ] } as RibbonTab] : []),
  ];

  const editingHere = (r: number, c: number) => edit?.via === "cell" && r === sel.r && c === sel.c;
  return (
    <div className="sheet-editor app-sheets" style={{ position: "relative" }}>
      <Ribbon appName="Sheets" appIcon={<LuSheet />} title={sheet.title} status={<span className={`w-save w-save-${save}`} aria-live="polite">{saveLabel}</span>}
        onBack={close} tabs={tabs} activeTab={tabs.some((x) => x.id === tab) ? tab : "home"} onTab={setTab}
        quick={<>
          <button onClick={undo} disabled={!past.current.length} aria-label="Undo" title="Undo (Ctrl Z)"><LuUndo2 /></button>
          <button onClick={redo} disabled={!future.current.length} aria-label="Redo" title="Redo (Ctrl Y)"><LuRedo2 /></button>
          <button onClick={() => askAi(`In the open spreadsheet "${docRef.path}" (selection ${rangeName(t, l, b, rt)}), `)} title="Ask Atlas AI about this sheet"><LuSparkles /> Atlas AI</button>
        </>}
        backstage={[
          { id: "info", label: "Info", icon: <LuInfo />, content: <BackstageSection title="Info">
            <dl className="rb-bs-facts"><dt>Name</dt><dd>{sheet.title}</dd><dt>Location</dt><dd>{grantLabel} / {docRef.path}</dd>
              <dt>Size</dt><dd>{ROWS} rows × {COLS} columns</dd><dt>Charts</dt><dd>{sheet.charts?.length ?? 0}</dd><dt>Status</dt><dd>{saveLabel}</dd></dl>
          </BackstageSection> },
          { id: "export", label: "Export", icon: <LuDownload />, content: <BackstageSection title="Export">
            <div className="rb-bs-tiles">
              <button className="rb-bs-tile" disabled={!!exporting} onClick={() => exportFile("xlsx")}>{exporting ? <Spinner size={20} /> : <LuFileSpreadsheet />}<strong>Excel workbook</strong><span>.xlsx, saved next to this file in {grantLabel}. Keeps formulas, formatting and charts.</span></button>
              <button className="rb-bs-tile" onClick={() => exportFile("csv")}><LuFileDown /><strong>CSV</strong><span>.csv download of the calculated values</span></button>
            </div>
          </BackstageSection> },
          { id: "close", label: "Close", icon: <LuX />, onSelect: close },
        ]} />

      {externalChange && <div className="banner banner-info w-banner">Atlas AI changed this spreadsheet while you were editing.
        <Button size="sm" icon={<LuRefreshCw />} onClick={() => load()}>Load its version</Button></div>}

      <div className="sheet-formula">
        <input className="sheet-namebox" aria-label="Name box" value={nameBox ?? rangeName(t, l, b, rt)} onFocus={() => setNameBox(rangeName(t, l, b, rt))}
          onChange={(e) => setNameBox(e.target.value)} onBlur={() => setNameBox(null)}
          onKeyDown={(e) => { if (e.key === "Enter") { const bb = rangeBounds(nameBox ?? ""); if (bb) { setSel({ r: bb[0], c: bb[1], r2: bb[2], c2: bb[3] }); } setNameBox(null); gridRef.current?.focus(); } if (e.key === "Escape") { setNameBox(null); gridRef.current?.focus(); } }} />
        <button className="sheet-fx-btn" aria-label="Cancel" title="Cancel (Esc)" disabled={!edit} onClick={cancel}><LuX /></button>
        <button className="sheet-fx-btn" aria-label="Enter" title="Enter" disabled={!edit} onClick={() => commit()}><LuCheck /></button>
        <button className="sheet-fx" title="Insert function" onClick={() => setTab("formulas")}>fx</button>
        <input id="sheet-fx-input" aria-label="Cell value or formula" value={edit ? edit.value : active} placeholder="Type a value or a formula such as =SUM(B2:B8)"
          onFocus={() => { if (!edit) setEdit({ value: active, via: "bar" }); }} onChange={(e) => setEdit({ value: e.target.value, via: edit?.via ?? "bar" })} onKeyDown={onCellKey} />
      </div>

      <div ref={gridRef} className={`sheet-grid-wrap ${gridlines ? "" : "no-gridlines"}`} tabIndex={0} onKeyDown={onGridKey} aria-label="Spreadsheet grid"
        onCopy={(e) => { if (edit) return; e.preventDefault(); e.clipboardData.setData("text/plain", copyText()); }}
        onCut={(e) => { if (edit) return; e.preventDefault(); e.clipboardData.setData("text/plain", copyText()); cutPending.current = true; clearRange("all"); }}
        onPaste={(e) => { if (edit) return; e.preventDefault(); pasteText(e.clipboardData.getData("text/plain")); }}>
        <div className="sg-canvas" style={{ zoom: zoom / 100 }}>
          <table className={`sg ${freeze ? "is-frozen" : ""}`} role="grid" aria-rowcount={ROWS} aria-colcount={COLS}>
            <colgroup><col style={{ width: HEAD_W }} />{Array.from({ length: COLS }, (_, c) => <col key={c} style={{ width: COL_W }} />)}</colgroup>
            <thead><tr>
              <th className="sg-corner" onMouseDown={() => setSel({ r: 0, c: 0, r2: ROWS - 1, c2: COLS - 1 })} title="Select all" />
              {Array.from({ length: COLS }, (_, c) => <th key={c} className={c >= l && c <= rt ? "is-hl" : ""} onMouseDown={(e) => { e.preventDefault(); setSel(e.shiftKey ? { ...sel, r: 0, r2: ROWS - 1, c2: c } : { r: 0, c, r2: ROWS - 1, c2: c }); gridRef.current?.focus(); }}>{columnName(c)}</th>)}
            </tr></thead>
            <tbody>{Array.from({ length: ROWS }, (_, r) => (
              <tr key={r} className={freeze && r === 0 ? "sg-frozen" : ""}>
                <th className={r >= t && r <= b ? "is-hl" : ""} onMouseDown={(e) => { e.preventDefault(); setSel(e.shiftKey ? { ...sel, c: 0, c2: COLS - 1, r2: r } : { r, c: 0, r2: r, c2: COLS - 1 }); gridRef.current?.focus(); }}>{r + 1}</th>
                {Array.from({ length: COLS }, (_, c) => {
                  const raw = sheet.cells[r][c];
                  const f = fmtAt(r, c);
                  const v = typed[r][c];
                  const inSel = r >= t && r <= b && c >= l && c <= rt;
                  const isActive = r === sel.r && c === sel.c;
                  const align = f?.align ?? (typeof v === "number" ? "right" : typeof v === "boolean" || (typeof v === "object" && v !== null) ? "center" : "left");
                  return (
                    <td key={c} role="gridcell" aria-selected={inSel}
                      className={`${inSel && !isActive ? "is-sel" : ""} ${isActive ? "is-active" : ""} ${raw.startsWith("#") || values[r][c].startsWith("#") && raw.startsWith("=") ? "is-error" : ""}`}
                      style={{ textAlign: align, fontWeight: f?.b ? 700 : undefined, fontStyle: f?.i ? "italic" : undefined, textDecoration: f?.u ? "underline" : undefined, color: f?.color, background: f?.fill }}
                      onMouseDown={(e) => onCellDown(e, r, c)} onMouseEnter={() => { if (dragging.current && !edit) setSel((s) => ({ ...s, r2: r, c2: c })); }}
                      onDoubleClick={() => startEdit(raw)} title={raw.startsWith("=") ? raw : undefined}>
                      {editingHere(r, c)
                        ? <input ref={cellInput} className="sg-input" value={edit!.value} onChange={(e) => setEdit({ value: e.target.value, via: "cell" })} onKeyDown={onCellKey} onBlur={() => { if (!closing.current && edit && !edit.value.startsWith("=")) commit(); }} aria-label={`Edit ${cellName(r, c)}`} />
                        : formatValue(values[r][c], f)}
                    </td>
                  );
                })}
              </tr>
            ))}</tbody>
          </table>
          {(sheet.charts ?? []).map((ch) => {
            const data = chartData(values, ch.range);
            return (
              <div key={ch.id} className={`sg-chart ${chartSel === ch.id ? "is-selected" : ""}`} style={{ left: ch.x, top: ch.y, width: ch.w, height: ch.h }}
                onMouseDown={(e) => { e.stopPropagation(); setChartSel(ch.id); setTab("chart"); gridRef.current?.focus(); }}>
                <div className="sg-chart-bar" onPointerDown={(e) => dragChart(e, ch, "move")} title="Drag to move">{ch.range}</div>
                {data ? <ChartView type={ch.type} data={data} width={ch.w - 2} height={ch.h - 22} title={ch.title} /> : <p className="muted pad">No numbers in {ch.range}.</p>}
                <div className="sg-chart-resize" onPointerDown={(e) => dragChart(e, ch, "resize")} title="Drag to resize" />
              </div>
            );
          })}
        </div>
      </div>

      <div className="sheet-tabs"><span className="sheet-tab is-active">{sheet.title.slice(0, 31) || "Sheet1"}</span></div>
      <footer className="doc-statusbar">
        <span>{edit ? "Edit" : "Ready"}</span>
        <span className="grow" />
        {stats && stats.n > 0 && <><span>Average: {formatValue(String(Number(stats.avg.toPrecision(10))), activeFmt)}</span><span>Count: {stats.count}</span><span>Sum: {formatValue(String(Number(stats.sum.toPrecision(12))), activeFmt)}</span></>}
        {stats && stats.n === 0 && stats.count > 0 && <span>Count: {stats.count}</span>}
        <Zoom value={zoom} onChange={setZoom} />
      </footer>
    </div>
  );
}

function defaultCurrency(): string {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    const map: Record<string, string> = { US: "USD", GB: "GBP", GH: "GHS", NG: "NGN", KE: "KES", ZA: "ZAR", IN: "INR", JP: "JPY", CN: "CNY", CA: "CAD", AU: "AUD" };
    return (region && map[region]) || (["DE", "FR", "ES", "IT", "NL", "IE", "PT", "BE", "AT", "FI"].includes(region ?? "") ? "EUR" : "USD");
  } catch { return "USD"; }
}

