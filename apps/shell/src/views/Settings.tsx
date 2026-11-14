import React, { useEffect, useState } from "react";
import { LuSun, LuMoon, LuMonitor, LuFolderPlus, LuTrash2, LuCloud, LuLaptop, LuShieldCheck, LuRefreshCw } from "react-icons/lu";
import type { ProviderKind, ProviderPublic } from "@atlas/shared-types";
import { Badge, Button, Field, IconButton, Spinner } from "@atlas/ui";
import { useAtlas, type Theme } from "../context";

const SECTIONS = [
  { id: "appearance", label: "Appearance" },
  { id: "folders", label: "Folders" },
  { id: "ai", label: "Atlas AI" },
  { id: "privacy", label: "Privacy & activity" },
] as const;

export function Settings({ initial }: { initial?: string }) {
  const [section, setSection] = useState<(typeof SECTIONS)[number]["id"]>(() => (SECTIONS.find((s) => s.id === initial)?.id) ?? "appearance");
  useEffect(() => { const f = SECTIONS.find((s) => s.id === initial); if (f) setSection(f.id); }, [initial]);
  return (
    <div className="page settings">
      <nav className="settings-nav" aria-label="Settings sections">
        <h1>Settings</h1>
        {SECTIONS.map((s) => <button key={s.id} className={section === s.id ? "is-active" : ""} onClick={() => setSection(s.id)}>{s.label}</button>)}
      </nav>
      <div className="settings-body">
        {section === "appearance" && <Appearance />}
        {section === "folders" && <Folders />}
        {section === "ai" && <AiSettings />}
        {section === "privacy" && <Privacy />}
      </div>
    </div>
  );
}

function Appearance() {
  const { theme, setTheme } = useAtlas();
  const opts: { id: Theme; label: string; icon: React.ReactNode }[] = [
    { id: "system", label: "Follow Ubuntu", icon: <LuMonitor /> }, { id: "light", label: "Light", icon: <LuSun /> }, { id: "dark", label: "Dark", icon: <LuMoon /> },
  ];
  return (
    <section className="card">
      <h2>Theme</h2>
      <div className="segmented" role="radiogroup" aria-label="Theme">
        {opts.map((o) => <button key={o.id} role="radio" aria-checked={theme === o.id} className={theme === o.id ? "is-active" : ""} onClick={() => setTheme(o.id)}>{o.icon}{o.label}</button>)}
      </div>
    </section>
  );
}

function Folders() {
  const { bridge, grants, refreshGrants, notify } = useAtlas();
  const [path, setPath] = useState("");
  const [access, setAccess] = useState<"readwrite" | "read">("readwrite");
  const [ai, setAi] = useState(true);
  const add = async (p: string) => {
    try {
      await bridge.core("grants.add", { path: p, access, ai_allowed: ai });
      setPath(""); await refreshGrants(); notify({ tone: "success", title: "Folder shared with Atlas" });
    } catch (e: any) { notify({ tone: "danger", title: "Could not share that folder", body: e.message }); }
  };
  const pick = async () => { const p = await bridge.pickFolder?.(); if (p) add(p); };
  return (
    <>
      <section className="card">
        <h2>Shared folders</h2>
        <p className="muted">Atlas — and Atlas AI — can only reach folders listed here. System and credential folders (like <code>~/.ssh</code>) can never be shared.</p>
        <ul className="grant-list">
          {grants.length === 0 && <li className="muted">Nothing shared yet.</li>}
          {grants.map((g) => (
            <li key={g.id}>
              <div className="grant-main"><strong>{g.label}</strong><code className="ellipsis">{g.root}</code></div>
              <Badge tone={g.access === "read" ? "neutral" : "accent"}>{g.access === "read" ? "Read only" : "Read & write"}</Badge>
              <Badge tone={g.ai_allowed ? "success" : "neutral"}>{g.ai_allowed ? "AI allowed" : "Manual only"}</Badge>
              <IconButton label={`Stop sharing ${g.label}`} onClick={async () => { await bridge.core("grants.revoke", { id: g.id }); refreshGrants(); }}><LuTrash2 /></IconButton>
            </li>
          ))}
        </ul>
      </section>
      <section className="card">
        <h2>Share a folder</h2>
        {bridge.pickFolder ? <Button variant="primary" icon={<LuFolderPlus />} onClick={pick}>Choose folder…</Button> : (
          <form className="row gap-2 wrap" onSubmit={(e) => { e.preventDefault(); if (path.trim()) add(path.trim()); }}>
            <Field label="Folder path" hint="Development mode has no native folder picker; type an absolute path.">
              <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/you/Documents" />
            </Field>
            <Button variant="primary" type="submit" icon={<LuFolderPlus />}>Share</Button>
          </form>
        )}
        <div className="row gap-4 wrap mt-3">
          <label className="check"><input type="checkbox" checked={access === "read"} onChange={(e) => setAccess(e.target.checked ? "read" : "readwrite")} /> Read only</label>
          <label className="check"><input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} /> Allow Atlas AI to use it</label>
        </div>
      </section>
    </>
  );
}

function AiSettings() {
  const { bridge, notify } = useAtlas();
  const [kinds, setKinds] = useState<ProviderKind[]>([]);
  const [current, setCurrent] = useState<ProviderPublic | null>(null);
  const [kind, setKind] = useState<ProviderKind["kind"]>("gemini");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:11434/v1");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [busy, setBusy] = useState<"" | "models" | "save">("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    bridge.engine<{ kinds: ProviderKind[]; current: ProviderPublic | null }>("GET", "/providers").then((r) => {
      setKinds(r.kinds); setCurrent(r.current);
      if (r.current) { setKind(r.current.kind); setModel(r.current.model ?? ""); if (r.current.base_url) setBaseUrl(r.current.base_url); }
    }).catch((e) => setErr(e.message));
  }, [bridge]);

  const info = kinds.find((k) => k.kind === kind);
  const loadModels = async () => {
    setBusy("models"); setErr(null);
    try {
      const r = await bridge.engine<{ models: { id: string; label: string }[]; suggested: string }>("POST", "/providers/models", { kind, api_key: apiKey || undefined });
      setModels(r.models); if (!model) setModel(r.suggested);
    } catch (e: any) { setErr(e.message); } finally { setBusy(""); }
  };
  const save = async () => {
    setBusy("save"); setErr(null);
    try {
      const body: any = { kind, model: model || undefined };
      if (info?.needs.includes("api_key") && apiKey) body.api_key = apiKey;
      if (kind === "openai_compat") body.base_url = baseUrl;
      const r = await bridge.engine<ProviderPublic>("POST", "/providers", body);
      setCurrent(r); setModel(r.model ?? ""); setApiKey("");
      notify({ tone: "success", title: "Atlas AI is ready", body: `Using ${r.model}` });
    } catch (e: any) { setErr(e.message); } finally { setBusy(""); }
  };

  return (
    <>
      <section className="card">
        <h2>AI provider</h2>
        <p className="muted">Atlas doesn't include its own AI model. It connects to one you choose. Both free options below work without paying anything.</p>
        <div className="provider-grid" role="radiogroup" aria-label="AI provider">
          {kinds.map((k) => (
            <button key={k.kind} role="radio" aria-checked={kind === k.kind} className={`provider ${kind === k.kind ? "is-active" : ""}`}
              onClick={() => { setKind(k.kind); setModels([]); if (current?.kind !== k.kind) setModel(""); }}>
              <span className="provider-head">{k.remote ? <LuCloud /> : <LuLaptop />}<strong>{k.label}</strong></span>
              <span className="row gap-2"><Badge tone={k.cost === "free" ? "success" : "warning"}>{k.cost === "free" ? "Free" : "Paid"}</Badge>
                <Badge tone={k.remote ? "warning" : "success"}>{k.remote ? "Sends data online" : "Stays on this computer"}</Badge></span>
              <span className="provider-note">{k.note}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="card">
        <h2>Connection</h2>
        {current && <p className="muted">Currently using <strong>{current.kind}</strong>{current.model ? <> · <code>{current.model}</code></> : null}{current.has_api_key ? " · key saved" : ""}</p>}
        <div className="form-stack">
          {info?.needs.includes("api_key") && (
            <Field label={kind === "gemini" ? "Gemini API key" : "API key"}
              hint={kind === "gemini" ? <>Free from <strong>Google AI Studio</strong> (aistudio.google.com → Get API key). No card required.</> : undefined}>
              <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                placeholder={current?.kind === kind && current.has_api_key ? "Saved — leave blank to keep" : "Paste key"} />
            </Field>
          )}
          {kind === "openai_compat" && (
            <Field label="Server URL" hint="Ollama: http://127.0.0.1:11434/v1 · llama.cpp: http://127.0.0.1:8080/v1">
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </Field>
          )}
          <Field label="Model" hint={kind === "gemini" ? "Leave empty and Atlas picks a free Flash model automatically." : undefined}>
            <div className="row gap-2">
              {models.length ? (
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  {models.map((m) => <option key={m.id} value={m.id}>{m.label} ({m.id})</option>)}
                </select>
              ) : <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={kind === "openai_compat" ? "e.g. qwen3:8b" : "auto"} />}
              {kind === "gemini" && <Button size="sm" icon={busy === "models" ? <Spinner /> : <LuRefreshCw />} onClick={loadModels} disabled={!!busy || (!apiKey && !(current?.kind === "gemini" && current.has_api_key))}>Load models</Button>}
            </div>
          </Field>
          {err && <div className="banner banner-danger">{err}</div>}
          <div><Button variant="primary" onClick={save} disabled={!!busy}>{busy === "save" ? "Checking…" : "Save and test"}</Button></div>
        </div>
      </section>
    </>
  );
}

function Privacy() {
  const { bridge } = useAtlas();
  const [log, setLog] = useState<any[] | null>(null);
  const load = () => bridge.core<any[]>("audit.recent", { limit: 100 }).then(setLog).catch(() => setLog([]));
  useEffect(() => { load(); }, []);
  return (
    <section className="card">
      <div className="row between"><h2><LuShieldCheck /> Activity log</h2><IconButton label="Refresh" onClick={load}><LuRefreshCw /></IconButton></div>
      <p className="muted">Every file action — by you or by Atlas AI — is recorded on this computer.</p>
      <table className="files audit">
        <thead><tr><th>Time</th><th>Who</th><th>Action</th><th>Target</th><th>Result</th></tr></thead>
        <tbody>
          {log === null && <tr><td colSpan={5}><Spinner /></td></tr>}
          {log?.map((e, i) => (
            <tr key={i}>
              <td className="muted">{new Date(e.ts).toLocaleTimeString()}</td>
              <td><Badge tone={e.actor === "atlas-ai" ? "accent" : "neutral"}>{e.actor === "atlas-ai" ? "Atlas AI" : "You"}</Badge></td>
              <td><code>{e.action}</code></td>
              <td className="ellipsis muted">{e.detail?.path ?? e.detail?.id ?? ""}</td>
              <td><Badge tone={e.outcome === "ok" ? "success" : e.outcome.startsWith("approval") ? "warning" : "danger"}>{e.outcome}</Badge></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
