import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  LuBold, LuItalic, LuUnderline, LuStrikethrough, LuLink, LuList, LuListOrdered, LuQuote, LuTable, LuSeparatorHorizontal,
  LuAlignLeft, LuAlignCenter, LuAlignRight, LuAlignJustify, LuUndo2, LuRedo2, LuDownload, LuArrowLeft, LuSparkles, LuTrash2, LuPlus, LuMinus, LuCheck, LuRefreshCw,
  LuSubscript, LuSuperscript, LuRemoveFormatting, LuFile, LuFileText, LuFileDown, LuZoomIn, LuZoomOut, LuSearch, LuInfo, LuX, LuReplace, LuBaseline, LuHighlighter, LuImage,
} from "react-icons/lu";
import { Ribbon, RBig, RSmall, RStack, RRow, BackstageSection, Zoom, type RibbonTab } from "../ribbon/Ribbon";
import type { EngineEvent } from "@atlas/shared-types";
import { Button, IconButton, Spinner } from "@atlas/ui";
import { useAtlas, type DocRef } from "../context";
import { type AtlasDoc, type Block, type DocComment, type TextType, type Align, STYLE_LABELS, TEXT_TYPES, FONT_FAMILIES, block, isText, sanitize, wordCount, plainText, newId } from "./model";

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
  const [zoom, setZoom] = useState(100);
  const [fontFamily, setFontFamily] = useState<string>("Arial");
  const [fontSize, setFontSize] = useState("12pt");
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState<{ blockId: string; quote: string } | null>(null);
  const [commentText, setCommentText] = useState("");
  const [findOpen, setFindOpen] = useState<null | "find" | "replace">(null);
  const [ribbonTab, setRibbonTab] = useState("home");
  const pictureInput = useRef<HTMLInputElement>(null);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [matchCase, setMatchCase] = useState(false);
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
    if (!d) return false;
    window.clearTimeout(saveTimer.current);
    setSave("saving");
    const title = plainText(d.blocks.find((b) => b.type === "title")?.html) || d.title;
    const clean: AtlasDoc = { ...d, title };
    try {
      await bridge.core("fs.write_text", { grant: docRef.grant, path: docRef.path, content: JSON.stringify(clean, null, 1), overwrite: true, backup: false });
      setSave((s) => (docRefLatest.current === d ? "saved" : s === "saving" ? "dirty" : s));
      return true;
    } catch (e: any) { setSave("error"); notify({ tone: "danger", title: "Couldn't save", body: e.message }); return false; }
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
      return { ...d, blocks: blocks.length ? blocks : [block("paragraph")], comments: (d.comments ?? []).filter((c) => c.blockId !== id) };
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
    update((d) => ({ ...d, blocks: d.blocks.filter((x) => x.id !== b.id).map((x) => (x.id === prev.id ? { ...x, html: (x.html ?? "") + html } : x)),
      comments: (d.comments ?? []).map((c) => c.blockId === b.id ? { ...c, blockId: prev.id } : c) }), { snapshot: true });
    setCaret({ id: prev.id, at: "end" }); setFocusId(prev.id);
  };

  const focused = doc?.blocks.find((b) => b.id === focusId) ?? null;
  const setType = (t: TextType) => { if (focused && isText(focused.type)) setBlock(focused.id, { type: t }, true); };
  const setAlign = (a: Align) => { if (focused && isText(focused.type)) setBlock(focused.id, { align: a === "left" ? undefined : a }, true); };
  const setPageText = (field: "header" | "footer", value: string) =>
    update((d) => ({ ...d, page: { ...d.page, [field]: value.slice(0, 300) } }));
  const beginComment = () => {
    const range = savedRange.current;
    const node = range?.commonAncestorContainer;
    const blockEl = node && (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-block-id]");
    const blockId = blockEl?.dataset.blockId ?? (focused && isText(focused.type) ? focused.id : "");
    if (!blockId || !doc?.blocks.some((b) => b.id === blockId && isText(b.type))) {
      notify({ tone: "info", title: "Place the cursor in a text paragraph to add a comment" });
      return;
    }
    const quote = range && !range.collapsed ? range.toString().slice(0, 500) : "";
    setCommentDraft({ blockId, quote }); setCommentText(""); setCommentsOpen(true);
  };
  const addComment = () => {
    if (!commentDraft || !commentText.trim()) return;
    const item: DocComment = { id: newId(), blockId: commentDraft.blockId, text: commentText.trim().slice(0, 3000), quote: commentDraft.quote || undefined };
    update((d) => ({ ...d, comments: [...(d.comments ?? []), item] }), { snapshot: true });
    setCommentDraft(null); setCommentText("");
  };
  const setCommentResolved = (id: string, resolved: boolean) =>
    update((d) => ({ ...d, comments: (d.comments ?? []).map((c) => c.id === id ? { ...c, resolved } : c) }), { snapshot: true });
  const deleteComment = (id: string) =>
    update((d) => ({ ...d, comments: (d.comments ?? []).filter((c) => c.id !== id) }), { snapshot: true });
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
      if (!await persist()) return;
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
      else if (k === "f" || k === "h") { e.preventDefault(); setFindOpen(k === "h" ? "replace" : "find"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const words = useMemo(() => (doc ? wordCount(doc) : 0), [doc]);
  const chars = useMemo(() => (doc ? doc.blocks.reduce((n, b) => n + plainText(b.html ?? "").length + (b.rows ?? []).flat().reduce((m, c) => m + plainText(c).length, 0), 0) : 0), [doc]);

  if (error) return <div className="page"><div className="banner banner-danger">{error}</div><Button icon={<LuArrowLeft />} onClick={onClose}>Back to documents</Button></div>;
  if (!doc) return <div className="page muted"><Spinner /> Opening…</div>;

  let n = 0;
  const textFocused = !!focused && isText(focused.type);
  const saveLabel = save === "saved" ? <><LuCheck /> Saved to {grantLabel}</> : save === "saving" ? "Saving…" : save === "dirty" ? "Unsaved changes" : "Not saved";
  const close = async () => { if (await persist()) onClose(); };
  const exportTiles = (
    <div className="rb-bs-tiles">
      {([["docx", "Word document", ".docx — opens in Microsoft Word and LibreOffice"], ["pdf", "PDF", ".pdf — fixed layout for sharing and printing"], ["odt", "OpenDocument text", ".odt — LibreOffice's native format"]] as const).map(([f, label, hint]) => (
        <button key={f} className="rb-bs-tile" disabled={!!exporting} onClick={() => doExport(f)}>
          {exporting === f ? <Spinner size={20} /> : <LuFileDown />}<strong>{label}</strong><span>{hint}</span>
        </button>
      ))}
    </div>
  );
  // ---------- find & replace (text only; formatting tags are left intact) ----------
  const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const findRe = findText ? new RegExp(escRe(findText), matchCase ? "g" : "gi") : null;
  const matches = findRe ? doc.blocks.reduce((n, b0) => n + (plainText(b0.html ?? "").match(findRe)?.length ?? 0) + (b0.rows ?? []).flat().reduce((m, c) => m + (plainText(c).match(findRe)?.length ?? 0), 0), 0) : 0;
  const replaceInHtml = (html: string, re: RegExp, to: string) => {
    const box = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html").body.firstElementChild!;
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) n.textContent = (n.textContent ?? "").replace(re, () => to);
    return sanitize(box.innerHTML);
  };
  const findNext = () => {
    if (!findText) return;
    const w = window as any;
    if (typeof w.find === "function" && (w.find(findText, matchCase, false, true) || w.find(findText, matchCase, false, true))) return;
    notify({ tone: "info", title: matches ? `${matches} matches` : `"${findText}" was not found` });
  };
  const replaceOne = () => {
    const sel = window.getSelection();
    const selected = sel?.toString() ?? "";
    if (findText && (matchCase ? selected === findText : selected.toLowerCase() === findText.toLowerCase())) document.execCommand("insertText", false, replaceText);
    findNext();
  };
  const replaceAll = () => {
    if (!findRe || !matches) { notify({ tone: "info", title: `"${findText}" was not found` }); return; }
    const count = matches;
    update((d) => ({ ...d, blocks: d.blocks.map((b0) => ({ ...b0, ...(b0.html !== undefined ? { html: replaceInHtml(b0.html, findRe, replaceText) } : {}), ...(b0.rows ? { rows: b0.rows.map((r) => r.map((c) => replaceInHtml(c, findRe, replaceText))) } : {}) })) }), { snapshot: true });
    notify({ tone: "success", title: `Replaced ${count} ${count === 1 ? "match" : "matches"}` });
  };

  // ---------- colour / highlight (keeps the text selection while the colour picker has focus) ----------
  const keepSelection = () => { const s0 = window.getSelection(); if (s0 && s0.rangeCount) savedRange.current = s0.getRangeAt(0).cloneRange(); };
  const applyColour = (cmd: "foreColor" | "hiliteColor", value: string) => {
    const s0 = window.getSelection();
    const range = savedRange.current;
    if (!range || !s0) return;
    const host = (range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest<HTMLElement>("[contenteditable=true]");
    if (!host) return;
    host.focus({ preventScroll: true }); // execCommand only acts on a focused editable element
    s0.removeAllRanges(); s0.addRange(range);
    document.execCommand("styleWithCSS", false, "true");
    document.execCommand(cmd, false, value);
    document.execCommand("styleWithCSS", false, "false");
  };
  const applyInlineStyle = (property: "font-family" | "font-size", value: string) => {
    const range = savedRange.current;
    const selection = window.getSelection();
    const editable = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[contenteditable=true]");
    const host = range && editable(range.commonAncestorContainer);
    if (!range || range.collapsed || !selection || !host || editable(range.startContainer) !== host || editable(range.endContainer) !== host) {
      notify({ tone: "info", title: "Select text to change its font" });
      return;
    }
    host.focus({ preventScroll: true });
    selection.removeAllRanges(); selection.addRange(range);
    const span = document.createElement("span");
    span.style.setProperty(property, value);
    span.appendChild(range.extractContents());
    range.insertNode(span);
    const next = document.createRange(); next.selectNodeContents(span);
    selection.removeAllRanges(); selection.addRange(next);
    savedRange.current = next.cloneRange();
    const blockId = host.dataset.blockId;
    if (blockId) setBlock(blockId, { html: sanitize(host.innerHTML) }, true);
  };
  const colourPicker = (cmd: "foreColor" | "hiliteColor", label: string, icon: React.ReactNode, initial: string) => (
    <label className="rb-small rb-colour" title={label} onMouseDown={keepSelection}>
      {icon}<span className="rb-colour-bar" style={{ background: initial }} />
      <input type="color" aria-label={label} defaultValue={initial} onChange={(e) => applyColour(cmd, e.target.value)} />
    </label>
  );

  // ---------- pictures ----------
  const insertPicture = async (file?: File) => {
    if (!file) return;
    try {
      const src = await pictureData(file);
      insertBlock({ id: newId(), type: "image", src, alt: file.name.replace(/\.[^.]+$/, ""), width: 100 });
      setRibbonTab("picture");
    } catch (e: any) { notify({ tone: "danger", title: "Couldn't insert the picture", body: e.message }); }
    finally { if (pictureInput.current) pictureInput.current.value = ""; }
  };
  const picture = focused?.type === "image" ? focused : null;

  const tabs: RibbonTab[] = [
    { id: "home", label: "Home", groups: [
      { label: "Undo", content: <RStack><RSmall icon={<LuUndo2 />} label="Undo (Ctrl Z)" onClick={undo} disabled={!past.current.length} /><RSmall icon={<LuRedo2 />} label="Redo (Ctrl Shift Z)" onClick={redo} disabled={!future.current.length} /></RStack> },
      { label: "Font", content: <RStack>
        <RRow>
          <select className="rb-select" aria-label="Font family" value={fontFamily} onMouseDown={keepSelection} onFocus={keepSelection}
            onChange={(e) => { const family = e.target.value; setFontFamily(family); applyInlineStyle("font-family", family); }}>
            {FONT_FAMILIES.map((family) => <option key={family} value={family}>{family}</option>)}
          </select>
          <select className="rb-select" aria-label="Font size" value={fontSize} onMouseDown={keepSelection} onFocus={keepSelection}
            onChange={(e) => { const size = e.target.value; setFontSize(size); applyInlineStyle("font-size", size); }}>
            {[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72].map((size) => <option key={size} value={`${size}pt`}>{size}</option>)}
          </select>
        </RRow>
        <RRow>
          <RSmall icon={<LuBold />} label="Bold (Ctrl B)" onClick={() => exec("bold")} />
          <RSmall icon={<LuItalic />} label="Italic (Ctrl I)" onClick={() => exec("italic")} />
          <RSmall icon={<LuUnderline />} label="Underline (Ctrl U)" onClick={() => exec("underline")} />
          <RSmall icon={<LuStrikethrough />} label="Strikethrough" onClick={() => exec("strikeThrough")} />
        </RRow>
        <RRow>
          <RSmall icon={<LuSubscript />} label="Subscript" onClick={() => exec("subscript")} />
          <RSmall icon={<LuSuperscript />} label="Superscript" onClick={() => exec("superscript")} />
          <RSmall icon={<LuRemoveFormatting />} label="Clear formatting" onClick={() => exec("removeFormat")} />
          {colourPicker("foreColor", "Font colour", <LuBaseline />, "#c00000")}
          {colourPicker("hiliteColor", "Highlight colour", <LuHighlighter />, "#ffff00")}
        </RRow>
      </RStack> },
      { label: "Paragraph", content: <RStack>
        <RRow>
          <RSmall icon={<LuList />} label="Bulleted list" active={focused?.type === "bullet"} onClick={() => setType(focused?.type === "bullet" ? "paragraph" : "bullet")} />
          <RSmall icon={<LuListOrdered />} label="Numbered list" active={focused?.type === "numbered"} onClick={() => setType(focused?.type === "numbered" ? "paragraph" : "numbered")} />
          <RSmall icon={<LuQuote />} label="Quote" active={focused?.type === "quote"} onClick={() => setType(focused?.type === "quote" ? "paragraph" : "quote")} />
        </RRow>
        <RRow>
          <RSmall icon={<LuAlignLeft />} label="Align left" active={textFocused && !focused!.align} onClick={() => setAlign("left")} />
          <RSmall icon={<LuAlignCenter />} label="Align centre" active={focused?.align === "center"} onClick={() => setAlign("center")} />
          <RSmall icon={<LuAlignRight />} label="Align right" active={focused?.align === "right"} onClick={() => setAlign("right")} />
          <RSmall icon={<LuAlignJustify />} label="Justify" active={focused?.align === "justify"} onClick={() => setAlign("justify")} />
        </RRow>
      </RStack> },
      { label: "Styles", content: <div className="rb-styles" role="listbox" aria-label="Paragraph style">
        {(["paragraph", "title", "heading1", "heading2", "heading3", "quote"] as TextType[]).map((t) => (
          <button key={t} role="option" aria-selected={focused?.type === t} className={`rb-style ${focused?.type === t ? "is-active" : ""}`} disabled={!textFocused} onClick={() => setType(t)}>
            <span className={`rb-style-sample wb-${t}`} style={{ margin: 0, padding: 0, fontSize: t === "paragraph" || t === "quote" ? 13 : t === "title" ? 18 : t === "heading1" ? 16 : 14 }}>AaBbCc</span>
            <span className="rb-style-name">{STYLE_LABELS[t]}</span>
          </button>
        ))}
      </div> },
      { label: "Editing", content: <RStack>
        <RSmall icon={<LuSearch />} label="Find (Ctrl F)" showLabel onClick={() => setFindOpen("find")} />
        <RSmall icon={<LuReplace />} label="Replace (Ctrl H)" showLabel onClick={() => setFindOpen("replace")} />
      </RStack> },
    ] },
    { id: "insert", label: "Insert", groups: [
      { label: "Illustrations", content: <><RBig icon={<LuImage />} label="Picture" onClick={() => pictureInput.current?.click()} />
        <input ref={pictureInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="visually-hidden" onChange={(e) => insertPicture(e.target.files?.[0])} /></> },
      { label: "Tables", content: <RBig icon={<LuTable />} label="Table" onClick={() => insertBlock(block("table"))} /> },
      { label: "Pages", content: <RBig icon={<LuSeparatorHorizontal />} label="Page break" onClick={() => insertBlock(block("pagebreak"))} /> },
      { label: "References", content: <RBig icon={<LuListOrdered />} label="Table of contents" disabled={doc.blocks.some((b) => b.type === "toc")}
        onClick={() => insertBlock(block("toc"))} title="Build a linked contents list from Heading 1–3 blocks" /> },
      { label: "Links", content: <div className="w-link">
        <RBig icon={<LuLink />} label="Link" onClick={() => { const s = window.getSelection(); savedRange.current = s && s.rangeCount ? s.getRangeAt(0).cloneRange() : null; setLinkOpen(!linkOpen); }} />
        {linkOpen && (
          <form className="popover w-link-pop" onSubmit={(e) => { e.preventDefault(); applyLink(); }}>
            <input autoFocus aria-label="Link address" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} />
            <Button size="sm" variant="primary" type="submit">Apply</Button>
          </form>
        )}
      </div> },
    ] },
    { id: "layout", label: "Layout", groups: [
      { label: "Page setup", content: <>
        <RBig icon={<LuFile />} label="A4" active={doc.page.size === "A4"} onClick={() => update((d) => ({ ...d, page: { ...d.page, size: "A4" } }), { snapshot: true })} />
        <RBig icon={<LuFile />} label="Letter" active={doc.page.size === "Letter"} onClick={() => update((d) => ({ ...d, page: { ...d.page, size: "Letter" } }), { snapshot: true })} />
      </> },
      { label: "Header and footer", content: <RStack>
        <RRow><label className="rb-field">Header <input aria-label="Page header" maxLength={300} value={doc.page.header ?? ""} placeholder="Text on each page"
          onChange={(e) => setPageText("header", e.target.value)} /></label></RRow>
        <RRow><label className="rb-field">Footer <input aria-label="Page footer" maxLength={300} value={doc.page.footer ?? ""} placeholder="Text on each page"
          onChange={(e) => setPageText("footer", e.target.value)} /></label></RRow>
      </RStack> },
    ] },
    { id: "review", label: "Review", groups: [
      { label: "Comments", content: <RStack>
        <div onMouseDown={() => { const selection = window.getSelection(); if (selection?.rangeCount) savedRange.current = selection.getRangeAt(0).cloneRange(); }}>
          <RBig icon={<LuQuote />} label="New comment" onClick={beginComment} title="Comment on the selected text or current paragraph" />
        </div>
        <RBig icon={<LuQuote />} label={`Comments (${doc.comments?.length ?? 0})`} active={commentsOpen} onClick={() => setCommentsOpen((open) => !open)} />
      </RStack> },
    ] },
    { id: "view", label: "View", groups: [
      { label: "Zoom", content: <>
        <RBig icon={<LuZoomOut />} label="Zoom out" onClick={() => setZoom((z) => Math.max(50, z - 10))} />
        <RBig icon={<LuSearch />} label="100%" onClick={() => setZoom(100)} />
        <RBig icon={<LuZoomIn />} label="Zoom in" onClick={() => setZoom((z) => Math.min(200, z + 10))} />
      </> },
      { label: "Atlas AI", content: <RBig icon={<LuSparkles />} label="Ask about this document" onClick={() => askAi(`In the open document "${docRef.path}", `)} /> },
    ] },
    ...(picture ? [{ id: "picture", label: "Picture", contextual: true, groups: [
      { label: "Size", content: <>{[25, 50, 75, 100].map((w) => <RBig key={w} icon={<LuImage />} label={`${w}%`} active={(picture.width ?? 100) === w} onClick={() => setBlock(picture.id, { width: w }, true)} />)}</> },
      { label: "Position", content: <RRow>
        <RSmall icon={<LuAlignLeft />} label="Align left" active={!picture.align || picture.align === "left"} onClick={() => setBlock(picture.id, { align: undefined }, true)} />
        <RSmall icon={<LuAlignCenter />} label="Centre" active={picture.align === "center"} onClick={() => setBlock(picture.id, { align: "center" }, true)} />
        <RSmall icon={<LuAlignRight />} label="Align right" active={picture.align === "right"} onClick={() => setBlock(picture.id, { align: "right" }, true)} />
      </RRow> },
      { label: "Accessibility", content: <label className="rb-field">Alt text <input value={picture.alt ?? ""} placeholder="Describe the picture" onChange={(e) => setBlock(picture.id, { alt: e.target.value })} /></label> },
      { label: "Delete", content: <RBig icon={<LuTrash2 />} label="Delete picture" onClick={() => remove(picture.id, false)} /> },
    ] } as RibbonTab] : []),
  ];

  return (
    <div className="writer app-writer" style={{ position: "relative" }}>
      <Ribbon appName="Writer" appIcon={<LuFileText />} title={doc.title} status={<span className={`w-save w-save-${save}`} aria-live="polite">{saveLabel}</span>}
        onBack={close} tabs={tabs} activeTab={tabs.some((x) => x.id === ribbonTab) ? ribbonTab : "home"} onTab={setRibbonTab}
        quick={<>
          <button onClick={undo} disabled={!past.current.length} aria-label="Undo" title="Undo (Ctrl Z)"><LuUndo2 /></button>
          <button onClick={redo} disabled={!future.current.length} aria-label="Redo" title="Redo (Ctrl Shift Z)"><LuRedo2 /></button>
          <button onClick={() => askAi(`In the open document "${docRef.path}", `)} title="Ask Atlas AI about this document"><LuSparkles /> Atlas AI</button>
        </>}
        backstage={[
          { id: "info", label: "Info", icon: <LuInfo />, content: <BackstageSection title="Info">
            <dl className="rb-bs-facts"><dt>Name</dt><dd>{doc.title}</dd><dt>Location</dt><dd>{grantLabel} / {docRef.path}</dd>
              <dt>Words</dt><dd>{words.toLocaleString()}</dd><dt>Page size</dt><dd>{doc.page.size}</dd>
              {doc.page.header && <><dt>Header</dt><dd>{doc.page.header}</dd></>}{doc.page.footer && <><dt>Footer</dt><dd>{doc.page.footer}</dd></>}
              <dt>Status</dt><dd>{saveLabel}</dd></dl>
          </BackstageSection> },
          { id: "export", label: "Export", icon: <LuDownload />, content: <BackstageSection title="Export">
            <p className="muted">Saves a copy next to this document in {grantLabel}.</p>{exportTiles}</BackstageSection> },
          { id: "close", label: "Close", icon: <LuX />, onSelect: close },
        ]} />

      {findOpen && (
        <form className="w-find" role="search" onSubmit={(e) => { e.preventDefault(); findNext(); }}>
          <input autoFocus aria-label="Find" placeholder="Find" value={findText} onChange={(e) => setFindText(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setFindOpen(null); }} />
          {findOpen === "replace" && <input aria-label="Replace with" placeholder="Replace with" value={replaceText} onChange={(e) => setReplaceText(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setFindOpen(null); }} />}
          <span className="muted w-find-count" aria-live="polite">{findText ? `${matches} ${matches === 1 ? "match" : "matches"}` : ""}</span>
          <label className="w-find-case"><input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Match case</label>
          <Button size="sm" type="submit">Find next</Button>
          {findOpen === "replace" ? <><Button size="sm" type="button" onClick={replaceOne}>Replace</Button><Button size="sm" type="button" variant="primary" onClick={replaceAll}>Replace all</Button></>
            : <Button size="sm" type="button" variant="ghost" onClick={() => setFindOpen("replace")}>Replace…</Button>}
          <IconButton label="Close find" onClick={() => setFindOpen(null)}><LuX /></IconButton>
        </form>
      )}

      {externalChange && (
        <div className="banner banner-info w-banner">Atlas AI changed this document while you were editing.
          <Button size="sm" icon={<LuRefreshCw />} onClick={() => load({ flashChanges: true })}>Load its version</Button>
        </div>
      )}

      <div className={`w-canvas ${commentsOpen ? "w-canvas-comments" : ""}`} onMouseDown={(e) => {
        if (e.target === e.currentTarget && doc.blocks.length) { const last = doc.blocks[doc.blocks.length - 1]; if (isText(last.type)) { setCaret({ id: last.id, at: "end" }); setFocusId(last.id); e.preventDefault(); } else insertAfter(last.id, block("paragraph")); }
      }}>
        <article className={`w-page w-page-${doc.page.size}`} aria-label={doc.title} style={{ zoom: zoom / 100 }}>
          {doc.page.header && <div className="w-page-margin w-page-header" aria-label="Page header preview">{doc.page.header}</div>}
          {doc.blocks.map((b) => {
            n = b.type === "numbered" ? n + 1 : 0;
            const cls = `${flash.has(b.id) ? "ai-flash" : ""} ${b.id === focusId ? "is-focused" : ""}`;
            if (b.type === "table") return <TableBlock key={b.id} b={b} cls={cls} onFocus={() => setFocusId(b.id)} onChange={(rows, snap) => setBlock(b.id, { rows }, snap)} onDelete={() => remove(b.id, false)} />;
            if (b.type === "image") return (
              <figure key={b.id} className={`w-figure ${cls}`} style={{ textAlign: b.align ?? "left" }} contentEditable={false}
                onMouseDown={(e) => { e.preventDefault(); setFocusId(b.id); setRibbonTab("picture"); }}>
                <img src={b.src} alt={b.alt ?? ""} style={{ width: `${b.width ?? 100}%` }} draggable={false} />
              </figure>
            );
            if (b.type === "pagebreak") return (
              <div key={b.id} className={`w-pagebreak ${cls}`} contentEditable={false}><span>Page break</span>
                <IconButton label="Remove page break" onClick={() => remove(b.id, false)}><LuTrash2 /></IconButton></div>
            );
            if (b.type === "toc") {
              const headings = doc.blocks.filter((item) => ["heading1", "heading2", "heading3"].includes(item.type));
              return <nav key={b.id} className={`w-toc ${cls}`} aria-label="Table of contents" contentEditable={false}
                onMouseDown={() => setFocusId(b.id)}>
                <div className="w-toc-title"><strong>Contents</strong><IconButton label="Remove table of contents" onClick={() => remove(b.id, false)}><LuTrash2 /></IconButton></div>
                {headings.length ? <ol>{headings.map((heading) => <li key={heading.id} style={{ marginLeft: `${(Number(heading.type.slice(-1)) - 1) * 20}px` }}>
                  <button type="button" onClick={() => { setFocusId(heading.id); document.getElementById(`writer-${heading.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" }); }}>
                    {plainText(heading.html ?? "") || "(untitled)"}</button>
                </li>)}</ol> : <p>No headings yet.</p>}
              </nav>;
            }
            return (
              <TextBlock key={b.id} b={b} number={n} cls={cls} caret={caret?.id === b.id ? caret.at : null} onCaretDone={() => setCaret(null)}
                onFocus={() => setFocusId(b.id)} onChange={(html) => setBlock(b.id, { html })}
                onSplit={(before, after) => onSplit(b, before, after)} onMergeBack={(html) => onMergeBack(b, html)} />
            );
          })}
          {doc.page.footer && <div className="w-page-margin w-page-footer" aria-label="Page footer preview">{doc.page.footer}</div>}
        </article>
        {commentsOpen && <aside className="w-comments" aria-label="Document comments">
          <header className="w-comments-header"><strong>Comments</strong><span>{doc.comments?.length ?? 0}</span>
            <IconButton label="Close comments" onClick={() => setCommentsOpen(false)}><LuX /></IconButton></header>
          {commentDraft && <form className="w-comment-compose" onSubmit={(e) => { e.preventDefault(); addComment(); }}>
            {commentDraft.quote && <blockquote>{commentDraft.quote}</blockquote>}
            <textarea autoFocus aria-label="Comment text" maxLength={3000} placeholder="Write a comment" value={commentText} onChange={(e) => setCommentText(e.target.value)} />
            <div className="row gap-2"><Button size="sm" variant="primary" type="submit" disabled={!commentText.trim()}>Add comment</Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => setCommentDraft(null)}>Cancel</Button></div>
          </form>}
          <div className="w-comments-list">
            {(doc.comments ?? []).map((comment) => {
              const target = doc.blocks.find((item) => item.id === comment.blockId);
              return <article key={comment.id} className={`w-comment ${comment.resolved ? "is-resolved" : ""}`}>
                <button className="w-comment-target" type="button" onClick={() => { document.getElementById(`writer-${comment.blockId}`)?.scrollIntoView({ block: "center", behavior: "smooth" }); setFocusId(comment.blockId); }}>
                  {target && isText(target.type) ? STYLE_LABELS[target.type] : "Document text"} · Go to text
                </button>
                {comment.quote && <blockquote>{comment.quote}</blockquote>}
                <p>{comment.text}</p>
                <div className="row between gap-2"><Button size="sm" variant="ghost" onClick={() => setCommentResolved(comment.id, !comment.resolved)}>{comment.resolved ? "Reopen" : "Resolve"}</Button>
                  <IconButton label="Delete comment" onClick={() => deleteComment(comment.id)}><LuTrash2 /></IconButton></div>
              </article>;
            })}
            {!commentDraft && !doc.comments?.length && <p className="muted">No comments yet. Select text and choose New comment.</p>}
          </div>
        </aside>}
      </div>

      <footer className="doc-statusbar">
        <span>{words.toLocaleString()} words</span>
        <span>{chars.toLocaleString()} characters</span>
        <span>{doc.page.size}</span>
        <span className="grow" />
        <button className="link" onClick={() => askAi(`In the open document "${docRef.path}", `)}><LuSparkles /> Ask Atlas AI about this document</button>
        <Zoom value={zoom} onChange={setZoom} />
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
    <Tag ref={ref} id={`writer-${b.id}`} className={`wb wb-${b.type} ${cls}`} data-block-id={b.id} data-number={b.type === "numbered" ? `${number}.` : undefined}
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

/** Read a picture as a data URL, scaling large photos down so documents stay small (max 1600 px, ~3 MB). */
async function pictureData(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error("Use a PNG, JPEG, GIF or WebP picture.");
  const raw = await new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => bad(new Error("Couldn't read the file.")); r.readAsDataURL(file); });
  if (file.type === "image/gif" && raw.length < 3_900_000) return raw; // keep animation
  const img = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error("That file isn't a picture Atlas can read.")); i.src = raw; });
  const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale === 1 && raw.length < 3_900_000) return raw;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale); canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  for (const q of [0.88, 0.75, 0.6]) {
    const out = file.type === "image/png" && q === 0.88 ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", q);
    if (out.length < 3_900_000) return out;
  }
  throw new Error("The picture is too large, even after shrinking it.");
}
