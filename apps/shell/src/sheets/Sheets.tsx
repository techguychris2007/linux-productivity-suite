import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuSheet, LuFilePlus, LuUpload, LuDownload, LuSave, LuArrowLeft, LuRefreshCw } from "react-icons/lu";
import type { FsEntry } from "@atlas/shared-types";
import { Button, EmptyState, Field, IconButton, Spinner } from "@atlas/ui";
import { useAtlas, type DocRef } from "../context";
import { cellName, emptyGrid, evaluateGrid, newSheet, normalizeSheet, parseCsv, toCsv, type AtlasSheet, type Grid, ROWS, COLS } from "./model";

type Found = FsEntry & { grant: string; label: string };
const safeName = (s: string) => s.trim().replace(/[/\\]/g, "-").replace(/^\.+/, "") || "Untitled spreadsheet";
const download = (name: string, content: string, type: string) => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
};

export function Sheets() {
  const { bridge, grants, notify, go, setActiveDoc, sheetTarget, openInSheets } = useAtlas();
  const [docs, setDocs] = useState<Found[] | null>(null);
  const [sheet, setSheet] = useState<AtlasSheet | null>(null);
  const [ref, setRef] = useState<DocRef | null>(null);
  const [selected, setSelected] = useState<[number, number]>([0, 0]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("Untitled spreadsheet");
  const [grant, setGrant] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const writable = grants.filter((g) => g.access === "readwrite");
  useEffect(() => { if (!grant && writable[0]) setGrant(writable[0].id); }, [writable, grant]);

  const scan = useCallback(async () => {
    const found = (await Promise.all(grants.map((g) => bridge.core<FsEntry[]>("fs.search", { grant: g.id, query: ".atlasheet", limit: 200 }).then((items) => items.filter((e) => e.kind === "file" && e.name.endsWith(".atlasheet")).map((e) => ({ ...e, grant: g.id, label: g.label }))).catch(() => [])))).flat();
    found.sort((a, b) => (b.modified_ms ?? 0) - (a.modified_ms ?? 0)); setDocs(found);
  }, [bridge, grants]);
  useEffect(() => { scan(); }, [scan]);

  const open = async (item: DocRef & { name?: string }) => {
    setBusy(true);
    try {
      const data = await bridge.core<{ content: string }>("fs.read_text", { grant: item.grant, path: item.path, max_bytes: 2_000_000 });
      const parsed = normalizeSheet(JSON.parse(data.content), item.name ?? item.path.split("/").pop());
      setSheet(parsed); setRef({ grant: item.grant, path: item.path }); setSelected([0, 0]); setDirty(false);
      setActiveDoc({ grant: item.grant, path: item.path, app: "sheets", title: parsed.title });
    } catch (e: any) { notify({ tone: "danger", title: "Could not open spreadsheet", body: e.message }); }
    finally { setBusy(false); }
  };

  const create = async () => {
    const title = safeName(name); const path = `${title}.atlasheet`;
    try {
      await bridge.core("fs.write_text", { grant, path, content: JSON.stringify(newSheet(title), null, 1), overwrite: false });
      await open({ grant, path });
      setCreating(false); scan();
    } catch (e: any) { notify({ tone: "danger", title: "Could not create spreadsheet", body: e.message }); }
  };

  useEffect(() => { if (sheetTarget) void open(sheetTarget); }, [sheetTarget]);

  const updateCell = (r: number, c: number, value: string) => {
    if (!sheet) return;
    const cells = sheet.cells.map((row) => [...row]); cells[r][c] = value;
    setSheet({ ...sheet, cells }); setDirty(true);
  };

  const save = useCallback(async () => {
    if (!sheet || !ref || !dirty) return;
    setSaving(true);
    try {
      await bridge.core("fs.write_text", { grant: ref.grant, path: ref.path, content: JSON.stringify(sheet, null, 1), overwrite: true });
      setDirty(false);
    } catch (e: any) { notify({ tone: "danger", title: "Could not save spreadsheet", body: e.message }); }
    finally { setSaving(false); }
  }, [bridge, dirty, notify, ref, sheet]);
  useEffect(() => { if (!dirty) return; const timer = window.setTimeout(() => { void save(); }, 700); return () => clearTimeout(timer); }, [dirty, save]);
  useEffect(() => () => setActiveDoc(null), [setActiveDoc]);

  const values = useMemo(() => sheet ? evaluateGrid(sheet.cells) : emptyGrid(), [sheet]);
  const currentValue = sheet?.cells[selected[0]]?.[selected[1]] ?? "";
  const importCsv = async (file?: File) => {
    if (!file || !writable.length) return;
    const targetGrant = grant || writable[0].id;
    const title = safeName(file.name.replace(/\.csv$/i, ""));
    const path = `${title}.atlasheet`;
    try {
      const model = { ...newSheet(title), cells: parseCsv(await file.text()) };
      await bridge.core("fs.write_text", { grant: targetGrant, path, content: JSON.stringify(model, null, 1), overwrite: false });
      await open({ grant: targetGrant, path });
      notify({ tone: "success", title: "CSV imported", body: `Saved as ${path}` }); scan();
    } catch (e: any) { notify({ tone: "danger", title: "CSV import failed", body: e.message }); }
    finally { if (inputRef.current) inputRef.current.value = ""; }
  };

  const close = () => { if (dirty && !window.confirm("There are unsaved changes. Close anyway?")) return; setSheet(null); setRef(null); setDirty(false); setActiveDoc(null); openInSheets(null); };
  const exportCsv = () => { if (sheet) download(`${safeName(sheet.title)}.csv`, toCsv(sheet.cells.map((row, r) => row.map((cell, c) => cell.startsWith("=") ? values[r][c] : cell))), "text/csv;charset=utf-8"); };

  if (sheet && ref) {
    const [sr, sc] = selected;
    return <section className="sheet-editor">
      <header className="sheet-toolbar">
        <Button size="sm" variant="ghost" icon={<LuArrowLeft />} onClick={close}>All spreadsheets</Button>
        <div className="sheet-title"><LuSheet /><strong>{sheet.title}</strong></div>
        <span className={`sheet-save ${dirty ? "is-dirty" : ""}`}>{saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}</span>
        <Button size="sm" variant="ghost" icon={<LuDownload />} onClick={exportCsv}>Export CSV</Button>
        <Button size="sm" variant="primary" icon={saving ? <Spinner size={12} /> : <LuSave />} onClick={() => void save()}>Save</Button>
      </header>
      <div className="sheet-formula"><span className="sheet-address">{cellName(sr, sc)}</span><span className="sheet-fx">fx</span><input aria-label="Cell value or formula" value={currentValue} onChange={(e) => updateCell(sr, sc, e.target.value)} placeholder="Enter a value or formula, e.g. =SUM(B2:B8)" /></div>
      <div className="sheet-grid-wrap"><table className="sheet-grid"><thead><tr><th className="sheet-corner" />{Array.from({ length: COLS }, (_, c) => <th key={c}>{String.fromCharCode(65 + c)}</th>)}</tr></thead><tbody>{Array.from({ length: ROWS }, (_, r) => <tr key={r}><th>{r + 1}</th>{Array.from({ length: COLS }, (_, c) => <td key={c}><button className={`${sr === r && sc === c ? "is-selected" : ""} ${sheet.cells[r][c].startsWith("=") ? "is-formula" : ""}`} onClick={() => setSelected([r, c])} title={sheet.cells[r][c]}>{values[r][c]}</button></td>)}</tr>)}</tbody></table></div>
      <footer className="sheet-status">{cellName(sr, sc)}{currentValue.startsWith("=") ? ` · ${values[sr][sc]}` : ""} <span>Formulas: + − × ÷, parentheses, SUM, AVERAGE, MIN, MAX, COUNT</span></footer>
    </section>;
  }

  if (!grants.length) return <div className="page"><EmptyState icon={<LuSheet />} title="Share a folder to start a spreadsheet" action={<Button variant="primary" onClick={() => go("settings:folders")}>Share a folder</Button>}>Sheets saves your work in folders you have shared with Atlas.</EmptyState></div>;
  return <div className="page sheet-home">
    <header className="row between wrap gap-2"><div><h1>Sheets</h1><p className="muted">Lightweight spreadsheets with formulas and CSV import/export.</p></div><div className="row gap-2"><IconButton label="Refresh" onClick={scan}><LuRefreshCw /></IconButton><Button icon={<LuUpload />} onClick={() => inputRef.current?.click()} disabled={!writable.length}>Import CSV</Button><input ref={inputRef} className="visually-hidden" type="file" accept=".csv,text/csv" onChange={(e) => importCsv(e.target.files?.[0])} /><Button variant="primary" icon={<LuFilePlus />} onClick={() => setCreating(true)} disabled={!writable.length}>New spreadsheet</Button></div></header>
    {creating && <form className="card new-doc" onSubmit={(e) => { e.preventDefault(); void create(); }}><div className="row gap-4 wrap"><Field label="Name"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field><Field label="Save in"><select value={grant} onChange={(e) => setGrant(e.target.value)}>{writable.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}</select></Field></div><div className="row gap-2"><Button type="submit" variant="primary">Create</Button><Button type="button" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button></div></form>}
    <section><h2 className="dept-title">Recent spreadsheets</h2>{docs === null || busy ? <p className="muted"><Spinner /> Loading…</p> : docs.length === 0 ? <p className="muted">No spreadsheets yet. Create one or import a CSV file.</p> : <div className="doc-grid">{docs.map((d) => <button key={d.grant + d.path} className="doc-card" onClick={() => open({ grant: d.grant, path: d.path, name: d.name })}><span className="sheet-card-thumb">A B C<br />1&nbsp; ∑&nbsp; 42<br />2&nbsp; ∑&nbsp; 18</span><span className="doc-name ellipsis">{d.name.replace(/\.atlasheet$/, "")}</span><span className="doc-meta ellipsis">{d.label} · {d.modified_ms ? new Date(d.modified_ms).toLocaleDateString() : ""}</span></button>)}</div>}</section>
  </div>;
}
