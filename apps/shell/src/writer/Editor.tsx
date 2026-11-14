import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  LuBold, LuItalic, LuUnderline, LuStrikethrough, LuLink, LuList, LuListOrdered, LuQuote, LuTable, LuSeparatorHorizontal,
  LuAlignLeft, LuAlignCenter, LuAlignRight, LuUndo2, LuRedo2, LuDownload, LuArrowLeft, LuSparkles, LuTrash2, LuPlus, LuMinus, LuCheck, LuRefreshCw,
} from "react-icons/lu";
import type { EngineEvent } from "@atlas/shared-types";
import { Button, IconButton, Spinner } from "@atlas/ui";
import { useAtlas, type DocRef } from "../context";
import { type AtlasDoc, type Block, type TextType, type Align, STYLE_LABELS, TEXT_TYPES, block, isText, sanitize, wordCount, plainText } from "./model";

type SaveState = "saved" | "dirty" | "saving" | "error";
type Caret = { id: string; at: "start" | "end" } | null;

export function Editor({ docRef, onClose }: { docRef: DocRef; onClose: () => void }) {
  const { bridge, notify, setActiveDoc, askAi, grants } = useAtlas();
  const [doc, setDoc] = useState<AtlasDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>("saved");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [caret, setCaret] = useState<Caret>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [externalChange, setExternalChange] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("https://");
  const savedRange = useRef<Range | null>(null);
  const past = useRef<AtlasDoc[]>([]);
  const future = useRef<AtlasDoc[]>([]);
  const lastSnap = useRef(0);
  const saveTimer = useRef<number>();
  const docRefLatest = useRef<AtlasDoc | null>(null);
  docRefLatest.current = doc;
  const mounted = useRef(Date.now() / 1000);
  const grantLabel = grants.find((g) => g.id === docRef.grant)?.label ?? "";

  // ---------- load ----------
  const load = useCallback(async (opts?: { flashChanges?: boolean }) => {
    try {
      const r = await bridge.core<{ content: string }>("fs.read_text", { grant: docRef.grant, path: docRef.path });
      const d = JSON.parse(r.content) as AtlasDoc;
      if (d.format !== "atlas.doc") throw new Error("This file is not an Atlas document.");
      if (opts?.flashChanges && docRefLatest.current) {
        const before = new Map(docRefLatest.current.blocks.map((b) => [b.id, JSON.stringify(b)]));
        const changed = new Set(d.blocks.filter((b) => before.get(b.id) !== JSON.stringify(b)).map((b) => b.id));
        setFlash(changed);
        window.setTimeout(() => setFlash(new Set()), 2400);
      }
      docRefLatest.current = d; setDoc(d); setSave("saved"); setError(null); setExternalChange(false);
    } catch (e: any) { setError(e.message); }
  }, [bridge, docRef]);
  useEffect(() => { load(); past.current = []; future.current = []; }, [load]);

  useEffect(() => {
    if (doc) setActiveDoc({ ...docRef, app: "writer", title: doc.title });
    return () => setActiveDoc(null);
  }, [docRef, doc?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- live updates from Atlas AI (one subscription per open document) ----------
  const saveRef = useRef<SaveState>("saved");
  saveRef.current = save;
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => bridge.subscribe(0, (ev: EngineEvent) => {
    if (ev.type !== "resource.changed" || ev.ts < mounted.current) return;
    if (ev.data.grant !== docRef.grant || ev.data.path !== docRef.path) return;
    if (saveRef.current === "saved") { loadRef.current({ flashChanges: true }); notify({ tone: "info", title: "Atlas AI updated this document" }); }
    else setExternalChange(true);
  }, () => {}), [bridge, docRef, notify]);

  // ---------- save ----------
  const persist = useCallback(async () => {
    const d = docRefLatest.current;
    if (!d) return;
    window.clearTimeout(saveTimer.current);
    setSave("saving");
    const title = plainText(d.blocks.find((b) => b.type === "title")?.html) || d.title;
    const clean: AtlasDoc = { ...d, title };
    try {
      await bridge.core("fs.write_text", { grant: docRef.grant, path: docRef.path, content: JSON.stringify(clean, null, 1), overwrite: true, backup: false });
      setSave((s) => (docRefLatest.current === d ? "saved" : s === "saving" ? "dirty" : s));
    } catch (e: any) { setSave("error"); notify({ tone: "danger", title: "Couldn't save", body: e.message }); }
  }, [bridge, docRef, notify]);

  const update = useCallback((fn: (d: AtlasDoc) => AtlasDoc, opts?: { snapshot?: boolean }) => {
    const d = docRefLatest.current;
    if (!d) return;
    const now = Date.now();
    if (opts?.snapshot || now - lastSnap.current > 800) {
      past.current.push(d); if (past.current.length > 200) past.current.shift();
      future.current = []; lastSnap.current = now;
    }
    const nd = fn(d);
    docRefLatest.current = nd;
    setDoc(nd);
    setSave("dirty");
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => persist(), 900);
  }, [persist]);
  useEffect(() => () => { window.clearTimeout(saveTimer.current); }, []);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => { if (save !== "saved") e.preventDefault(); };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [save]);

  const jump = (to: AtlasDoc | undefined, from: AtlasDoc[]) => {
    const cur = docRefLatest.current;
    if (!to || !cur) return;
    from.push(cur); docRefLatest.current = to; setDoc(to); setSave("dirty");
    window.clearTimeout(saveTimer.current); saveTimer.current = window.setTimeout(persist, 900);
  };
  const undo = () => jump(past.current.pop(), future.current);
  const redo = () => jump(future.current.pop(), past.current);

  // ---------- block operations ----------
  const idx = (id: string) => doc?.blocks.findIndex((b) => b.id === id) ?? -1;
  const setBlock = (id: string, patch: Partial<Block>, snapshot = false) =>
    update((d) => ({ ...d, blocks: d.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) }), { snapshot });
  const insertAfter = (id: string | null, nb: Block, at: "start" | "end" = "start") => {
    update((d) => {
      const i = id ? d.blocks.findIndex((b) => b.id === id) : d.blocks.length - 1;
      const blocks = [...d.blocks]; blocks.splice(i + 1, 0, nb);
      return { ...d, blocks };
    }, { snapshot: true });
    setCaret({ id: nb.id, at }); setFocusId(nb.id);
  };
  const remove = (id: string, focusPrev = true) => {
    const i = idx(id);
    update((d) => {
      const blocks = d.blocks.filter((b) => b.id !== id);
      return { ...d, blocks: blocks.length ? blocks : [block("paragraph")] };
    }, { snapshot: true });
    if (focusPrev && doc) {
      const prev = [...doc.blocks.slice(0, Math.max(i, 0))].reverse().find((b) => isText(b.type));
      if (prev) { setCaret({ id: prev.id, at: "end" }); setFocusId(prev.id); }
    }
  };

  const onSplit = (b: Block, before: string, after: string) => {
    const listy = b.type === "bullet" || b.type === "numbered";
    if (listy && !plainText(before).trim() && !plainText(after).trim()) { setBlock(b.id, { type: "paragraph" }, true); return; }
    const nextType: TextType = listy ? (b.type as TextType) : b.type === "quote" ? "quote" : "paragraph";
    const nb: Block = { ...block(nextType), html: after, ...(b.align && nextType === b.type ? { align: b.align } : {}) };
    update((d) => {
      const i = d.blocks.findIndex((x) => x.id === b.id);
      const blocks = [...d.blocks];
      blocks[i] = { ...blocks[i], html: before };
      blocks.splice(i + 1, 0, nb);
      return { ...d, blocks };
    }, { snapshot: true });
    setCaret({ id: nb.id, at: "start" }); setFocusId(nb.id);
  };

  const onMergeBack = (b: Block, html: string) => {
    if (!doc) return;
    if (b.type !== "paragraph" && b.type !== "title") { setBlock(b.id, { type: "paragraph" }, true); return; }
    const i = idx(b.id);
    const prev = doc.blocks[i - 1];
    if (!prev) return;
    if (!isText(prev.type)) { if (!plainText(html).trim()) remove(b.id); return; }
    update((d) => ({ ...d, blocks: d.blocks.filter((x) => x.id !== b.id).map((x) => (x.id === prev.id ? { ...x, html: (x.html ?? "") + html } : x)) }), { snapshot: true });
    setCaret({ id: prev.id, at: "end" }); setFocusId(prev.id);
  };

  const focused = doc?.blocks.find((b) => b.id === focusId) ?? null;
  const setType = (t: TextType) => { if (focused && isText(focused.type)) setBlock(focused.id, { type: t }, true); };
  const setAlign = (a: Align) => { if (focused && isText(focused.type)) setBlock(focused.id, { align: a === "left" ? undefined : a }, true); };
  const exec = (cmd: string, value?: string) => { document.execCommand(cmd, false, value); };
  const insertBlock = (nb: Block) => insertAfter(focusId ?? doc?.blocks[doc.blocks.length - 1]?.id ?? null, nb);

  const applyLink = () => {
    const sel = window.getSelection();
    if (savedRange.current && sel) { sel.removeAllRanges(); sel.addRange(savedRange.current); }
    if (/^(https?:\/\/|mailto:)\S+$/i.test(linkUrl)) exec("createLink", linkUrl);
    else notify({ tone: "warning", title: "Links must start with https://, http:// or mailto:" });
    setLinkOpen(false); setLinkUrl("https://");
  };

  const doExport = async (format: "docx" | "pdf" | "odt") => {
    setExporting(format);
    try {
      await persist();
      const r = await bridge.engine<{ path: string }>("POST", "/writer/export", { grant: docRef.grant, path: docRef.path, format });
      notify({ tone: "success", title: `Exported ${r.path}`, body: `Saved in ${grantLabel}` });
    } catch (e: any) { notify({ tone: "danger", title: "Export failed", body: e.message }); }
    finally { setExporting(null); }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "s") { e.preventDefault(); persist(); }
      else if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const words = useMemo(() => (doc ? wordCount(doc) : 0), [doc]);

  if (error) return <div className="page"><div className="banner banner-danger">{error}</div><Button icon={<LuArrowLeft />} onClick={onClose}>Back to documents</Button></div>;
  if (!doc) return <div className="page muted"><Spinner /> Opening…</div>;

  let n = 0;
  return (
    <div className="writer">
      <div className="w-toolbar" role="toolbar" aria-label="Formatting" onMouseDown={(e) => { if ((e.target as HTMLElement).closest("button")) e.preventDefault(); }}>
        <IconButton label="Back to documents" onClick={async () => { await persist(); onClose(); }}><LuArrowLeft /></IconButton>
        <span className="w-sep" />
        <IconButton label="Undo (Ctrl Z)" onClick={undo} disabled={!past.current.length}><LuUndo2 /></IconButton>
        <IconButton label="Redo (Ctrl Shift Z)" onClick={redo} disabled={!future.current.length}><LuRedo2 /></IconButton>
        <span className="w-sep" />
        <select aria-label="Paragraph style" value={focused && isText(focused.type) ? focused.type : ""} disabled={!focused || !isText(focused.type)}
          onChange={(e) => setType(e.target.value as TextType)}>
          {!focused || !isText(focused.type) ? <option value="">Style</option> : null}
          {TEXT_TYPES.map((t) => <option key={t} value={t}>{STYLE_LABELS[t]}</option>)}
        </select>
        <span className="w-sep" />
        <IconButton label="Bold (Ctrl B)" onClick={() => exec("bold")}><LuBold /></IconButton>
        <IconButton label="Italic (Ctrl I)" onClick={() => exec("italic")}><LuItalic /></IconButton>
        <IconButton label="Underline (Ctrl U)" onClick={() => exec("underline")}><LuUnderline /></IconButton>
        <IconButton label="Strikethrough" onClick={() => exec("strikeThrough")}><LuStrikethrough /></IconButton>
        <div className="w-link">
          <IconButton label="Link" onClick={() => { const s = window.getSelection(); savedRange.current = s && s.rangeCount ? s.getRangeAt(0).cloneRange() : null; setLinkOpen(!linkOpen); }}><LuLink /></IconButton>
          {linkOpen && (
            <form className="popover w-link-pop" onSubmit={(e) => { e.preventDefault(); applyLink(); }}>
              <input autoFocus aria-label="Link address" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} />
              <Button size="sm" variant="primary" type="submit">Apply</Button>
            </form>
          )}
        </div>
        <span className="w-sep" />
        <IconButton label="Bulleted list" active={focused?.type === "bullet"} onClick={() => setType(focused?.type === "bullet" ? "paragraph" : "bullet")}><LuList /></IconButton>
        <IconButton label="Numbered list" active={focused?.type === "numbered"} onClick={() => setType(focused?.type === "numbered" ? "paragraph" : "numbered")}><LuListOrdered /></IconButton>
        <IconButton label="Quote" active={focused?.type === "quote"} onClick={() => setType(focused?.type === "quote" ? "paragraph" : "quote")}><LuQuote /></IconButton>
        <span className="w-sep" />
        <IconButton label="Align left" active={!!focused && !focused.align} onClick={() => setAlign("left")}><LuAlignLeft /></IconButton>
        <IconButton label="Align centre" active={focused?.align === "center"} onClick={() => setAlign("center")}><LuAlignCenter /></IconButton>
        <IconButton label="Align right" active={focused?.align === "right"} onClick={() => setAlign("right")}><LuAlignRight /></IconButton>
        <span className="w-sep" />
        <IconButton label="Insert table" onClick={() => insertBlock(block("table"))}><LuTable /></IconButton>
        <IconButton label="Insert page break" onClick={() => insertBlock(block("pagebreak"))}><LuSeparatorHorizontal /></IconButton>
        <div className="w-spacer" />
        <div className="w-export">
          <Button size="sm" icon={exporting ? <Spinner size={12} /> : <LuDownload />} disabled={!!exporting} aria-haspopup="menu" aria-expanded={exportOpen}
            onClick={() => setExportOpen(!exportOpen)}>{exporting ? `Exporting ${exporting.toUpperCase()}…` : "Export"}</Button>
          {exportOpen && (
            <div className="popover w-export-menu" role="menu">
              {([["docx", "Word document (.docx)"], ["pdf", "PDF (.pdf)"], ["odt", "OpenDocument (.odt)"]] as const).map(([f, label]) => (
                <button key={f} role="menuitem" onClick={() => { setExportOpen(false); doExport(f); }}>{label}</button>
              ))}
            </div>
          )}
        </div>
      </div>

      {externalChange && (
        <div className="banner banner-info w-banner">Atlas AI changed this document while you were editing.
          <Button size="sm" icon={<LuRefreshCw />} onClick={() => load({ flashChanges: true })}>Load its version</Button>
        </div>
      )}

      <div className="w-canvas" onMouseDown={(e) => {
        if (e.target === e.currentTarget && doc.blocks.length) { const last = doc.blocks[doc.blocks.length - 1]; if (isText(last.type)) { setCaret({ id: last.id, at: "end" }); setFocusId(last.id); e.preventDefault(); } else insertAfter(last.id, block("paragraph")); }
      }}>
        <article className={`w-page w-page-${doc.page.size}`} aria-label={doc.title}>
          {doc.blocks.map((b) => {
            n = b.type === "numbered" ? n + 1 : 0;
            const cls = `${flash.has(b.id) ? "ai-flash" : ""} ${b.id === focusId ? "is-focused" : ""}`;
            if (b.type === "table") return <TableBlock key={b.id} b={b} cls={cls} onFocus={() => setFocusId(b.id)} onChange={(rows, snap) => setBlock(b.id, { rows }, snap)} onDelete={() => remove(b.id, false)} />;
            if (b.type === "pagebreak") return (
              <div key={b.id} className={`w-pagebreak ${cls}`} contentEditable={false}><span>Page break</span>
                <IconButton label="Remove page break" onClick={() => remove(b.id, false)}><LuTrash2 /></IconButton></div>
            );
            return (
              <TextBlock key={b.id} b={b} number={n} cls={cls} caret={caret?.id === b.id ? caret.at : null} onCaretDone={() => setCaret(null)}
                onFocus={() => setFocusId(b.id)} onChange={(html) => setBlock(b.id, { html })}
                onSplit={(before, after) => onSplit(b, before, after)} onMergeBack={(html) => onMergeBack(b, html)} />
            );
          })}
        </article>
      </div>

      <footer className="w-status">
        <span>{grantLabel} / {docRef.path}</span>
        <span>{words.toLocaleString()} words</span>
        <span className={`w-save w-save-${save}`} aria-live="polite">
          {save === "saved" && <><LuCheck /> Saved</>}{save === "saving" && <><Spinner size={11} /> Saving…</>}
          {save === "dirty" && "Unsaved changes"}{save === "error" && "Not saved"}
        </span>

        <button className="link" onClick={() => askAi(`In the open document "${docRef.path}", `)}><LuSparkles /> Ask Atlas AI about this document</button>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function caretAtStart(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  return r.toString().length === 0 && !r.cloneContents().querySelector?.("br");
}

function placeCaret(el: HTMLElement, at: "start" | "end") {
  el.focus();
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(at === "start");
  const s = window.getSelection();
  s?.removeAllRanges(); s?.addRange(r);
}

function TextBlock({ b, number, cls, caret, onCaretDone, onFocus, onChange, onSplit, onMergeBack }: {
  b: Block; number: number; cls: string; caret: "start" | "end" | null; onCaretDone: () => void; onFocus: () => void;
  onChange: (html: string) => void; onSplit: (before: string, after: string) => void; onMergeBack: (html: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Only push model HTML into the DOM when it differs (keeps the caret stable while typing).
  useLayoutEffect(() => {
    const el = ref.current!;
    if (sanitize(el.innerHTML) !== (b.html ?? "")) el.innerHTML = b.html ?? "";
  }, [b.html, b.type]); // type changes swap the element (div ↔ h2), so re-sync then too
  useLayoutEffect(() => { if (caret && ref.current) { placeCaret(ref.current, caret); onCaretDone(); } }, [caret]); // eslint-disable-line

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = ref.current!;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!range.collapsed) range.deleteContents();
      const tail = document.createRange();
      tail.setStart(range.endContainer, range.endOffset);
      tail.setEnd(el, el.childNodes.length);
      const holder = document.createElement("div");
      holder.appendChild(tail.extractContents());
      const before = sanitize(el.innerHTML), after = sanitize(holder.innerHTML);
      el.innerHTML = before;
      onSplit(before, after);
    } else if (e.key === "Backspace" && caretAtStart(el)) {
      e.preventDefault();
      onMergeBack(sanitize(el.innerHTML));
    }
  };

  const Tag = (b.type === "title" ? "h1" : b.type === "heading1" ? "h2" : b.type === "heading2" ? "h3" : b.type === "heading3" ? "h4" : "div") as any;
  const placeholder = b.type === "title" ? "Title" : b.type.startsWith("heading") ? "Heading" : b.type === "paragraph" ? "Type here, or ask Atlas AI to write it…" : "";
  return (
    <Tag ref={ref} className={`wb wb-${b.type} ${cls}`} data-number={b.type === "numbered" ? `${number}.` : undefined}
      style={b.align ? { textAlign: b.align } : undefined} contentEditable suppressContentEditableWarning spellCheck
      role="textbox" aria-multiline="true" aria-label={STYLE_LABELS[b.type as TextType]} data-placeholder={placeholder}
      onFocus={onFocus} onKeyDown={onKeyDown}
      onInput={() => onChange(sanitize(ref.current!.innerHTML))}
      onPaste={(e: React.ClipboardEvent) => {
        e.preventDefault();
        const html = e.clipboardData.getData("text/html");
        const text = e.clipboardData.getData("text/plain");
        document.execCommand("insertHTML", false, html ? sanitize(html) : text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!)).replace(/\n/g, "<br>"));
      }} />
  );
}

function TableBlock({ b, cls, onFocus, onChange, onDelete }: { b: Block; cls: string; onFocus: () => void; onChange: (rows: string[][], snap: boolean) => void; onDelete: () => void }) {
  const rows = b.rows ?? [[""]];
  const cols = rows[0]?.length ?? 1;
  const set = (r: number, c: number, html: string) => onChange(rows.map((row, i) => (i === r ? row.map((cell, j) => (j === c ? html : cell)) : row)), false);
  return (
    <div className={`w-table ${cls}`} onFocus={onFocus}>
      <table><tbody>
        {rows.map((row, r) => (
          <tr key={r}>{row.map((cell, c) => <Cell key={c} html={cell} header={r === 0} onChange={(h) => set(r, c, h)} label={`Row ${r + 1}, column ${c + 1}`} />)}</tr>
        ))}
      </tbody></table>
      <div className="w-table-tools" onMouseDown={(e) => e.preventDefault()}>
        <Button size="sm" variant="ghost" icon={<LuPlus />} onClick={() => onChange([...rows, Array(cols).fill("")], true)}>Row</Button>
        <Button size="sm" variant="ghost" icon={<LuPlus />} onClick={() => onChange(rows.map((x) => [...x, ""]), true)}>Column</Button>
        <Button size="sm" variant="ghost" icon={<LuMinus />} disabled={rows.length < 2} onClick={() => onChange(rows.slice(0, -1), true)}>Row</Button>
        <Button size="sm" variant="ghost" icon={<LuMinus />} disabled={cols < 2} onClick={() => onChange(rows.map((x) => x.slice(0, -1)), true)}>Column</Button>
        <IconButton label="Delete table" onClick={onDelete}><LuTrash2 /></IconButton>
      </div>
    </div>
  );
}

function Cell({ html, header, onChange, label }: { html: string; header: boolean; onChange: (h: string) => void; label: string }) {
  const ref = useRef<HTMLTableCellElement>(null);
  useLayoutEffect(() => { const el = ref.current!; if (sanitize(el.innerHTML) !== html) el.innerHTML = html; }, [html]);
  return <td ref={ref} className={header ? "is-header" : ""} contentEditable suppressContentEditableWarning aria-label={label}
    onInput={() => onChange(sanitize(ref.current!.innerHTML))}
    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) e.preventDefault(); }} />;
}
