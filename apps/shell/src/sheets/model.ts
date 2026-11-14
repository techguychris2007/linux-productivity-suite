import { display, ERRORS, evaluate, literal, serialToDate } from "./formula";
export type Grid = string[][];
export type NumFormat = "general" | "number" | "currency" | "percent" | "date";
export type CellAlign = "left" | "center" | "right";
export interface CellFormat { b?: boolean; i?: boolean; u?: boolean; align?: CellAlign; num?: NumFormat; cur?: string; dp?: number }
export type ChartType = "column" | "bar" | "line" | "pie";
/** A chart drawn from a range; position and size are in grid pixels at 100% zoom. */
export interface SheetChart { id: string; type: ChartType; range: string; title: string; x: number; y: number; w: number; h: number }
export interface AtlasSheet { format: "atlas.sheet"; version: 1; title: string; cells: Grid; formats?: Record<string, CellFormat>; charts?: SheetChart[] }

export const ROWS = 80;
export const COLS = 20;
export const columnName = (n: number) => {
  let out = "";
  for (let x = n + 1; x > 0; x = Math.floor((x - 1) / 26)) out = String.fromCharCode(65 + ((x - 1) % 26)) + out;
  return out;
};
export const cellName = (row: number, col: number) => `${columnName(col)}${row + 1}`;
export const cellIndex = (ref: string): [number, number] | null => {
  const m = /^([A-Z]+)([1-9]\d*)$/i.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64;
  return [Number(m[2]) - 1, col - 1];
};
export const emptyGrid = (): Grid => Array.from({ length: ROWS }, () => Array(COLS).fill(""));
export const newSheet = (title: string): AtlasSheet => ({ format: "atlas.sheet", version: 1, title, cells: emptyGrid() });
export function normalizeSheet(value: any, title = "Untitled spreadsheet"): AtlasSheet {
  if (!value || value.format !== "atlas.sheet" || !Array.isArray(value.cells)) throw new Error("This is not an Atlas spreadsheet.");
  const cells = emptyGrid();
  value.cells.slice(0, ROWS).forEach((row: unknown, r: number) => {
    if (Array.isArray(row)) row.slice(0, COLS).forEach((cell, c) => { cells[r][c] = String(cell ?? ""); });
  });
  const formats: Record<string, CellFormat> = {};
  if (value.formats && typeof value.formats === "object") {
    for (const [key, f] of Object.entries(value.formats as Record<string, any>)) {
      const ix = cellIndex(key);
      if (!ix || ix[0] >= ROWS || ix[1] >= COLS || !f || typeof f !== "object") continue;
      const clean = cleanFormat(f);
      if (Object.keys(clean).length) formats[key.toUpperCase()] = clean;
    }
  }
  const charts: SheetChart[] = Array.isArray(value.charts) ? value.charts.filter((c: any) => c && CHART_TYPES.includes(c.type) && rangeBounds(String(c.range ?? "")))
    .slice(0, 20).map((c: any, i: number) => ({
      id: String(c.id || `chart${i + 1}`), type: c.type, range: String(c.range).toUpperCase(), title: String(c.title ?? "").slice(0, 120),
      x: num(c.x, 0, 4000, 560), y: num(c.y, 0, 4000, 40), w: num(c.w, 240, 1200, 440), h: num(c.h, 180, 900, 280),
    })) : [];
  return { format: "atlas.sheet", version: 1, title: String(value.title || title), cells, formats, charts };
}

export const CHART_TYPES: ChartType[] = ["column", "bar", "line", "pie"];
export const CURRENCIES = ["USD", "EUR", "GBP", "GHS", "NGN", "KES", "ZAR", "INR", "JPY", "CNY", "CAD", "AUD"];
const num = (v: unknown, min: number, max: number, fallback: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback; };
export function cleanFormat(f: any): CellFormat {
  const out: CellFormat = {};
  if (f.b) out.b = true; if (f.i) out.i = true; if (f.u) out.u = true;
  if (["left", "center", "right"].includes(f.align)) out.align = f.align;
  if (["number", "currency", "percent", "date"].includes(f.num)) out.num = f.num;
  if (typeof f.cur === "string" && /^[A-Z]{3}$/.test(f.cur)) out.cur = f.cur;
  if (Number.isInteger(f.dp) && f.dp >= 0 && f.dp <= 6) out.dp = f.dp;
  return out;
}

/** Parse "A1:C5" (or a single cell) into [top, left, bottom, right]. */
export function rangeBounds(range: string): [number, number, number, number] | null {
  const [a, b = a] = range.replace(/\$/g, "").toUpperCase().split(":");
  const p = cellIndex(a), q = cellIndex(b);
  if (!p || !q) return null;
  return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])];
}
export const rangeName = (t: number, l: number, b: number, r: number) => t === b && l === r ? cellName(t, l) : `${cellName(t, l)}:${cellName(b, r)}`;

export const isNumeric = (v: string) => v.trim() !== "" && Number.isFinite(Number(v)) && !v.startsWith("#");

/** Display a calculated value with the cell's number format. */
export function formatValue(value: string, f?: CellFormat): string {
  if (!f?.num || !isNumeric(value)) return value;
  const n = Number(value);
  const dp = f.dp ?? 2;
  try {
    if (f.num === "date") return serialToDate(n).toLocaleDateString(undefined, { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });
    if (f.num === "percent") return new Intl.NumberFormat(undefined, { style: "percent", minimumFractionDigits: f.dp ?? 0, maximumFractionDigits: f.dp ?? 0 }).format(n);
    if (f.num === "currency") return new Intl.NumberFormat(undefined, { style: "currency", currency: f.cur || "USD", minimumFractionDigits: dp, maximumFractionDigits: dp }).format(n);
    return new Intl.NumberFormat(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp }).format(n);
  } catch { return value; }
}

/** Calculate every cell. Returns display strings; use `evaluateTyped` for typed values. */
export function evaluateGrid(grid: Grid): string[][] {
  const typed = evaluateTyped(grid);
  return typed.map((row) => row.map(display));
}

export function evaluateTyped(grid: Grid) {
  type S = ReturnType<typeof literal>;
  const cache = new Map<number, S>();
  const visiting = new Set<number>();
  const read = (r: number, c: number): S => {
    const key = r * COLS + c;
    const hit = cache.get(key);
    if (hit !== undefined || cache.has(key)) return hit as S;
    const raw = grid[r]?.[c] ?? "";
    if (!raw.startsWith("=") || raw.length === 1) { const v = literal(raw); cache.set(key, v); return v; }
    if (visiting.has(key)) return ERRORS.CYCLE;
    visiting.add(key);
    const v = evaluate(raw.slice(1), read, grid.length, COLS);
    visiting.delete(key); cache.set(key, v);
    return v;
  };
  return grid.map((row, r) => row.map((_, c) => read(r, c)));
}

export function parseCsv(text: string): Grid {
  const rows: Grid = [];
  let row: string[] = [], value = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"' && value === "") quoted = true;
    else if (ch === ",") { row.push(value); value = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(value); rows.push(row); row = []; value = "";
    } else value += ch;
  }
  row.push(value); if (row.length > 1 || row[0] !== "" || !rows.length) rows.push(row);
  const grid = emptyGrid();
  rows.slice(0, ROWS).forEach((r, ri) => r.slice(0, COLS).forEach((v, ci) => { grid[ri][ci] = v; }));
  return grid;
}
export function toCsv(grid: Grid): string {
  const quote = (v: string) => /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const lastRow = grid.reduce((n, row, i) => row.some((c) => c !== "") ? i : n, -1);
  const rows = grid.slice(0, lastRow + 1).map((row) => {
    let last = row.length - 1; while (last >= 0 && row[last] === "") last--;
    return row.slice(0, last + 1).map(quote).join(",");
  });
  return rows.join("\r\n") + (rows.length ? "\r\n" : "");
}
