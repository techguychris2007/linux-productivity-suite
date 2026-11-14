import React, { useCallback, useEffect, useState } from "react";
import { LuFolder, LuFile, LuFileText, LuChevronRight, LuFolderPlus, LuPlus, LuTrash2, LuRefreshCw, LuHardDrive, LuSparkles, LuX, LuFileInput, LuSheet } from "react-icons/lu";
import type { FsEntry } from "@atlas/shared-types";
import { Badge, Button, EmptyState, IconButton, Spinner } from "@atlas/ui";
import { useAtlas } from "../context";

const TEXT_EXT = /\.(md|txt|csv|json|ya?ml|toml|ini|log|py|ts|tsx|js|rs|html|css|xml|sh)$/i;
const fmtSize = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const fmtDate = (ms: number | null) => ms ? new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

export function Drive() {
  const { bridge, grants, notify, go, askAi, openInWriter, openInSheets } = useAtlas();
  const [importing, setImporting] = useState(false);
  const [grantId, setGrantId] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ entry: FsEntry; content: string; truncated: boolean } | null>(null);
  const [naming, setNaming] = useState<null | "folder" | "file">(null);
  const [newName, setNewName] = useState("");

  useEffect(() => { if (!grantId && grants.length) setGrantId(grants[0].id); }, [grants, grantId]);
  const grant = grants.find((g) => g.id === grantId) ?? null;

  const load = useCallback(async () => {
    if (!grantId) return;
    setError(null); setEntries(null);
    try { setEntries(await bridge.core<FsEntry[]>("fs.list", { grant: grantId, path })); }
    catch (e: any) { setError(e.message); setEntries([]); }
  }, [bridge, grantId, path]);
  useEffect(() => { load(); setPreview(null); }, [load]);

  const open = async (e: FsEntry) => {
    if (e.kind === "dir") { setPath(e.path); return; }
    if (e.name.endsWith(".atlasdoc")) { openInWriter({ grant: grantId!, path: e.path }); return; }
    if (e.name.endsWith(".atlasheet")) { openInSheets({ grant: grantId!, path: e.path }); return; }
    if (!TEXT_EXT.test(e.name)) { setPreview({ entry: e, content: "", truncated: false }); return; }
    try {
      const r = await bridge.core<{ content: string; truncated: boolean }>("fs.read_text", { grant: grantId, path: e.path, max_bytes: 200_000 });
      setPreview({ entry: e, ...r });
    } catch (err: any) { notify({ tone: "warning", title: `Can't preview ${e.name}`, body: err.message }); }
  };

  const importToWriter = async (e: FsEntry) => {
    setImporting(true);
    try {
      const r = await bridge.engine<{ path: string }>("POST", "/writer/import", { grant: grantId, path: e.path });
      openInWriter({ grant: grantId!, path: r.path });
    } catch (err: any) { notify({ tone: "danger", title: "Couldn't open it in Writer", body: err.message }); }
    finally { setImporting(false); }
  };

  const create = async () => {
    const name = newName.trim();
    if (!name || name.includes("/") || name.startsWith(".")) { notify({ tone: "warning", title: "Use a simple name without '/' or a leading dot" }); return; }
    const target = path ? `${path}/${name}` : name;
    try {
      if (naming === "folder") await bridge.core("fs.mkdir", { grant: grantId, path: target });
      else await bridge.core("fs.write_text", { grant: grantId, path: target, content: "", overwrite: false });
      setNaming(null); setNewName(""); load();
    } catch (e: any) { notify({ tone: "danger", title: "Could not create it", body: e.message }); }
  };

  const trash = async (e: FsEntry) => {
    if (!window.confirm(`Move "${e.name}" to the Atlas trash? You can restore it from the trash folder.`)) return;
    try { await bridge.core("fs.trash", { grant: grantId, path: e.path }); notify({ tone: "success", title: `Moved ${e.name} to trash` }); load(); }
    catch (err: any) { notify({ tone: "danger", title: "Could not move to trash", body: err.message }); }
  };

  if (!grants.length) {
    return (
      <div className="page">
        <EmptyState icon={<LuHardDrive />} title="No folders shared yet"
          action={<Button variant="primary" onClick={() => go("settings")}>Share a folder</Button>}>
          Atlas can only see folders you explicitly share. Add one in Settings → Folders.
        </EmptyState>
      </div>
    );
  }

  const crumbs = path ? path.split("/") : [];
  return (
    <div className="page drive">
      <aside className="drive-side" aria-label="Shared folders">
        <div className="side-label">Shared folders</div>
        {grants.map((g) => (
          <button key={g.id} className={`drive-grant ${g.id === grantId ? "is-active" : ""}`} onClick={() => { setGrantId(g.id); setPath(""); }}>
            <LuFolder /><span className="ellipsis">{g.label}</span>
            {g.access === "read" && <Badge>read-only</Badge>}
          </button>
        ))}
      </aside>
      <section className="drive-main">
        <header className="drive-bar">
          <nav className="crumbs" aria-label="Path">
            <button onClick={() => setPath("")}>{grant?.label}</button>
            {crumbs.map((c, i) => (
              <React.Fragment key={i}><LuChevronRight className="crumb-sep" />
                <button onClick={() => setPath(crumbs.slice(0, i + 1).join("/"))}>{c}</button></React.Fragment>
            ))}
          </nav>
          <div className="row gap-2">
            {grant?.access === "readwrite" && <>
              <Button size="sm" icon={<LuFolderPlus />} onClick={() => setNaming("folder")}>New folder</Button>
              <Button size="sm" icon={<LuPlus />} onClick={() => setNaming("file")}>New text file</Button>
            </>}
            <IconButton label="Refresh" onClick={load}><LuRefreshCw /></IconButton>
          </div>
        </header>
        {naming && (
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); create(); }}>
            <input autoFocus placeholder={naming === "folder" ? "Folder name" : "File name, e.g. notes.md"} value={newName} onChange={(e) => setNewName(e.target.value)} />
            <Button size="sm" variant="primary" type="submit">Create</Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => { setNaming(null); setNewName(""); }}>Cancel</Button>
          </form>
        )}
        {error && <div className="banner banner-danger">{error}</div>}
        <div className={`drive-body ${preview ? "has-preview" : ""}`}>
          <div className="files-scroll"><table className="files">
            <colgroup><col /><col style={{ width: 90 }} /><col style={{ width: 190 }} /><col style={{ width: 48 }} /></colgroup>
            <thead><tr><th>Name</th><th className="num">Size</th><th>Modified</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {entries === null && <tr><td colSpan={4} className="muted"><Spinner /> Loading…</td></tr>}
              {entries?.length === 0 && !error && <tr><td colSpan={4} className="muted">This folder is empty.</td></tr>}
              {entries?.map((e) => (
                <tr key={e.path} className={preview?.entry.path === e.path ? "is-selected" : ""} onDoubleClick={() => open(e)}>
                  <td><button className="file-name" onClick={() => open(e)}>{e.kind === "dir" ? <LuFolder className="ic-folder" /> : e.name.endsWith(".atlasdoc") ? <LuFileText className="ic-doc" /> : <LuFile />}<span className="ellipsis">{e.name}</span></button></td>
                  <td className="num muted">{e.kind === "dir" ? "—" : fmtSize(e.size)}</td>
                  <td className="muted">{fmtDate(e.modified_ms)}</td>
                  <td className="actions">{grant?.access === "readwrite" && <IconButton label={`Move ${e.name} to trash`} onClick={() => trash(e)}><LuTrash2 /></IconButton>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          {preview && (
            <aside className="preview" aria-label="Preview">
              <header><strong className="ellipsis">{preview.entry.name}</strong><IconButton label="Close preview" onClick={() => setPreview(null)}><LuX /></IconButton></header>
              {preview.content || TEXT_EXT.test(preview.entry.name)
                ? <pre>{preview.content || "(empty file)"}{preview.truncated ? "\n…(truncated)" : ""}</pre>
                : /\.(docx?|odt|rtf)$/i.test(preview.entry.name) && grant?.access === "readwrite"
                  ? <div className="pad"><p className="muted">Word / OpenDocument file.</p><Button size="sm" variant="primary" icon={importing ? <Spinner size={12} /> : <LuFileInput />} disabled={importing} onClick={() => importToWriter(preview.entry)}>Open in Writer</Button></div>
                  : <p className="muted pad">No preview for this file type yet.</p>}
              {grant?.ai_allowed && (
                <footer><Button size="sm" icon={<LuSparkles />} onClick={() => askAi(`Summarise the file "${preview.entry.path}" in the shared folder "${grant.label}".`)}>Ask Atlas AI about this file</Button></footer>
              )}
            </aside>
          )}
        </div>
      </section>
    </div>
  );
}
