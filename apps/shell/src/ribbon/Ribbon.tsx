// Office-style ribbon shared by the document apps: a document bar (back, title, save state, quick access),
// a tab row (File opens a full-screen backstage), and grouped commands that can collapse to a single line.
import React, { useEffect, useState } from "react";
import { LuArrowLeft, LuChevronUp, LuChevronDown, LuX } from "react-icons/lu";

export interface RibbonGroup { label: string; content: React.ReactNode }
export interface RibbonTab { id: string; label: string; contextual?: boolean; groups: RibbonGroup[] }
export interface BackstagePage { id: string; label: string; icon?: React.ReactNode; content?: React.ReactNode; onSelect?: () => void }

const COLLAPSE_KEY = "atlas.ribbon.collapsed";
const loadCollapsed = () => { try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; } };

export function Ribbon({ appName, appIcon, title, status, quick, tabs, backstage, onBack, activeTab, onTab }: {
  appName: string; appIcon: React.ReactNode; title: React.ReactNode; status?: React.ReactNode; quick?: React.ReactNode;
  tabs: RibbonTab[]; backstage: BackstagePage[]; onBack: () => void; activeTab?: string; onTab?: (id: string) => void;
}) {
  const [own, setOwn] = useState(tabs[0]?.id ?? "");
  const current = activeTab ?? own;
  const select = (id: string) => { setOwn(id); onTab?.(id); };
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [file, setFile] = useState<string | null>(null);
  const tab = tabs.find((t) => t.id === current) ?? tabs[0];

  const toggle = () => setCollapsed((c) => { try { localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1"); } catch { /* storage unavailable */ } return !c; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F1" && e.ctrlKey) { e.preventDefault(); toggle(); }
      if (e.key === "Escape" && file) setFile(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const page = backstage.find((p) => p.id === file);
  return (
    <>
      <div className="rb-docbar">
        <button className="rb-back" onClick={onBack} title="Back to the file list" aria-label="Back to the file list"><LuArrowLeft /></button>
        <span className="rb-app" aria-hidden="true">{appIcon}</span>
        <div className="rb-title"><strong className="ellipsis">{title}</strong>{status && <span className="rb-status">{status}</span>}</div>
        <div className="rb-quick" role="toolbar" aria-label="Quick access">{quick}</div>
      </div>
      <div className="rb-tabs" role="tablist" aria-label={`${appName} ribbon`}>
        <button role="tab" className="rb-tab rb-file" aria-selected={false} onClick={() => setFile(backstage[0]?.id ?? null)}>File</button>
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === tab?.id} className={`rb-tab ${t.id === tab?.id ? "is-active" : ""} ${t.contextual ? "is-contextual" : ""}`}
            onClick={() => select(t.id)} onDoubleClick={toggle}>{t.label}</button>
        ))}
        <span className="rb-tabs-spacer" />
        <button className="rb-collapse" onClick={toggle} title={collapsed ? "Show the full ribbon (Ctrl F1)" : "Show a single line of commands (Ctrl F1)"}
          aria-label={collapsed ? "Expand ribbon" : "Collapse ribbon"}>{collapsed ? <LuChevronDown /> : <LuChevronUp />}</button>
      </div>
      {tab && (
        <div className={`rb-commands ${collapsed ? "is-collapsed" : ""}`} role="toolbar" aria-label={`${tab.label} commands`}
          onMouseDown={(e) => { if ((e.target as HTMLElement).closest("button")) e.preventDefault(); }}>
          {tab.groups.map((g) => (
            <section key={g.label} className="rb-group" aria-label={g.label}>
              <div className="rb-group-body">{g.content}</div>
              <div className="rb-group-label">{g.label}</div>
            </section>
          ))}
        </div>
      )}
      {file !== null && (
        <div className="rb-backstage" role="dialog" aria-modal="true" aria-label="File">
          <nav className="rb-bs-nav">
            <button className="rb-bs-close" onClick={() => setFile(null)} aria-label="Close the File menu"><LuArrowLeft /></button>
            {backstage.map((p) => (
              <button key={p.id} className={`rb-bs-item ${p.id === file ? "is-active" : ""}`}
                onClick={() => { if (p.onSelect) { setFile(null); p.onSelect(); } else setFile(p.id); }}>{p.icon}{p.label}</button>
            ))}
          </nav>
          <div className="rb-bs-main">
            <button className="rb-bs-x icon-btn" onClick={() => setFile(null)} aria-label="Close"><LuX /></button>
            {page?.content}
          </div>
        </div>
      )}
    </>
  );
}

/** Large button: icon above the label (the main command in a group). */
export function RBig({ icon, label, onClick, active, disabled, title }: { icon: React.ReactNode; label: string; onClick?: () => void; active?: boolean; disabled?: boolean; title?: string }) {
  return <button className={`rb-big ${active ? "is-active" : ""}`} onClick={onClick} disabled={disabled} title={title ?? label} aria-pressed={active}>
    <span className="rb-big-icon">{icon}</span><span className="rb-big-label">{label}</span></button>;
}

/** Small button: icon, with the label shown beside it when `showLabel`. */
export function RSmall({ icon, label, onClick, active, disabled, showLabel, title }: { icon: React.ReactNode; label: string; onClick?: () => void; active?: boolean; disabled?: boolean; showLabel?: boolean; title?: string }) {
  return <button className={`rb-small ${active ? "is-active" : ""} ${showLabel ? "has-label" : ""}`} onClick={onClick} disabled={disabled}
    title={title ?? label} aria-label={label} aria-pressed={active}>{icon}{showLabel && <span>{label}</span>}</button>;
}

/** Rows of small controls inside a group (the classic two- or three-row layout). */
export function RStack({ children }: { children: React.ReactNode }) { return <div className="rb-stack">{children}</div>; }
export function RRow({ children }: { children: React.ReactNode }) { return <div className="rb-row">{children}</div>; }

/** Backstage page heading + body layout. */
export function BackstageSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="rb-bs-section"><h1>{title}</h1>{children}</section>;
}

/** Status bar zoom control: − slider + and the percentage. */
export function Zoom({ value, onChange, min = 50, max = 200 }: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / 10) * 10));
  return <div className="rb-zoom">
    <button onClick={() => onChange(clamp(value - 10))} aria-label="Zoom out">−</button>
    <input type="range" min={min} max={max} step={10} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label="Zoom" />
    <button onClick={() => onChange(clamp(value + 10))} aria-label="Zoom in">+</button>
    <button className="rb-zoom-pct" onClick={() => onChange(100)} title="Reset to 100%">{value}%</button>
  </div>;
}
