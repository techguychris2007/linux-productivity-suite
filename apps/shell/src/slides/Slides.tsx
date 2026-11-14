import React, { useCallback, useEffect, useState } from "react";
import { LuPresentation, LuFilePlus, LuRefreshCw } from "react-icons/lu";
import type { FsEntry } from "@atlas/shared-types";
import { Button, EmptyState, Field, IconButton, Spinner } from "@atlas/ui";
import { useAtlas, type DocRef } from "../context";
import { newDeck, normalizeDeck, THEMES, type AtlasDeck } from "./model";
import { SlideView } from "./render";
import { SlideEditor } from "./SlideEditor";

type Found = FsEntry & { grant: string; label: string };
const EXT = ".atlasdeck";
const safeName = (s: string) => s.trim().replace(/[/\\]/g, "-").replace(/^\.+/, "") || "Untitled presentation";

/** First slide of a deck as a thumbnail; loads lazily. */
function Cover({ item }: { item: Found }) {
  const { bridge } = useAtlas();
  const [deck, setDeck] = useState<AtlasDeck | null>(null);
  useEffect(() => {
    let live = true;
    bridge.core<{ content: string }>("fs.read_text", { grant: item.grant, path: item.path, max_bytes: 4_000_000 })
      .then((r) => { if (live) setDeck(normalizeDeck(JSON.parse(r.content))); }).catch(() => {});
    return () => { live = false; };
  }, [bridge, item.grant, item.path, item.modified_ms]);
  const theme = THEMES.find((t) => t.id === deck?.theme) ?? THEMES[0];
  return deck ? <SlideView slide={deck.slides[0]} theme={theme} width={200} /> : <span className="sl-cover-empty"><LuPresentation /></span>;
}

export function Slides() {
  const { bridge, grants, notify, go, slideTarget, openInSlides } = useAtlas();
  const [docs, setDocs] = useState<Found[] | null>(null);
  const [ref, setRef] = useState<DocRef | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("Untitled presentation");
  const [grant, setGrant] = useState("");
  const writable = grants.filter((g) => g.access === "readwrite");
  useEffect(() => { if (!grant && writable[0]) setGrant(writable[0].id); }, [writable, grant]);

  const scan = useCallback(async () => {
    const results = await Promise.all(grants.map(async (g) => (await bridge.core<FsEntry[]>("fs.search", { grant: g.id, query: EXT, limit: 200 }).catch(() => []))
      .filter((e) => e.kind === "file" && e.name.endsWith(EXT)).map((e) => ({ ...e, grant: g.id, label: g.label }))));
    const found = results.flat().sort((a, b) => (b.modified_ms ?? 0) - (a.modified_ms ?? 0));
    setDocs(found);
  }, [bridge, grants]);
  useEffect(() => { scan(); }, [scan]);
  useEffect(() => { if (slideTarget) setRef(slideTarget); }, [slideTarget]);

  const create = async () => {
    const title = safeName(name); const path = `${title}${EXT}`;
    try {
      await bridge.core("fs.write_text", { grant, path, content: JSON.stringify(newDeck(title), null, 1), overwrite: false });
      setRef({ grant, path }); setCreating(false); scan();
    } catch (e: any) { notify({ tone: "danger", title: "Could not create presentation", body: e.message }); }
  };

  if (ref) return <SlideEditor key={ref.grant + ref.path} docRef={ref} onClose={() => { setRef(null); openInSlides(null); scan(); }} />;

  if (!grants.length) return <div className="page"><EmptyState icon={<LuPresentation />} title="Share a folder to start a presentation" action={<Button variant="primary" onClick={() => go("settings:folders")}>Share a folder</Button>}>Slides saves your work in folders you have shared with Atlas.</EmptyState></div>;
  return <div className="page sl-home">
    <header className="row between wrap gap-2"><div><h1>Slides</h1><p className="muted">Presentations with themes, speaker notes and presenter view.</p></div>
      <div className="row gap-2"><IconButton label="Refresh" onClick={scan}><LuRefreshCw /></IconButton>
        <Button variant="primary" icon={<LuFilePlus />} onClick={() => setCreating(true)} disabled={!writable.length}>New presentation</Button></div></header>
    {creating && <form className="card new-doc" onSubmit={(e) => { e.preventDefault(); void create(); }}><div className="row gap-4 wrap">
      <Field label="Name"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Save in"><select value={grant} onChange={(e) => setGrant(e.target.value)}>{writable.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}</select></Field></div>
      <div className="row gap-2"><Button type="submit" variant="primary">Create</Button><Button type="button" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button></div></form>}
    <section><h2 className="dept-title">Recent presentations</h2>
      {docs === null ? <p className="muted"><Spinner /> Loading…</p>
        : docs.length === 0 ? <p className="muted">No presentations yet. Create one, or ask Atlas AI to draft a deck for you.</p>
        : <div className="doc-grid">{docs.map((d) => <button key={d.grant + d.path} className="doc-card" onClick={() => setRef({ grant: d.grant, path: d.path })}>
            <span className="sl-cover"><Cover item={d} /></span>
            <span className="doc-name ellipsis">{d.name.replace(/\.atlasdeck$/, "")}</span>
            <span className="doc-meta ellipsis">{d.label} · {d.modified_ms ? new Date(d.modified_ms).toLocaleDateString() : ""}</span></button>)}</div>}
    </section>
  </div>;
}
