import React, { useEffect, useMemo, useRef, useState } from "react";
import { LuSearch, LuFile, LuFolder, LuSparkles } from "react-icons/lu";
import type { FsEntry } from "@atlas/shared-types";
import { Kbd, Spinner } from "@atlas/ui";
import { APPS } from "./apps";
import { useAtlas } from "./context";

type Item = { key: string; icon: React.ReactNode; title: string; sub?: string; run: () => void };

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { go, grants, bridge, askAi } = useAtlas();
  const [q, setQ] = useState("");
  const [files, setFiles] = useState<(FsEntry & { grant: string; label: string })[]>([]);
  const [searching, setSearching] = useState(false);
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) { setFiles([]); return; }
    let cancelled = false;
    setSearching(true);
    const t = window.setTimeout(async () => {
      const results = await Promise.all(grants.map((g) =>
        bridge.core<FsEntry[]>("fs.search", { grant: g.id, query, limit: 8 }).then((r) => r.map((e) => ({ ...e, grant: g.id, label: g.label }))).catch(() => [])));
      if (!cancelled) { setFiles(results.flat().slice(0, 12)); setSearching(false); }
    }, 180);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, grants, bridge]);

  const items = useMemo<Item[]>(() => {
    const s = q.trim().toLowerCase();
    const apps = APPS.filter((a) => !s || a.name.toLowerCase().includes(s) || a.keywords?.some((k) => k.includes(s)))
      .map((a) => ({ key: "app:" + a.id, icon: <a.icon />, title: a.name, sub: a.available ? "Open app" : `Planned · Milestone ${a.milestone}`, run: () => go(a.id) }));
    const fileItems = files.map((f) => ({ key: `f:${f.grant}:${f.path}`, icon: f.kind === "dir" ? <LuFolder /> : <LuFile />, title: f.name, sub: `${f.label}/${f.path}`, run: () => go("drive") }));
    const ai = s ? [{ key: "ai", icon: <LuSparkles />, title: `Ask Atlas AI: "${q.trim()}"`, sub: "Start a task", run: () => askAi(q.trim()) }] : [];
    return [...ai, ...apps, ...fileItems];
  }, [q, files, go, askAi]);
  useEffect(() => setIdx(0), [q]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && items[idx]) { items[idx].run(); onClose(); }
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Search Atlas" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="palette-input"><LuSearch /><input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search apps, files, or ask Atlas AI…" aria-label="Search" />{searching && <Spinner />}<Kbd>Esc</Kbd></div>
        <ul className="palette-list" role="listbox">
          {items.map((it, i) => (
            <li key={it.key} role="option" aria-selected={i === idx} className={i === idx ? "is-active" : ""} onMouseEnter={() => setIdx(i)} onClick={() => { it.run(); onClose(); }}>
              <span className="pi-icon">{it.icon}</span><span className="pi-title">{it.title}</span>{it.sub && <span className="pi-sub ellipsis">{it.sub}</span>}
            </li>
          ))}
          {items.length === 0 && <li className="muted pad">No matches.</li>}
        </ul>
      </div>
    </div>
  );
}
