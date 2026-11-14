import React, { useCallback, useEffect, useState } from "react";
import { LuFileText, LuFilePlus, LuFileInput, LuRefreshCw } from "react-icons/lu";
import type { FsEntry } from "@atlas/shared-types";
import { Badge, Button, EmptyState, Field, IconButton, Spinner } from "@atlas/ui";
import { useAtlas } from "../context";
import { Editor } from "./Editor";
import { newDoc } from "./model";

type Found = FsEntry & { grant: string; label: string };
const IMPORT_EXT = [".docx", ".odt", ".rtf", ".doc"];

export function Writer() {
  const { writerTarget, openInWriter } = useAtlas();
  if (writerTarget) return <Editor key={writerTarget.grant + writerTarget.path} docRef={writerTarget} onClose={() => openInWriter(null)} />;
  return <WriterHome />;
}

function WriterHome() {
  const { bridge, grants, notify, openInWriter, go } = useAtlas();
  const [docs, setDocs] = useState<Found[] | null>(null);
  const [importable, setImportable] = useState<Found[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("Untitled document");
  const [grant, setGrant] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const writable = grants.filter((g) => g.access === "readwrite");
  useEffect(() => { if (!grant && writable[0]) setGrant(writable[0].id); }, [writable, grant]);

  const scan = useCallback(async () => {
    const search = async (q: string) => (await Promise.all(grants.map((g) =>
      bridge.core<FsEntry[]>("fs.search", { grant: g.id, query: q, limit: 200 }).then((r) => r.map((e) => ({ ...e, grant: g.id, label: g.label }))).catch(() => [])))).flat();
    const found = (await search(".atlasdoc")).filter((e) => e.kind === "file" && e.name.endsWith(".atlasdoc"));
    found.sort((a, b) => (b.modified_ms ?? 0) - (a.modified_ms ?? 0));
    setDocs(found);
    const imp = (await Promise.all(IMPORT_EXT.map(search))).flat().filter((e) => e.kind === "file" && IMPORT_EXT.some((x) => e.name.toLowerCase().endsWith(x)));
    const unique = [...new Map(imp.map((e) => [e.grant + "/" + e.path, e])).values()];
    setImportable(unique.slice(0, 30));
  }, [bridge, grants]);
  useEffect(() => { scan(); }, [scan]);

  const create = async () => {
    const clean = name.trim().replace(/[/\\]/g, "-").replace(/^\.+/, "") || "Untitled document";
    let path = `${clean}.atlasdoc`;
    for (let i = 1; docs?.some((d) => d.grant === grant && d.path === path); i++) path = `${clean} (${i}).atlasdoc`;
    try {
      await bridge.core("fs.write_text", { grant, path, content: JSON.stringify(newDoc(clean), null, 1), overwrite: false });
      openInWriter({ grant, path });
    } catch (e: any) { notify({ tone: "danger", title: "Couldn't create the document", body: e.message }); }
  };

  const doImport = async (f: Found) => {
    setBusy(f.grant + f.path);
    try {
      const r = await bridge.engine<{ path: string; words: number }>("POST", "/writer/import", { grant: f.grant, path: f.path });
      notify({ tone: "success", title: `Imported ${f.name}`, body: `${r.words} words → ${r.path}` });
      openInWriter({ grant: f.grant, path: r.path });
    } catch (e: any) { notify({ tone: "danger", title: "Import failed", body: e.message }); }
    finally { setBusy(null); }
  };

  if (!grants.length) {
    return <div className="page"><EmptyState icon={<LuFileText />} title="Share a folder to start writing"
      action={<Button variant="primary" onClick={() => go("settings:folders")}>Share a folder</Button>}>Writer keeps your documents in folders you've shared with Atlas.</EmptyState></div>;
  }

  return (
    <div className="page writer-home">
      <header className="row between wrap gap-2">
        <div><h1>Writer</h1><p className="muted">Documents in your shared folders. Export to Word, PDF or ODT at any time.</p></div>
        <div className="row gap-2">
          <IconButton label="Refresh" onClick={scan}><LuRefreshCw /></IconButton>
          <Button variant="primary" icon={<LuFilePlus />} onClick={() => setCreating(true)} disabled={!writable.length}>New document</Button>
        </div>
      </header>

      {creating && (
        <form className="card new-doc" onSubmit={(e) => { e.preventDefault(); create(); }}>
          <div className="row gap-4 wrap">
            <Field label="Name"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Save in">
              <select value={grant} onChange={(e) => setGrant(e.target.value)}>{writable.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}</select>
            </Field>
          </div>
          <div className="row gap-2"><Button variant="primary" type="submit">Create</Button><Button variant="ghost" type="button" onClick={() => setCreating(false)}>Cancel</Button></div>
        </form>
      )}

      <section>
        <h2 className="dept-title">Recent documents</h2>
        {docs === null ? <p className="muted"><Spinner /> Looking for documents…</p> : docs.length === 0 ? (
          <p className="muted">No documents yet. Create one, import a Word file, or ask Atlas AI to write one.</p>
        ) : (
          <div className="doc-grid">
            {docs.map((d) => (
              <button key={d.grant + d.path} className="doc-card" onClick={() => openInWriter({ grant: d.grant, path: d.path })}>
                <span className="doc-thumb"><span /><span /><span /><span /></span>
                <span className="doc-name ellipsis">{d.name.replace(/\.atlasdoc$/, "")}</span>
                <span className="doc-meta ellipsis">{d.label}{d.path.includes("/") ? ` / ${d.path.slice(0, d.path.lastIndexOf("/"))}` : ""} · {d.modified_ms ? new Date(d.modified_ms).toLocaleDateString() : ""}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {importable.length > 0 && (
        <section>
          <h2 className="dept-title">Word and OpenDocument files you can import</h2>
          <ul className="import-list">
            {importable.map((f) => (
              <li key={f.grant + f.path}>
                <LuFileText /><span className="ellipsis">{f.path}</span><Badge>{f.label}</Badge>
                <Button size="sm" icon={busy === f.grant + f.path ? <Spinner size={12} /> : <LuFileInput />} disabled={!!busy} onClick={() => doImport(f)}>Open in Writer</Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
