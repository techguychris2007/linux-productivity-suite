// SVG charts drawn from a sheet range. Colours come from the --series-N tokens (validated categorical palette).
import React, { useState } from "react";
import { type ChartType, type Grid, isNumeric, rangeBounds } from "./model";

export interface ChartData { categories: string[]; series: { name: string; values: (number | null)[] }[] }

const MAX_SERIES = 8;

/** Read a range: first column is categories when it holds text; first row is series names when it holds text. */
export function chartData(values: Grid, range: string): ChartData | null {
  const b = rangeBounds(range);
  if (!b) return null;
  const [t, l, bt, r] = b;
  const cell = (row: number, col: number) => values[row]?.[col] ?? "";
  const width = r - l + 1;
  const labelCol = width > 1 && Array.from({ length: bt - t + 1 }, (_, i) => cell(t + i, l)).some((v) => v.trim() && !isNumeric(v));
  const firstData = labelCol ? l + 1 : l;
  const headerRow = bt > t && Array.from({ length: r - firstData + 1 }, (_, i) => cell(t, firstData + i)).some((v) => v.trim() && !isNumeric(v));
  const top = headerRow ? t + 1 : t;
  if (top > bt || firstData > r) return null;
  const categories = Array.from({ length: bt - top + 1 }, (_, i) => labelCol ? cell(top + i, l) : String(i + 1));
  const series = Array.from({ length: Math.min(r - firstData + 1, MAX_SERIES) }, (_, j) => ({
    name: headerRow ? cell(t, firstData + j) || `Series ${j + 1}` : `Series ${j + 1}`,
    values: categories.map((_, i) => { const v = cell(top + i, firstData + j); return isNumeric(v) ? Number(v) : null; }),
  }));
  if (!series.some((s) => s.values.some((v) => v !== null))) return null;
  return { categories, series };
}

const fmt = (n: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n);
const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);

function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) { max = min + 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

/** Column/bar end rounded (4px) away from the baseline, square at the baseline. */
function barPath(x: number, y: number, w: number, h: number, horizontal: boolean, negative: boolean): string {
  const rr = Math.min(4, (horizontal ? h : w) / 2, Math.abs(horizontal ? w : h));
  if (w <= 0 || h <= 0) return "";
  if (!horizontal && !negative) return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
  if (!horizontal && negative) return `M${x},${y}V${y + h - rr}Q${x},${y + h} ${x + rr},${y + h}H${x + w - rr}Q${x + w},${y + h} ${x + w},${y + h - rr}V${y}Z`;
  if (horizontal && !negative) return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x}Z`;
  return `M${x + w},${y}H${x + rr}Q${x},${y} ${x},${y + rr}V${y + h - rr}Q${x},${y + h} ${x + rr},${y + h}H${x + w}Z`;
}

type Tip = { x: number; y: number; lines: string[] } | null;

export function ChartView({ type, data, width, height, title }: { type: ChartType; data: ChartData; width: number; height: number; title: string }) {
  const [tip, setTip] = useState<Tip>(null);
  const series = type === "pie" ? data.series.slice(0, 1) : data.series;
  const legend = type === "pie" || series.length >= 2;
  const titleH = title ? 26 : 6;
  const legendH = legend ? 22 : 0;
  const color = (i: number) => `var(--series-${(i % MAX_SERIES) + 1})`;
  const show = (e: React.MouseEvent, lines: string[]) => {
    const box = (e.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect();
    setTip({ x: e.clientX - box.left, y: e.clientY - box.top, lines });
  };

  let legendItems: { name: string; color: string }[] = series.map((s, i) => ({ name: s.name, color: color(i) }));
  let body: React.ReactNode;
  const plotTop = titleH + legendH + 8;

  if (type === "pie") {
    const raw = data.categories.map((c, i) => ({ name: c, v: Math.max(0, series[0].values[i] ?? 0) })).filter((s) => s.v > 0);
    const slices = raw.length > MAX_SERIES ? [...raw.slice(0, MAX_SERIES - 1), { name: "Other", v: raw.slice(MAX_SERIES - 1).reduce((a, s) => a + s.v, 0) }] : raw;
    const total = slices.reduce((a, s) => a + s.v, 0) || 1;
    const cx = width / 2, cy = plotTop + (height - plotTop - 10) / 2, rad = Math.max(20, Math.min(width / 2 - 24, (height - plotTop - 16) / 2));
    let a0 = -Math.PI / 2;
    legendItems = slices.map((s, i) => ({ name: s.name, color: color(i) }));
    body = <g>{slices.map((s, i) => {
      const a1 = a0 + (s.v / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const d = slices.length === 1 ? `M${cx - rad},${cy}a${rad},${rad} 0 1,0 ${rad * 2},0a${rad},${rad} 0 1,0 ${-rad * 2},0`
        : `M${cx},${cy}L${cx + rad * Math.cos(a0)},${cy + rad * Math.sin(a0)}A${rad},${rad} 0 ${large} 1 ${cx + rad * Math.cos(a1)},${cy + rad * Math.sin(a1)}Z`;
      const mid = (a0 + a1) / 2; a0 = a1;
      const pct = s.v / total;
      return <g key={i}>
        <path d={d} fill={color(i)} stroke="var(--chart-surface)" strokeWidth={2} onMouseMove={(e) => show(e, [s.name, `${fmt(s.v)} (${(pct * 100).toFixed(1)}%)`])} onMouseLeave={() => setTip(null)} />
        {pct >= 0.06 && <text x={cx + rad * 0.66 * Math.cos(mid)} y={cy + rad * 0.66 * Math.sin(mid)} textAnchor="middle" dominantBaseline="middle" className="chart-pie-label">{Math.round(pct * 100)}%</text>}
      </g>;
    })}</g>;
  } else {
    const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
    const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
    const lo = ticks[0], hi = ticks[ticks.length - 1];
    const horizontal = type === "bar";
    const left = horizontal ? Math.min(140, 12 + Math.max(...data.categories.map((c) => c.length)) * 6.5) : 46;
    const right = 14, bottom = 26;
    const pw = Math.max(10, width - left - right), ph = Math.max(10, height - plotTop - bottom);
    const n = data.categories.length;
    const valuePos = (v: number) => horizontal ? left + ((v - lo) / (hi - lo)) * pw : plotTop + ph - ((v - lo) / (hi - lo)) * ph;
    const base = valuePos(0);
    const band = (horizontal ? ph : pw) / n;
    const grid = ticks.map((t) => {
      const p = valuePos(t);
      return horizontal
        ? <g key={t}><line x1={p} x2={p} y1={plotTop} y2={plotTop + ph} className="chart-grid" /><text x={p} y={plotTop + ph + 16} textAnchor="middle" className="chart-axis">{compact(t)}</text></g>
        : <g key={t}><line x1={left} x2={left + pw} y1={p} y2={p} className="chart-grid" /><text x={left - 6} y={p} textAnchor="end" dominantBaseline="middle" className="chart-axis">{compact(t)}</text></g>;
    });
    const step = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((horizontal ? ph : pw) / (horizontal ? 18 : 56)))));
    const catLabels = data.categories.map((c, i) => i % step ? null : horizontal
      ? <text key={i} x={left - 6} y={plotTop + band * (i + 0.5)} textAnchor="end" dominantBaseline="middle" className="chart-axis">{c.length > 20 ? c.slice(0, 19) + "…" : c}</text>
      : <text key={i} x={left + band * (i + 0.5)} y={plotTop + ph + 16} textAnchor="middle" className="chart-axis">{c.length > 12 ? c.slice(0, 11) + "…" : c}</text>);
    let marks: React.ReactNode;
    if (type === "line") {
      marks = series.map((s, si) => {
        const pts = s.values.map((v, i) => v === null ? null : [left + band * (i + 0.5), valuePos(v)] as const);
        const d = pts.reduce((acc, p, i) => p ? acc + `${acc && pts[i - 1] ? "L" : "M"}${p[0]},${p[1]}` : acc, "");
        return <g key={si}><path d={d} fill="none" stroke={color(si)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {pts.map((p, i) => p && <circle key={i} cx={p[0]} cy={p[1]} r={4} fill={color(si)} stroke="var(--chart-surface)" strokeWidth={2}
            onMouseMove={(e) => show(e, [data.categories[i], `${s.name}: ${fmt(s.values[i]!)}`])} onMouseLeave={() => setTip(null)} />)}</g>;
      });
    } else {
      const inner = band * 0.72;
      const bw = Math.max(1, (inner - (series.length - 1) * 2) / series.length);
      marks = data.categories.map((c, i) => <g key={i}>{series.map((s, si) => {
        const v = s.values[i]; if (v === null) return null;
        const p = valuePos(v); const off = band * (i + 0.5) - inner / 2 + si * (bw + 2);
        const d = horizontal ? barPath(Math.min(p, base), plotTop + off, Math.abs(p - base), bw, true, v < 0) : barPath(left + off, Math.min(p, base), bw, Math.abs(p - base), false, v < 0);
        return <path key={si} d={d} fill={color(si)} onMouseMove={(e) => show(e, [c, `${s.name}: ${fmt(v)}`])} onMouseLeave={() => setTip(null)} />;
      })}</g>);
    }
    body = <g>{grid}{marks}
      {horizontal ? <line x1={base} x2={base} y1={plotTop} y2={plotTop + ph} className="chart-baseline" /> : <line x1={left} x2={left + pw} y1={base} y2={base} className="chart-baseline" />}
      {catLabels}</g>;
  }

  return <div className="chart-view">
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title || "Chart"}: ${type} chart of ${data.series.map((s) => s.name).join(", ")}`}>
      {title && <text x={width / 2} y={18} textAnchor="middle" className="chart-title">{title}</text>}
      {legend && <g transform={`translate(0 ${titleH + 4})`}>{(() => {
        let x = 10;
        return legendItems.map((it, i) => { const g = <g key={i} transform={`translate(${x} 0)`}><rect width={10} height={10} rx={2} fill={it.color} y={2} /><text x={14} y={11} className="chart-legend">{it.name}</text></g>; x += 24 + it.name.length * 6.2; return x > width ? null : g; });
      })()}</g>}
      {body}
    </svg>
    {tip && <div className="chart-tip" style={{ left: Math.min(tip.x + 12, width - 150), top: Math.max(0, tip.y - 40) }}>{tip.lines.map((l, i) => <div key={i} className={i ? "" : "chart-tip-head"}>{l}</div>)}</div>}
  </div>;
}

export const CHART_LABELS: Record<ChartType, string> = { column: "Column", bar: "Bar", line: "Line", pie: "Pie" };
