export type Grid = string[][];
export interface AtlasSheet { format: "atlas.sheet"; version: 1; title: string; cells: Grid }

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
  return { format: "atlas.sheet", version: 1, title: String(value.title || title), cells };
}

const tokenize = (s: string) => {
  s = s.trim();
  const tokens: string[] = [];
  const re = /\s*(?:(\$?[A-Z]{1,3}\$?[1-9]\d*(?::\$?[A-Z]{1,3}\$?[1-9]\d*)?)|([A-Z]+)|((?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)|("(?:[^"]|"")*")|([()+\-*/^,]))/gy;
  let pos = 0;
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) throw new Error("#ERROR!");
    tokens.push(m[1] || m[2] || m[3] || m[4] || m[5]);
    pos = re.lastIndex;
  }
  return tokens;
};

export function evaluateGrid(grid: Grid): string[][] {
  const cache = new Map<string, string>();
  const visiting = new Set<string>();
  const read = (r: number, c: number): string => {
    if (r < 0 || c < 0 || r >= grid.length || c >= COLS) return "#REF!";
    const key = `${r},${c}`;
    if (cache.has(key)) return cache.get(key)!;
    const raw = grid[r]?.[c] ?? "";
    if (!raw.startsWith("=")) return raw;
    if (visiting.has(key)) return "#CYCLE!";
    visiting.add(key);
    let result = "#ERROR!";
    try {
      const ts = tokenize(raw.slice(1));
      let i = 0;
      const expr = (): number => { let v = term(); while (ts[i] === "+" || ts[i] === "-") { const op = ts[i++]; const b = term(); v = op === "+" ? v + b : v - b; } return v; };
      const term = (): number => { let v = power(); while (ts[i] === "*" || ts[i] === "/") { const op = ts[i++]; const b = power(); if (op === "/" && b === 0) throw new Error("#DIV/0!"); v = op === "*" ? v * b : v / b; } return v; };
      const power = (): number => { let v = primary(); if (ts[i] === "^") { i++; v = v ** power(); } return v; };
      const primary = (): number => {
        const t = ts[i++];
        if (!t) throw new Error("#ERROR!");
        if (t === "+") return primary();
        if (t === "-") return -primary();
        if (t === "(") { const v = expr(); if (ts[i++] !== ")") throw new Error("#ERROR!"); return v; }
        if (/^(?:\d|\.)/.test(t)) return Number(t);
        if (/^"/.test(t)) throw new Error("#VALUE!");
        if (/^[A-Z]+$/i.test(t) && ts[i] === "(") {
          const fn = t.toUpperCase(); i++;
          const values: number[] = [];
          while (ts[i] !== ")") {
            const start = ts[i];
            if (/^\$?[A-Z]{1,3}\$?[1-9]\d*:\$?[A-Z]{1,3}\$?[1-9]\d*$/i.test(start ?? "")) {
              i++;
              const [a, b] = start.replace(/\$/g, "").split(":").map((x) => cellIndex(x)!);
              for (let rr = Math.min(a[0], b[0]); rr <= Math.max(a[0], b[0]); rr++) for (let cc = Math.min(a[1], b[1]); cc <= Math.max(a[1], b[1]); cc++) {
                const v = read(rr, cc); if (v.startsWith("#")) throw new Error(v); // Like other spreadsheets, ranges skip blank and text cells.
                if (v.trim() !== "") { const n = Number(v); if (Number.isFinite(n)) values.push(n); }
              }
            } else values.push(expr());
            if (ts[i] === ",") i++; else if (ts[i] !== ")") throw new Error("#ERROR!");
          }
          i++;
          if (fn === "SUM") return values.reduce((a, b) => a + b, 0);
          if (fn === "AVERAGE") return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
          if (fn === "MIN") return values.length ? Math.min(...values) : 0;
          if (fn === "MAX") return values.length ? Math.max(...values) : 0;
          if (fn === "COUNT") return values.length;
          throw new Error("#NAME?");
        }
        const ref = t.replace(/\$/g, "");
        const ix = cellIndex(ref); if (!ix) throw new Error("#NAME?");
        const v = read(ix[0], ix[1]);
        if (v.startsWith("#")) throw new Error(v);
        if (v.trim() === "") return 0;
        const n = Number(v); if (!Number.isFinite(n)) throw new Error("#VALUE!"); return n;
      };
      const n = expr(); if (i !== ts.length || !Number.isFinite(n)) throw new Error("#ERROR!");
      result = String(Number(n.toPrecision(12)));
    } catch (e: any) { result = /^#/.test(e?.message) ? e.message : "#ERROR!"; }
    visiting.delete(key); cache.set(key, result); return result;
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
