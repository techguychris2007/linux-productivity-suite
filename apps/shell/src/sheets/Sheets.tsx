import React, { useCallback, useEffect, useRef, useState } from "react";
import { LuSheet, LuFilePlus, LuUpload, LuRefreshCw } from "react-icons/lu";
import type { FsEntry } from "@atlas/shared-types";
import { Button, EmptyState, Field, IconButton, Spinner } from "@atlas/ui";
import { useAtlas, type DocRef } from "../context";
import { newSheet, parseCsv } from "./model";
import { SheetEditor } from "./SheetEditor";

type Found = FsEntry & { grant: string; label: string };
const safeName = (s: string) => s.trim().replace(/[/\\]/g, "-").replace(/^\.+/, "") || "Untitled spreadsheet";

export function Sheets() {
  const { bridge, grants, notify, go, sheetTarget, openInSheets } = useAtlas();
  const [docs, setDocs] = useState<Found[] | null>(null);
  const [workbooks, setWorkbooks] = useState<Found[]>([]);
  const [importing, setImporting] = useState<string | null>(null);
  const [ref, setRef] = useState<DocRef | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("Untitled spreadsheet");
  const [grant, setGrant] = useState("");
  const busy = false;
  const inputRef = useRef<HTMLInputElement>(null);
  const writable = grants.filter((g) => g.access === "readwrite");
  useEffect(() => { if (!grant && writable[0]) setGrant(writable[0].id); }, [writable, grant]);

  const scan = useCallback(async () => {
    const results = await Promise.all(grants.map(async (g) => {
      const [sheets, books] = await Promise.all([
        bridge.core<FsEntry[]>("fs.search", { grant: g.id, query: ".atlasheet", limit: 200 }).catch(() => []),
        bridge.core<FsEntry[]>("fs.search", { grant: g.id, query: ".xlsx", limit: 200 }).catch(() => []),
      ]);
      return { sheets: sheets.filter((e) => e.kind === "file" && e.name.endsWith(".atlasheet")).map((e) => ({ ...e, grant: g.id, label: g.label })),
        books: books.filter((e) => e.kind === "file" && e.name.toLowerCase().endsWith(".xlsx")).map((e) => ({ ...e, grant: g.id, label: g.label })) };
    }));
    const found = results.flatMap((r) => r.sheets);
    found.sort((a, b) => (b.modified_ms ?? 0) - (a.modified_ms ?? 0)); setDocs(found);
    setWorkbooks(results.flatMap((r) => r.books).sort((a, b) => (b.modified_ms ?? 0) - (a.modified_ms ?? 0)));
  }, [bridge, grants]);
  useEffect(() => { scan(); }, [scan]);

  const open = async (item: DocRef & { name?: string }) => { setRef({ grant: item.grant, path: item.path }); };

  const create = async () => {
    const title = safeName(name); const path = `${title}.atlasheet`;
    try {
      await bridge.core("fs.write_text", { grant, path, content: JSON.stringify(newSheet(title), null, 1), overwrite: false });
      await open({ grant, path });
      setCreating(false); scan();
    } catch (e: any) { notify({ tone: "danger", title: "Could not create spreadsheet", body: e.message }); }
  };

  useEffect(() => { if (sheetTarget) void open(sheetTarget); }, [sheetTarget]);

  const importWorkbook = async (item: Found) => {
    const key = item.grant + item.path; setImporting(key);
    try {
      const result = await bridge.engine<{ path: string; title: string }>("POST", "/sheets/import", { grant: item.grant, path: item.path });
      notify({ tone: "success", title: `Imported ${item.name}`, body: `Created ${result.path}` });
      await open({ grant: item.grant, path: result.path, name: result.title }); scan();
    } catch (e: any) { notify({ tone: "danger", title: "Workbook import failed", body: e.message }); }
    finally { setImporting(null); }
  };

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

  if (ref) return <SheetEditor key={ref.grant + ref.path} docRef={ref} onClose={() => { setRef(null); openInSheets(null); scan(); }} />;

  if (!grants.length) return <div className="page"><EmptyState icon={<LuSheet />} title="Share a folder to start a spreadsheet" action={<Button variant="primary" onClick={() => go("settings:folders")}>Share a folder</Button>}>Sheets saves your work in folders you have shared with Atlas.</EmptyState></div>;
  return <div className="page sheet-home">
    <header className="row between wrap gap-2"><div><h1>Sheets</h1><p className="muted">Spreadsheets with formulas and CSV/XLSX import/export.</p></div><div className="row gap-2"><IconButton label="Refresh" onClick={scan}><LuRefreshCw /></IconButton><Button icon={<LuUpload />} onClick={() => inputRef.current?.click()} disabled={!writable.length}>Import CSV</Button><input ref={inputRef} className="visually-hidden" type="file" accept=".csv,text/csv" onChange={(e) => importCsv(e.target.files?.[0])} /><Button variant="primary" icon={<LuFilePlus />} onClick={() => setCreating(true)} disabled={!writable.length}>New spreadsheet</Button></div></header>
    {creating && <form className="card new-doc" onSubmit={(e) => { e.preventDefault(); void create(); }}><div className="row gap-4 wrap"><Field label="Name"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field><Field label="Save in"><select value={grant} onChange={(e) => setGrant(e.target.value)}>{writable.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}</select></Field></div><div className="row gap-2"><Button type="submit" variant="primary">Create</Button><Button type="button" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button></div></form>}
    <section><h2 className="dept-title">Recent spreadsheets</h2>{docs === null || busy ? <p className="muted"><Spinner /> Loading…</p> : docs.length === 0 ? <p className="muted">No spreadsheets yet. Create one or import a CSV file or Excel workbook.</p> : <div className="doc-grid">{docs.map((d) => <button key={d.grant + d.path} className="doc-card" onClick={() => open({ grant: d.grant, path: d.path, name: d.name })}><span className="sheet-card-thumb">A B C<br />1&nbsp; ∑&nbsp; 42<br />2&nbsp; ∑&nbsp; 18</span><span className="doc-name ellipsis">{d.name.replace(/\.atlasheet$/, "")}</span><span className="doc-meta ellipsis">{d.label} · {d.modified_ms ? new Date(d.modified_ms).toLocaleDateString() : ""}</span></button>)}</div>}</section>
    {workbooks.length > 0 && <section><h2 className="dept-title">Excel workbooks</h2><ul className="import-list">{workbooks.slice(0, 30).map((book) => <li key={book.grant + book.path}><LuSheet /><span className="ellipsis">{book.path}</span><span className="muted">{book.label}</span><Button size="sm" icon={importing === book.grant + book.path ? <Spinner size={12} /> : <LuUpload />} disabled={!!importing || !writable.some((g) => g.id === book.grant)} onClick={() => void importWorkbook(book)}>Import to Sheets</Button></li>)}</ul></section>}
  </div>;
}
