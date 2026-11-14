import React, { useEffect, useState } from "react";
import { LuHouse, LuSearch, LuBell, LuSparkles, LuX } from "react-icons/lu";
import { IconButton, Kbd } from "@atlas/ui";
import { APPS, DEPARTMENTS, appById } from "./apps";
import { useAtlas } from "./context";
import { AiDock } from "./ai/AiDock";
import { CommandPalette } from "./CommandPalette";
import { Home } from "./views/Home";
import { Drive } from "./views/Drive";
import { Settings } from "./views/Settings";
import { Placeholder } from "./views/Placeholder";

export function App() {
  const { route, go, aiOpen, setAiOpen, toasts, dismiss, markAllRead } = useAtlas();
  const [palette, setPalette] = useState(false);
  const [bell, setBell] = useState(false);
  const [base, sub] = route.split(":");
  const app = appById(base);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); }
      if ((e.ctrlKey || e.metaKey) && e.key === ".") { e.preventDefault(); setAiOpen(!aiOpen); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [aiOpen, setAiOpen]);

  const unread = toasts.filter((t) => !t.read).length;
  const live = toasts.filter((t) => !t.read && Date.now() - t.ts < 6000).slice(0, 3);
  const [, force] = useState(0);
  useEffect(() => { if (!live.length) return; const t = setTimeout(() => force((x) => x + 1), 6100); return () => clearTimeout(t); }, [live.length]);

  let view: React.ReactNode;
  if (base === "home" || !app) view = <Home />;
  else if (base === "drive") view = <Drive />;
  else if (base === "settings") view = <Settings initial={sub} />;
  else if (base === "ai") view = <Home />;
  else view = <Placeholder app={app} />;

  return (
    <div className={`shell ${aiOpen ? "with-ai" : ""}`}>
      <nav className="rail" aria-label="Applications">
        <button className="brand" onClick={() => go("home")} aria-label="Atlas home"><span className="brand-mark">A</span></button>
        <button className={`rail-btn ${base === "home" ? "is-active" : ""}`} onClick={() => go("home")} title="Home"><LuHouse /><span>Home</span></button>
        <div className="rail-scroll">
          {DEPARTMENTS.map((d) => (
            <div key={d.id} className="rail-group">
              <div className="rail-label">{d.label}</div>
              {APPS.filter((a) => a.department === d.id && a.id !== "ai").map((a) => (
                <button key={a.id} className={`rail-btn ${base === a.id ? "is-active" : ""} ${a.available ? "" : "is-planned"}`} onClick={() => go(a.id)} title={a.available ? a.name : `${a.name} — planned`}>
                  <a.icon className={`dept-ic-${a.department}`} /><span>{a.name}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <div className="topbar-title">{app && base !== "home" ? app.name : "Home"}</div>
          <button className="search-trigger" onClick={() => setPalette(true)}><LuSearch /><span>Search apps and files</span><Kbd>Ctrl K</Kbd></button>
          <div className="row gap-1">
            <div className="bell-wrap">
              <IconButton label={`Notifications${unread ? ` (${unread} unread)` : ""}`} onClick={() => { setBell(!bell); }}>
                <LuBell />{unread > 0 && <span className="bell-dot">{unread}</span>}
              </IconButton>
              {bell && (
                <div className="popover" role="dialog" aria-label="Notifications">
                  <header><strong>Notifications</strong><button className="link" onClick={markAllRead}>Mark all read</button></header>
                  {toasts.length === 0 && <p className="muted pad">Nothing yet.</p>}
                  <ul>{toasts.map((t) => <li key={t.id} className={`note note-${t.tone} ${t.read ? "is-read" : ""}`}><strong>{t.title}</strong>{t.body && <span>{t.body}</span>}</li>)}</ul>
                </div>
              )}
            </div>
            <IconButton label="Atlas AI (Ctrl .)" active={aiOpen} onClick={() => setAiOpen(!aiOpen)}><LuSparkles /></IconButton>
          </div>
        </header>
        <main className="content">{view}</main>
      </div>

      {aiOpen && <AiDock />}
      {palette && <CommandPalette onClose={() => setPalette(false)} />}

      <div className="toasts" aria-live="polite">
        {live.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <div><strong>{t.title}</strong>{t.body && <p>{t.body}</p>}</div>
            <IconButton label="Dismiss" onClick={() => dismiss(t.id)}><LuX /></IconButton>
          </div>
        ))}
      </div>
    </div>
  );
}
