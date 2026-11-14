// Atlas Sheets formula engine: a safe parser/evaluator (no eval, no JavaScript execution).
// Follows spreadsheet conventions: operator precedence, typed values, error values, 1900 date serials
// and the most-used functions (see documentation/research/OFFICE_FEATURE_INVENTORY.md).

export class FErr { readonly code: string; constructor(code: string) { this.code = code; } toString() { return this.code; } }
type Scalar = number | string | boolean | FErr | null; // null = empty cell
interface RangeVal { kind: "range"; top: number; left: number; rows: Scalar[][] }
type Val = Scalar | RangeVal;

const E = { VALUE: new FErr("#VALUE!"), DIV0: new FErr("#DIV/0!"), NAME: new FErr("#NAME?"), REF: new FErr("#REF!"), NA: new FErr("#N/A"), NUM: new FErr("#NUM!"), ERROR: new FErr("#ERROR!"), CYCLE: new FErr("#CYCLE!") };
const fail = (e: FErr): never => { throw e; };
const isRange = (v: Val): v is RangeVal => !!v && typeof v === "object" && (v as RangeVal).kind === "range";

// ---------------------------------------------------------------- tokens

type Tok = { t: "num"; v: number } | { t: "str"; v: string } | { t: "ref"; v: string } | { t: "name"; v: string } | { t: "op"; v: string };
const TOKEN = /\s*(?:(\$?[A-Za-z]{1,3}\$?[1-9]\d*(?::\$?[A-Za-z]{1,3}\$?[1-9]\d*)?)(?![A-Za-z0-9_.(])|([A-Za-z_][A-Za-z0-9_.]*)|((?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)|"((?:[^"]|"")*)"|(<=|>=|<>|[-+*/^&=<>%(),:;]))/y;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let pos = 0;
  while (pos < src.length) {
    if (/^\s+$/.test(src.slice(pos))) break;
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src);
    if (!m) fail(E.ERROR);
    if (m![1]) out.push({ t: "ref", v: m![1].toUpperCase().replace(/\$/g, "") });
    else if (m![2]) out.push({ t: "name", v: m![2].toUpperCase() });
    else if (m![3]) out.push({ t: "num", v: Number(m![3]) });
    else if (m![4] !== undefined) out.push({ t: "str", v: m![4].replace(/""/g, '"') });
    else out.push({ t: "op", v: m![5] === ";" ? "," : m![5] });
    pos = TOKEN.lastIndex;
  }
  return out;
}

// ---------------------------------------------------------------- AST

type Node =
  | { k: "lit"; v: Scalar } | { k: "ref"; v: string } | { k: "un"; op: string; a: Node } | { k: "pct"; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node } | { k: "call"; fn: string; args: Node[] };

function parse(tokens: Tok[]): Node {
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const bin = (next: () => Node, ops: string[]) => () => {
    let a = next();
    while (peek()?.t === "op" && ops.includes(String(peek()!.v))) { const op = tokens[i++].v as string; a = { k: "bin", op, a, b: next() }; }
    return a;
  };
  const primary = (): Node => {
    const t = tokens[i++];
    if (!t) fail(E.ERROR);
    if (t.t === "num") return { k: "lit", v: t.v };
    if (t.t === "str") return { k: "lit", v: t.v };
    if (t.t === "ref") return { k: "ref", v: t.v };
    if (t.t === "name") {
      if (isOp("(")) {
        i++;
        const args: Node[] = [];
        if (!isOp(")")) {
          for (;;) {
            if (isOp(",") || isOp(")")) args.push({ k: "lit", v: null }); else args.push(compare());
            if (isOp(",")) { i++; continue; }
            break;
          }
        }
        if (!isOp(")")) fail(E.ERROR);
        i++;
        return { k: "call", fn: t.v.replace(/^_XLFN\./, ""), args };
      }
      if (t.v === "TRUE") return { k: "lit", v: true };
      if (t.v === "FALSE") return { k: "lit", v: false };
      return fail(E.NAME);
    }
    if (t.v === "(") { const n = compare(); if (!isOp(")")) fail(E.ERROR); i++; return n; }
    if (t.v === "-" || t.v === "+") return { k: "un", op: t.v, a: unaryTarget() };
    return fail(E.ERROR);
  };
  const postfix = (): Node => { let n = primary(); while (isOp("%")) { i++; n = { k: "pct", a: n }; } return n; };
  // Spreadsheet rule: unary minus binds tighter than ^ (=-2^2 is 4).
  const unaryTarget = (): Node => postfix();
  const power = (): Node => { let a = postfix(); while (isOp("^")) { i++; a = { k: "bin", op: "^", a, b: postfix() }; } return a; };
  const mul = bin(power, ["*", "/"]);
  const add = bin(mul, ["+", "-"]);
  const concat = bin(add, ["&"]);
  const compare = bin(concat, ["=", "<>", "<", ">", "<=", ">="]);
  const n = compare();
  if (i !== tokens.length) fail(E.ERROR);
  return n;
}

// ---------------------------------------------------------------- coercion

const EPOCH = Date.UTC(1899, 11, 30);
export const dateToSerial = (y: number, m: number, d: number) => (Date.UTC(y, m - 1, d) - EPOCH) / 86400000;
export const serialToDate = (s: number) => new Date(EPOCH + Math.round(s * 86400000));

function num(v: Val): number {
  if (isRange(v)) { if (v.rows.length === 1 && v.rows[0].length === 1) return num(v.rows[0][0]); return fail(E.VALUE); }
  if (v instanceof FErr) throw v;
  if (v === null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const s = v.trim();
  if (s === "") return 0;
  const n = Number(s.replace(/,/g, ""));
  if (Number.isFinite(n)) return n;
  if (/^-?\d+(\.\d+)?%$/.test(s)) return Number(s.slice(0, -1)) / 100;
  const d = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (d) return dateToSerial(+d[1], +d[2], +d[3]);
  return fail(E.VALUE);
}
function str(v: Val): string {
  if (isRange(v)) { if (v.rows.length === 1 && v.rows[0].length === 1) return str(v.rows[0][0]); return fail(E.VALUE); }
  if (v instanceof FErr) throw v;
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return show(v);
  return v;
}
function bool(v: Val): boolean {
  if (isRange(v)) { if (v.rows.length === 1 && v.rows[0].length === 1) return bool(v.rows[0][0]); return fail(E.VALUE); }
  if (v instanceof FErr) throw v;
  if (typeof v === "boolean") return v;
  if (v === null) return false;
  if (typeof v === "number") return v !== 0;
  const s = v.trim().toUpperCase();
  if (s === "TRUE") return true; if (s === "FALSE") return false;
  return fail(E.VALUE);
}
const scalar = (v: Val): Scalar => isRange(v) ? (v.rows.length === 1 && v.rows[0].length === 1 ? v.rows[0][0] : fail(E.VALUE)) : v;
const show = (n: number) => String(Number(n.toPrecision(12)));
const cells = (v: Val): Scalar[] => isRange(v) ? v.rows.flat() : [v];
/** Numbers for aggregates: from ranges, text/booleans/blanks are skipped; direct arguments are coerced. */
function nums(args: Val[]): number[] {
  const out: number[] = [];
  for (const a of args) {
    if (isRange(a)) { for (const c of a.rows.flat()) { if (c instanceof FErr) throw c; if (typeof c === "number") out.push(c); } }
    else if (a !== null) out.push(num(a));
  }
  return out;
}
const check = (n: number) => Number.isFinite(n) ? n : fail(E.NUM);

// ---------------------------------------------------------------- criteria (COUNTIF, SUMIF...)

function matcher(crit: Val): (c: Scalar) => boolean {
  const c = scalar(crit);
  if (typeof c === "number" || typeof c === "boolean") return (x) => x === c || (typeof x === "string" && x.trim() !== "" && Number(x) === c);
  const s = str(c);
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(s)!;
  const op = m[1] ?? "=", rhs = m[2];
  const rn = rhs.trim() !== "" && Number.isFinite(Number(rhs)) ? Number(rhs) : null;
  const wild = new RegExp("^" + rhs.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/~\*/g, "\u0001").replace(/~\?/g, "\u0002").replace(/\*/g, ".*").replace(/\?/g, ".").replace(/\u0001/g, "\\*").replace(/\u0002/g, "\\?") + "$", "is");
  return (x) => {
    if (x instanceof FErr) return false;
    if (rn !== null && (typeof x === "number" || (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x))))) {
      const xn = Number(x);
      return op === "=" ? xn === rn : op === "<>" ? xn !== rn : op === "<" ? xn < rn : op === ">" ? xn > rn : op === "<=" ? xn <= rn : xn >= rn;
    }
    if (rn !== null && op !== "=" && op !== "<>") return false;
    const xs = x === null ? "" : typeof x === "boolean" ? (x ? "TRUE" : "FALSE") : String(x);
    if (op === "=") return rhs === "" ? xs === "" : wild.test(xs);
    if (op === "<>") return rhs === "" ? xs !== "" : !wild.test(xs);
    const cmp = xs.localeCompare(rhs, undefined, { sensitivity: "base" });
    return op === "<" ? cmp < 0 : op === ">" ? cmp > 0 : op === "<=" ? cmp <= 0 : cmp >= 0;
  };
}
const area = (v: Val): Scalar[] => isRange(v) ? v.rows.flat() : [scalar(v)];
function ifsPairs(args: Val[], from: number): boolean[] {
  const size = area(args[from]).length;
  const ok = Array(size).fill(true);
  for (let i = from; i + 1 < args.length; i += 2) {
    const cs = area(args[i]); if (cs.length !== size) fail(E.VALUE);
    const m = matcher(args[i + 1]);
    cs.forEach((c, j) => { if (!m(c)) ok[j] = false; });
  }
  return ok;
}

// ---------------------------------------------------------------- functions

const stats = {
  mean: (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : fail(E.DIV0),
  variance: (a: number[], sample: boolean) => { if (a.length < (sample ? 2 : 1)) fail(E.DIV0); const m = stats.mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - (sample ? 1 : 0)); },
  percentile: (a: number[], p: number) => { if (!a.length || p < 0 || p > 1) fail(E.NUM); const s = [...a].sort((x, y) => x - y); const r = p * (s.length - 1); const lo = Math.floor(r); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (r - lo); },
};
const roundTo = (n: number, d: number, mode: "half" | "up" | "down") => {
  const f = 10 ** d;
  const x = Number((Math.abs(n) * f).toPrecision(15));
  const r = mode === "half" ? Math.round(x) : mode === "up" ? Math.ceil(x) : Math.floor(x);
  return Math.sign(n) * r / f;
};
const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
const ymd = (s: number) => { const d = serialToDate(s); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()] as const; };
const addMonths = (s: number, m: number, end: boolean) => {
  const [y, mo, d] = ymd(s);
  const t = new Date(Date.UTC(y, mo - 1 + m + (end ? 1 : 0), end ? 0 : 1));
  if (end) return (t.getTime() - EPOCH) / 86400000;
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return dateToSerial(t.getUTCFullYear(), t.getUTCMonth() + 1, Math.min(d, last));
};

/** TEXT(value, format) for the common patterns: 0, 0.00, #,##0.00, 0%, 0.0%, yyyy-mm-dd, dd/mm/yyyy, mmm d, yyyy... */
function textFormat(v: Val, f: string): string {
  const n = num(v);
  if (/[ymdhs]/i.test(f) && !/[#0]/.test(f)) {
    const d = serialToDate(n);
    const M = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const W = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return f.replace(/yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s/gi, (t) => {
      const k = t.toLowerCase();
      if (k === "yyyy") return String(d.getUTCFullYear()); if (k === "yy") return String(d.getUTCFullYear()).slice(2);
      if (k === "mmmm") return M[d.getUTCMonth()]; if (k === "mmm") return M[d.getUTCMonth()].slice(0, 3);
      if (k === "mm") return String(d.getUTCMonth() + 1).padStart(2, "0"); if (k === "m") return String(d.getUTCMonth() + 1);
      if (k === "dddd") return W[d.getUTCDay()]; if (k === "ddd") return W[d.getUTCDay()].slice(0, 3);
      if (k === "dd") return String(d.getUTCDate()).padStart(2, "0"); if (k === "d") return String(d.getUTCDate());
      if (k === "hh") return String(d.getUTCHours()).padStart(2, "0"); if (k === "h") return String(d.getUTCHours());
      if (k === "ss") return String(d.getUTCSeconds()).padStart(2, "0"); return String(d.getUTCSeconds());
    });
  }
  const pct = f.includes("%");
  const x = pct ? n * 100 : n;
  const dec = (/\.([0#]+)/.exec(f)?.[1].length) ?? 0;
  const grouped = f.includes(",");
  const body = new Intl.NumberFormat("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: grouped }).format(x);
  const prefix = /^[^#0.,%]*/.exec(f)?.[0] ?? "";
  return prefix + body + (pct ? "%" : "");
}

type Fn = (args: Val[]) => Val;
type Lazy = (nodes: Node[], ev: (n: Node) => Val) => Val;

const FN: Record<string, Fn> = {
  // math
  SUM: (a) => nums(a).reduce((x, y) => x + y, 0),
  PRODUCT: (a) => nums(a).reduce((x, y) => x * y, 1),
  ABS: ([x]) => Math.abs(num(x)), INT: ([x]) => Math.floor(num(x)), SIGN: ([x]) => Math.sign(num(x)),
  MOD: ([a, b]) => { const d = num(b); if (d === 0) fail(E.DIV0); const n = num(a); return n - d * Math.floor(n / d); },
  QUOTIENT: ([a, b]) => { const d = num(b); if (d === 0) fail(E.DIV0); return Math.trunc(num(a) / d); },
  POWER: ([a, b]) => check(num(a) ** num(b)), SQRT: ([x]) => { const n = num(x); return n < 0 ? fail(E.NUM) : Math.sqrt(n); },
  EXP: ([x]) => check(Math.exp(num(x))), LN: ([x]) => { const n = num(x); return n <= 0 ? fail(E.NUM) : Math.log(n); },
  LOG: ([x, b]) => { const n = num(x), base = b === undefined || b === null ? 10 : num(b); return n <= 0 || base <= 0 || base === 1 ? fail(E.NUM) : Math.log(n) / Math.log(base); },
  LOG10: ([x]) => { const n = num(x); return n <= 0 ? fail(E.NUM) : Math.log10(n); },
  PI: () => Math.PI, SIN: ([x]) => Math.sin(num(x)), COS: ([x]) => Math.cos(num(x)), TAN: ([x]) => Math.tan(num(x)),
  DEGREES: ([x]) => num(x) * 180 / Math.PI, RADIANS: ([x]) => num(x) * Math.PI / 180,
  ROUND: ([x, d]) => roundTo(num(x), num(d ?? 0), "half"), ROUNDUP: ([x, d]) => roundTo(num(x), num(d ?? 0), "up"), ROUNDDOWN: ([x, d]) => roundTo(num(x), num(d ?? 0), "down"),
  TRUNC: ([x, d]) => roundTo(num(x), num(d ?? 0), "down"),
  CEILING: ([x, s]) => { const n = num(x), st = s === undefined ? 1 : num(s); return st === 0 ? 0 : Math.ceil(n / st) * st; },
  FLOOR: ([x, s]) => { const n = num(x), st = s === undefined ? 1 : num(s); return st === 0 ? fail(E.DIV0) : Math.floor(n / st) * st; },
  MROUND: ([x, m]) => { const mm = num(m); return mm === 0 ? 0 : Math.round(num(x) / mm) * mm; },
  EVEN: ([x]) => { const n = num(x); const c = Math.ceil(Math.abs(n) / 2) * 2; return n < 0 ? -c : c; },
  ODD: ([x]) => { const n = num(x); let c = Math.ceil(Math.abs(n)); if (c % 2 === 0) c++; return n < 0 ? -c : c; },
  FACT: ([x]) => { const n = Math.floor(num(x)); if (n < 0 || n > 170) fail(E.NUM); let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; },
  GCD: (a) => nums(a).map((n) => Math.floor(Math.abs(n))).reduce(gcd, 0),
  LCM: (a) => nums(a).map((n) => Math.floor(Math.abs(n))).reduce((x, y) => x && y ? x / gcd(x, y) * y : 0, 1),
  RAND: () => Math.random(), RANDBETWEEN: ([a, b]) => { const lo = Math.ceil(num(a)), hi = Math.floor(num(b)); return hi < lo ? fail(E.NUM) : lo + Math.floor(Math.random() * (hi - lo + 1)); },
  SUMSQ: (a) => nums(a).reduce((s, x) => s + x * x, 0),
  SUMPRODUCT: (a) => { const arrs = a.map(area); const n = arrs[0]?.length ?? 0; if (arrs.some((x) => x.length !== n)) fail(E.VALUE); let s = 0; for (let i = 0; i < n; i++) s += arrs.reduce((p, arr) => p * (typeof arr[i] === "number" ? arr[i] as number : 0), 1); return s; },
  SUMIF: ([r, c, s]) => { const cs = area(r), vs = s === undefined ? cs : area(s), m = matcher(c); return cs.reduce<number>((t, x, i) => m(x) && typeof vs[i] === "number" ? t + (vs[i] as number) : t, 0); },
  SUMIFS: ([s, ...rest]) => { const vs = area(s), ok = ifsPairs([s, ...rest], 1); if (ok.length !== vs.length) fail(E.VALUE); return vs.reduce<number>((t, x, i) => ok[i] && typeof x === "number" ? t + x : t, 0); },
  // statistics
  AVERAGE: (a) => stats.mean(nums(a)),
  AVERAGEIF: ([r, c, s]) => { const cs = area(r), vs = s === undefined ? cs : area(s), m = matcher(c); return stats.mean(cs.flatMap((x, i) => m(x) && typeof vs[i] === "number" ? [vs[i] as number] : [])); },
  AVERAGEIFS: ([s, ...rest]) => { const vs = area(s), ok = ifsPairs([s, ...rest], 1); return stats.mean(vs.flatMap((x, i) => ok[i] && typeof x === "number" ? [x] : [])); },
  COUNT: (a) => a.reduce<number>((n, v) => n + cells(v).filter((c) => typeof c === "number" || (!isRange(v) && c !== null && typeof c === "string" && Number.isFinite(Number(c)) && c.trim() !== "")).length, 0),
  COUNTA: (a) => a.reduce<number>((n, v) => n + cells(v).filter((c) => c !== null && c !== "").length, 0),
  COUNTBLANK: (a) => a.reduce<number>((n, v) => n + cells(v).filter((c) => c === null || c === "").length, 0),
  COUNTIF: ([r, c]) => { const m = matcher(c); return area(r).filter(m).length; },
  COUNTIFS: (a) => ifsPairs(a, 0).filter(Boolean).length,
  MAX: (a) => { const n = nums(a); return n.length ? Math.max(...n) : 0; }, MIN: (a) => { const n = nums(a); return n.length ? Math.min(...n) : 0; },
  MAXIFS: ([s, ...rest]) => { const vs = area(s), ok = ifsPairs([s, ...rest], 1); const n = vs.flatMap((x, i) => ok[i] && typeof x === "number" ? [x] : []); return n.length ? Math.max(...n) : 0; },
  MINIFS: ([s, ...rest]) => { const vs = area(s), ok = ifsPairs([s, ...rest], 1); const n = vs.flatMap((x, i) => ok[i] && typeof x === "number" ? [x] : []); return n.length ? Math.min(...n) : 0; },
  MEDIAN: (a) => stats.percentile(nums(a), 0.5),
  MODE: (a) => { const n = nums(a); const c = new Map<number, number>(); n.forEach((x) => c.set(x, (c.get(x) ?? 0) + 1)); let best: number | null = null, bc = 1; for (const x of n) if ((c.get(x) ?? 0) > bc) { best = x; bc = c.get(x)!; } return best ?? fail(E.NA); },
  STDEV: (a) => Math.sqrt(stats.variance(nums(a), true)), "STDEV.P": (a) => Math.sqrt(stats.variance(nums(a), false)),
  VAR: (a) => stats.variance(nums(a), true), "VAR.P": (a) => stats.variance(nums(a), false),
  LARGE: ([r, k]) => { const s = nums([r]).sort((x, y) => y - x); const i = Math.floor(num(k)); return i < 1 || i > s.length ? fail(E.NUM) : s[i - 1]; },
  SMALL: ([r, k]) => { const s = nums([r]).sort((x, y) => x - y); const i = Math.floor(num(k)); return i < 1 || i > s.length ? fail(E.NUM) : s[i - 1]; },
  RANK: ([x, r, o]) => { const v = num(x), s = nums([r]); if (!s.includes(v)) fail(E.NA); const asc = o !== undefined && o !== null && num(o) !== 0; return 1 + s.filter((y) => asc ? y < v : y > v).length; },
  PERCENTILE: ([r, p]) => stats.percentile(nums([r]), num(p)),
  QUARTILE: ([r, q]) => { const k = Math.floor(num(q)); return k < 0 || k > 4 ? fail(E.NUM) : stats.percentile(nums([r]), k / 4); },
  CORREL: ([a, b]) => { const x = area(a), y = area(b); if (x.length !== y.length) fail(E.NA); const p = x.flatMap((v, i) => typeof v === "number" && typeof y[i] === "number" ? [[v, y[i] as number]] : []); if (p.length < 2) fail(E.DIV0); const mx = stats.mean(p.map((q) => q[0])), my = stats.mean(p.map((q) => q[1])); let sxy = 0, sxx = 0, syy = 0; for (const [u, w] of p) { sxy += (u - mx) * (w - my); sxx += (u - mx) ** 2; syy += (w - my) ** 2; } return sxx && syy ? sxy / Math.sqrt(sxx * syy) : fail(E.DIV0); },
  // logical (IF, IFERROR... are lazy, below)
  AND: (a) => { const b = a.flatMap((v) => isRange(v) ? v.rows.flat().filter((c) => typeof c === "boolean" || typeof c === "number") : [v]); return b.length ? b.every(bool) : fail(E.VALUE); },
  OR: (a) => { const b = a.flatMap((v) => isRange(v) ? v.rows.flat().filter((c) => typeof c === "boolean" || typeof c === "number") : [v]); return b.length ? b.some(bool) : fail(E.VALUE); },
  XOR: (a) => a.flatMap((v) => isRange(v) ? v.rows.flat().filter((c) => typeof c === "boolean" || typeof c === "number") : [v]).filter(bool).length % 2 === 1,
  NOT: ([x]) => !bool(x), TRUE: () => true, FALSE: () => false, NA: () => fail(E.NA),
  // information
  ISNUMBER: ([x]) => typeof scalarSafe(x) === "number", ISTEXT: ([x]) => typeof scalarSafe(x) === "string" && scalarSafe(x) !== "",
  ISBLANK: ([x]) => { const v = scalarSafe(x); return v === null; }, ISLOGICAL: ([x]) => typeof scalarSafe(x) === "boolean",
  ISERROR: ([x]) => scalarSafe(x) instanceof FErr, ISERR: ([x]) => { const v = scalarSafe(x); return v instanceof FErr && v.code !== "#N/A"; },
  ISNA: ([x]) => { const v = scalarSafe(x); return v instanceof FErr && v.code === "#N/A"; },
  ISEVEN: ([x]) => Math.floor(Math.abs(num(x))) % 2 === 0, ISODD: ([x]) => Math.floor(Math.abs(num(x))) % 2 === 1,
  N: ([x]) => { const v = scalar(x); return typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : 0; },
  // text
  CONCAT: (a) => a.flatMap(cells).map((c) => str(c)).join(""), CONCATENATE: (a) => a.map(str).join(""),
  TEXTJOIN: ([d, skip, ...rest]) => { const sep = str(d), sk = bool(skip); return rest.flatMap(cells).map((c) => str(c)).filter((s) => !sk || s !== "").join(sep); },
  LEFT: ([s, n]) => str(s).slice(0, n === undefined ? 1 : Math.max(0, num(n))),
  RIGHT: ([s, n]) => { const t = str(s), k = n === undefined ? 1 : Math.max(0, num(n)); return k ? t.slice(-k) : ""; },
  MID: ([s, st, n]) => { const a = Math.floor(num(st)); if (a < 1) fail(E.VALUE); return str(s).substr(a - 1, Math.max(0, num(n))); },
  LEN: ([s]) => str(s).length, UPPER: ([s]) => str(s).toUpperCase(), LOWER: ([s]) => str(s).toLowerCase(),
  PROPER: ([s]) => str(s).toLowerCase().replace(/(^|[^a-z\u00C0-\u024F'])([a-z\u00C0-\u024F])/g, (_m, p, c) => p + c.toUpperCase()),
  TRIM: ([s]) => str(s).trim().replace(/ {2,}/g, " "),
  SUBSTITUTE: ([s, o, n, k]) => { const t = str(s), from = str(o), to = str(n); if (!from) return t; if (k === undefined) return t.split(from).join(to); let idx = -1; const want = num(k); for (let c = 0; c < want; c++) { idx = t.indexOf(from, idx + 1); if (idx < 0) return t; } return t.slice(0, idx) + to + t.slice(idx + from.length); },
  REPLACE: ([s, st, n, t]) => { const x = str(s), a = Math.floor(num(st)) - 1; return x.slice(0, a) + str(t) + x.slice(a + Math.floor(num(n))); },
  FIND: ([f, s, st]) => { const i = str(s).indexOf(str(f), (st === undefined ? 1 : num(st)) - 1); return i < 0 ? fail(E.VALUE) : i + 1; },
  SEARCH: ([f, s, st]) => { const pat = new RegExp(str(f).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, "."), "i"); const from = (st === undefined ? 1 : num(st)) - 1; const m = pat.exec(str(s).slice(from)); return m ? m.index + from + 1 : fail(E.VALUE); },
  REPT: ([s, n]) => { const k = Math.floor(num(n)); return k < 0 || k > 10000 ? fail(E.VALUE) : str(s).repeat(k); },
  EXACT: ([a, b]) => str(a) === str(b), VALUE: ([s]) => num(scalar(s)), TEXT: ([v, f]) => textFormat(v, str(f)),
  CHAR: ([n]) => String.fromCharCode(num(n)), CODE: ([s]) => { const t = str(s); return t ? t.charCodeAt(0) : fail(E.VALUE); },
  // date and time
  DATE: ([y, m, d]) => { let yy = Math.floor(num(y)); if (yy < 1900) yy += 1900; return (Date.UTC(yy, Math.floor(num(m)) - 1, Math.floor(num(d))) - EPOCH) / 86400000; },
  TIME: ([h, m, s]) => ((num(h) * 3600 + num(m) * 60 + num(s)) % 86400) / 86400,
  TODAY: () => { const n = new Date(); return dateToSerial(n.getFullYear(), n.getMonth() + 1, n.getDate()); },
  NOW: () => { const n = new Date(); return dateToSerial(n.getFullYear(), n.getMonth() + 1, n.getDate()) + (n.getHours() * 3600 + n.getMinutes() * 60 + n.getSeconds()) / 86400; },
  YEAR: ([s]) => ymd(num(s))[0], MONTH: ([s]) => ymd(num(s))[1], DAY: ([s]) => ymd(num(s))[2],
  HOUR: ([s]) => Math.floor(((num(s) % 1) * 24) + 1e-9), MINUTE: ([s]) => Math.floor(((num(s) * 1440) % 60) + 1e-9), SECOND: ([s]) => Math.round((num(s) * 86400) % 60),
  WEEKDAY: ([s, t]) => { const d = serialToDate(num(s)).getUTCDay(); const type = t === undefined ? 1 : num(t); return type === 2 ? ((d + 6) % 7) + 1 : type === 3 ? (d + 6) % 7 : d + 1; },
  DAYS: ([e, s]) => Math.floor(num(e)) - Math.floor(num(s)),
  EDATE: ([s, m]) => addMonths(num(s), Math.trunc(num(m)), false), EOMONTH: ([s, m]) => addMonths(num(s), Math.trunc(num(m)), true),
  DATEDIF: ([s, e, u]) => { const a = num(s), b = num(e); if (b < a) fail(E.NUM); const [y1, m1, d1] = ymd(a), [y2, m2, d2] = ymd(b); const unit = str(u).toUpperCase(); const months = (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0); return unit === "Y" ? Math.floor(months / 12) : unit === "M" ? months : unit === "D" ? Math.floor(b) - Math.floor(a) : fail(E.NUM); },
  NETWORKDAYS: ([s, e]) => { let a = Math.floor(num(s)), b = Math.floor(num(e)), sign = 1; if (b < a) { [a, b] = [b, a]; sign = -1; } if (b - a > 100000) fail(E.NUM); let n = 0; for (let d = a; d <= b; d++) { const w = serialToDate(d).getUTCDay(); if (w !== 0 && w !== 6) n++; } return n * sign; },
  // lookup and reference
  CHOOSE: ([i, ...opts]) => { const k = Math.floor(num(i)); return k < 1 || k > opts.length ? fail(E.VALUE) : opts[k - 1]; },
  ROWS: ([r]) => isRange(r) ? r.rows.length : 1, COLUMNS: ([r]) => isRange(r) ? r.rows[0].length : 1,
  INDEX: ([r, rn, cn]) => { if (!isRange(r)) return r; const R = r.rows; let i = rn === undefined || rn === null ? 0 : Math.floor(num(rn)), j = cn === undefined || cn === null ? 0 : Math.floor(num(cn)); if (R.length === 1 && j === 0) { j = i; i = 1; } if (j === 0) j = 1; if (i === 0) i = 1; return i < 1 || i > R.length || j < 1 || j > R[0].length ? fail(E.REF) : R[i - 1][j - 1]; },
  MATCH: ([v, r, t]) => { const arr = area(r), type = t === undefined ? 1 : num(t), x = scalar(v); return lookupIndex(x, arr, type) + 1; },
  VLOOKUP: ([v, r, c, approx]) => { if (!isRange(r)) fail(E.NA); const R = (r as RangeVal).rows, col = Math.floor(num(c)); if (col < 1 || col > R[0].length) fail(E.REF); const exact = approx !== undefined && approx !== null && !bool(approx); return R[lookupIndex(scalar(v), R.map((row) => row[0]), exact ? 0 : 1)][col - 1]; },
  HLOOKUP: ([v, r, c, approx]) => { if (!isRange(r)) fail(E.NA); const R = (r as RangeVal).rows, row = Math.floor(num(c)); if (row < 1 || row > R.length) fail(E.REF); const exact = approx !== undefined && approx !== null && !bool(approx); return R[row - 1][lookupIndex(scalar(v), R[0], exact ? 0 : 1)]; },
  // financial
  PMT: ([r, n, pv, fv, t]) => { const rate = num(r), np = num(n), p = num(pv), f = fv == null ? 0 : num(fv), ty = t == null ? 0 : num(t); if (np === 0) fail(E.NUM); if (rate === 0) return -(p + f) / np; const k = (1 + rate) ** np; return -(rate * (p * k + f)) / ((1 + rate * ty) * (k - 1)); },
  FV: ([r, n, pmt, pv, t]) => { const rate = num(r), np = num(n), pm = num(pmt), p = pv == null ? 0 : num(pv), ty = t == null ? 0 : num(t); if (rate === 0) return -(p + pm * np); const k = (1 + rate) ** np; return -(p * k + pm * (1 + rate * ty) * (k - 1) / rate); },
  PV: ([r, n, pmt, fv, t]) => { const rate = num(r), np = num(n), pm = num(pmt), f = fv == null ? 0 : num(fv), ty = t == null ? 0 : num(t); if (rate === 0) return -(f + pm * np); const k = (1 + rate) ** np; return -(f + pm * (1 + rate * ty) * (k - 1) / rate) / k; },
  NPER: ([r, pmt, pv, fv, t]) => { const rate = num(r), pm = num(pmt), p = num(pv), f = fv == null ? 0 : num(fv), ty = t == null ? 0 : num(t); if (rate === 0) return pm === 0 ? fail(E.NUM) : -(p + f) / pm; const a = pm * (1 + rate * ty) / rate; return check(Math.log((a - f) / (a + p)) / Math.log(1 + rate)); },
  NPV: ([r, ...flows]) => { const rate = num(r); return nums(flows).reduce((s, c, i) => s + c / (1 + rate) ** (i + 1), 0); },
  IRR: ([flows, guess]) => { const c = nums([flows]); let x = guess == null ? 0.1 : num(guess); for (let k = 0; k < 100; k++) { let f = 0, d = 0; c.forEach((v, i) => { f += v / (1 + x) ** i; d -= i * v / (1 + x) ** (i + 1); }); if (Math.abs(f) < 1e-10) return x; if (d === 0) break; x -= f / d; } return fail(E.NUM); },
};
// Current names for the same functions.
Object.assign(FN, { "STDEV.S": FN.STDEV, "VAR.S": FN.VAR, "MODE.SNGL": FN.MODE, "RANK.EQ": FN.RANK, "PERCENTILE.INC": FN.PERCENTILE, "QUARTILE.INC": FN.QUARTILE, "CEILING.MATH": FN.CEILING, "FLOOR.MATH": FN.FLOOR });

function scalarSafe(v: Val): Scalar { try { return scalar(v); } catch (e) { return e instanceof FErr ? e : E.VALUE; } }

function compareScalars(a: Scalar, b: Scalar): number {
  const rank = (x: Scalar) => x === null ? 0 : typeof x === "number" ? 1 : typeof x === "string" ? 2 : 3;
  if (a === null && typeof b === "string") a = ""; if (b === null && typeof a === "string") b = "";
  if (a === null && typeof b === "number") a = 0; if (b === null && typeof a === "number") b = 0;
  if (a === null && typeof b === "boolean") a = false; if (b === null && typeof a === "boolean") b = false;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (typeof a === "number") return a - (b as number);
  if (typeof a === "boolean") return Number(a) - Number(b);
  if (a === null) return 0;
  return (a as string).localeCompare(b as string, undefined, { sensitivity: "base" });
}
function lookupIndex(x: Scalar, arr: Scalar[], type: number): number {
  if (x instanceof FErr) throw x;
  if (type === 0) {
    const m = matcher(typeof x === "string" ? "=" + x : x);
    const i = arr.findIndex((c) => typeof x === "string" ? typeof c === "string" && m(c) : m(c));
    return i < 0 ? fail(E.NA) : i;
  }
  let best = -1;
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i]; if (c === null || c instanceof FErr) continue;
    const cmp = compareScalars(c, x);
    if (type > 0 ? cmp <= 0 : cmp >= 0) best = i; else break;
  }
  return best < 0 ? fail(E.NA) : best;
}

const LAZY: Record<string, Lazy> = {
  IF: ([c, a, b], ev) => bool(ev(c)) ? (a ? ev(a) : true) : (b ? ev(b) : false),
  IFERROR: ([v, alt], ev) => { try { const r = ev(v); const s = scalar(r); if (s instanceof FErr) return ev(alt); return r; } catch (e) { if (e instanceof FErr) return ev(alt); throw e; } },
  IFNA: ([v, alt], ev) => { try { const r = ev(v); const s = scalar(r); if (s instanceof FErr && s.code === "#N/A") return ev(alt); return r; } catch (e) { if (e instanceof FErr && e.code === "#N/A") return ev(alt); throw e; } },
  IFS: (nodes, ev) => { for (let i = 0; i + 1 < nodes.length; i += 2) if (bool(ev(nodes[i]))) return ev(nodes[i + 1]); return fail(E.NA); },
  SWITCH: ([x, ...rest], ev) => { const v = scalar(ev(x)); for (let i = 0; i + 1 < rest.length; i += 2) if (compareScalars(v, scalar(ev(rest[i]))) === 0) return ev(rest[i + 1]); return rest.length % 2 ? ev(rest[rest.length - 1]) : fail(E.NA); },
  XLOOKUP: ([v, look, ret, notFound], ev) => {
    const la = area(ev(look)), rv = ev(ret);
    try { const i = lookupIndex(scalar(ev(v)), la, 0); if (!isRange(rv)) return rv; return rv.rows.length === la.length ? rv.rows[i][0] : rv.rows[0][i]; }
    catch (e) { if (e instanceof FErr && e.code === "#N/A" && notFound) return ev(notFound); throw e; }
  },
  ROW: ([r]) => { if (!r || r.k !== "ref") return fail(E.VALUE); return (r.v.match(/\d+/)?.[0] ? Number(r.v.match(/\d+/)![0]) : fail(E.VALUE)); },
  COLUMN: ([r]) => { if (!r || r.k !== "ref") return fail(E.VALUE); let c = 0; for (const ch of r.v.match(/^[A-Z]+/)![0]) c = c * 26 + ch.charCodeAt(0) - 64; return c; },
};

export const FUNCTION_NAMES = [...Object.keys(FN), ...Object.keys(LAZY)].filter((n) => !["TRUE", "FALSE"].includes(n)).sort();

// ---------------------------------------------------------------- evaluator

export type CellReader = (row: number, col: number) => Scalar;
const refIndex = (ref: string): [number, number] | null => {
  const m = /^([A-Z]{1,3})([1-9]\d*)$/.exec(ref);
  if (!m) return null;
  let col = 0; for (const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64;
  return [Number(m[2]) - 1, col - 1];
};

export function evaluate(src: string, read: CellReader, rows: number, cols: number): Scalar {
  try {
    const ast = parse(tokenize(src));
    const ev = (n: Node): Val => {
      switch (n.k) {
        case "lit": return n.v;
        case "ref": {
          const [a, b = a] = n.v.split(":");
          const p = refIndex(a), q = refIndex(b);
          if (!p || !q) return fail(E.REF);
          const top = Math.min(p[0], q[0]), left = Math.min(p[1], q[1]), bottom = Math.max(p[0], q[0]), right = Math.max(p[1], q[1]);
          if (bottom >= rows || right >= cols) return fail(E.REF);
          if (!n.v.includes(":")) return read(top, left);
          const out: Scalar[][] = [];
          for (let r = top; r <= bottom; r++) { const row: Scalar[] = []; for (let c = left; c <= right; c++) row.push(read(r, c)); out.push(row); }
          return { kind: "range", top, left, rows: out };
        }
        case "un": { const v = num(ev(n.a)); return n.op === "-" ? -v : v; }
        case "pct": return num(ev(n.a)) / 100;
        case "bin": {
          const a = scalar(ev(n.a)), b = scalar(ev(n.b));
          if (a instanceof FErr) throw a; if (b instanceof FErr) throw b;
          switch (n.op) {
            case "+": return num(a) + num(b);
            case "-": return num(a) - num(b);
            case "*": return num(a) * num(b);
            case "/": { const d = num(b); if (d === 0) fail(E.DIV0); return num(a) / d; }
            case "^": return check(num(a) ** num(b));
            case "&": return str(a) + str(b);
            default: {
              const c = compareScalars(a, b);
              return n.op === "=" ? c === 0 : n.op === "<>" ? c !== 0 : n.op === "<" ? c < 0 : n.op === ">" ? c > 0 : n.op === "<=" ? c <= 0 : c >= 0;
            }
          }
        }
        case "call": {
          const lazy = LAZY[n.fn];
          if (lazy) return lazy(n.args, ev);
          const f = FN[n.fn];
          if (!f) return fail(E.NAME);
          return f(n.args.map((a) => a.k === "lit" && a.v === null ? null : ev(a)));
        }
      }
    };
    const r = scalar(ev(ast));
    if (typeof r === "number" && !Number.isFinite(r)) return E.NUM;
    return r;
  } catch (e) {
    if (e instanceof FErr) return e;
    return E.ERROR;
  }
}

/** Value of a plain (non-formula) cell. */
export function literal(raw: string): Scalar {
  if (raw === "") return null;
  const t = raw.trim();
  if (t !== "" && /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
  if (/^(TRUE|FALSE)$/i.test(t)) return t.toUpperCase() === "TRUE";
  return raw;
}

export function display(v: Scalar): string {
  if (v === null) return "";
  if (v instanceof FErr) return v.code;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return show(v);
  return v;
}

export const ERRORS = E;
