import React from "react";
import { LuSparkles, LuArrowUp } from "react-icons/lu";
import { APPS, DEPARTMENTS } from "../apps";
import { useAtlas } from "../context";

const SUGGESTIONS = [
  "List the folders I've shared with Atlas and what's in them",
  "Find every Markdown file in my Documents and summarise their names",
  "Create a folder called 'Atlas Projects' with a README explaining it",
];

export function Home() {
  const { go, askAi } = useAtlas();
  const [prompt, setPrompt] = React.useState("");
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <div className="page home">
      <section className="home-hero">
        <h1>{greeting}</h1>
        <p className="muted">What would you like to make or find today?</p>
        <form className="hero-ask" onSubmit={(e) => { e.preventDefault(); if (prompt.trim()) { askAi(prompt.trim()); setPrompt(""); } }}>
          <LuSparkles className="hero-ask-icon" />
          <input aria-label="Ask Atlas AI" placeholder="Describe the result you want…" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <button className="hero-send" aria-label="Send to Atlas AI" disabled={!prompt.trim()}><LuArrowUp /></button>
        </form>
        <div className="chips">
          {SUGGESTIONS.map((s) => <button key={s} className="chip" onClick={() => askAi(s)}>{s}</button>)}
        </div>
      </section>

      {DEPARTMENTS.map((d) => (
        <section key={d.id} className="dept">
          <h2 className="dept-title"><span className={`dot dot-${d.id}`} />{d.label}</h2>
          <div className="app-grid">
            {APPS.filter((a) => a.department === d.id).map((a) => (
              <button key={a.id} className={`app-tile ${a.available ? "" : "is-planned"}`} onClick={() => go(a.id)}>
                <span className={`app-icon dept-${a.department}`}><a.icon /></span>
                <span className="app-text">
                  <span className="app-name">{a.name}</span>
                  <span className="app-blurb">{a.blurb}</span>
                </span>
                {!a.available && <span className="app-ms">M{a.milestone}</span>}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
