// Slide show: full-screen audience view, or presenter view with the next slide, speaker notes and a timer.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LuChevronLeft, LuChevronRight, LuX, LuMonitor, LuPresentation, LuTimerReset } from "react-icons/lu";
import { type AtlasDeck, SLIDE_H, SLIDE_W, themeById } from "./model";
import { SlideView } from "./render";

const clock = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el); setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [ref]);
  return size;
}
const fit = (w: number, h: number) => Math.max(80, Math.min(w, h * SLIDE_W / SLIDE_H));

export function Present({ deck, start, presenter: startPresenter, onExit }: { deck: AtlasDeck; start: number; presenter: boolean; onExit: (at: number) => void }) {
  const theme = themeById(deck.theme);
  const [i, setI] = useState(Math.min(start, deck.slides.length - 1));
  const [black, setBlack] = useState(false);
  const [presenter, setPresenter] = useState(startPresenter);
  const [t0, setT0] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const raw = useSize(stage);
  const pad = presenter ? 40 : 0; // .sl-pv-stage has 20px padding on each side
  const size = { w: raw.w - pad, h: raw.h - pad };
  const last = deck.slides.length - 1;
  const iRef = useRef(i); iRef.current = i;

  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(id); }, []);
  useEffect(() => {
    const el = root.current;
    el?.focus();
    if (el?.requestFullscreen && !document.fullscreenElement) el.requestFullscreen().catch(() => { /* full screen refused: stay in the window */ });
    const onFs = () => { if (!document.fullscreenElement) onExit(iRef.current); };
    const t = window.setTimeout(() => document.addEventListener("fullscreenchange", onFs), 300);
    return () => { window.clearTimeout(t); document.removeEventListener("fullscreenchange", onFs); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (n: number) => { setBlack(false); setI(Math.max(0, Math.min(last, n))); };
  const onKey = (e: React.KeyboardEvent) => {
    const k = e.key;
    if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n", "N"].includes(k)) { e.preventDefault(); if (i === last && !black) setBlack(true); else go(i + 1); }
    else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p", "P"].includes(k)) { e.preventDefault(); go(i - 1); }
    else if (k === "Home") go(0);
    else if (k === "End") go(last);
    else if (k === "b" || k === "B" || k === ".") setBlack((b) => !b);
    else if (k === "Escape") { e.preventDefault(); onExit(i); }
  };

  const slide = deck.slides[i];
  const next = deck.slides[i + 1];
  return <div ref={root} className={`sl-show ${presenter ? "is-presenter" : ""}`} tabIndex={-1} onKeyDown={onKey} role="dialog" aria-modal="true"
    aria-label={`Slide show, slide ${i + 1} of ${deck.slides.length}`}>
    {presenter ? <div className="sl-pv">
      <div className="sl-pv-main">
        <div className="sl-pv-stage" ref={stage}>
          {black ? <div className="sl-black" style={{ width: fit(size.w, size.h), height: fit(size.w, size.h) * SLIDE_H / SLIDE_W }} />
            : <SlideView slide={slide} theme={theme} width={fit(size.w, size.h)} label={`Slide ${i + 1}`} />}
        </div>
        <div className="sl-pv-bar">
          <button onClick={() => go(i - 1)} disabled={i === 0} aria-label="Previous slide"><LuChevronLeft /></button>
          <span aria-live="polite">Slide {i + 1} of {deck.slides.length}</span>
          <button onClick={() => go(i + 1)} disabled={i === last} aria-label="Next slide"><LuChevronRight /></button>
          <span className="grow" />
          <span className="sl-pv-timer" title="Time since the show started">{clock(now - t0)}</span>
          <button onClick={() => { setT0(Date.now()); setNow(Date.now()); }} aria-label="Restart the timer" title="Restart the timer"><LuTimerReset /></button>
          <span className="sl-pv-clock">{new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          <button onClick={() => setPresenter(false)} title="Show only the slide"><LuPresentation /> Audience view</button>
          <button onClick={() => onExit(i)} title="End the show (Esc)"><LuX /> End show</button>
        </div>
      </div>
      <aside className="sl-pv-side">
        <h2>Next</h2>
        {next ? <SlideView slide={next} theme={theme} width={320} label={`Next: slide ${i + 2}`} /> : <p className="sl-pv-end">End of the show</p>}
        <h2>Notes</h2>
        <div className="sl-pv-notes">{slide.notes.trim() ? slide.notes : <span className="sl-pv-none">No notes for this slide.</span>}</div>
      </aside>
    </div> : <>
      <div className="sl-stage" ref={stage} onClick={() => { if (i === last && !black) setBlack(true); else go(i + 1); }}>
        {black ? <div className="sl-black" /> : <SlideView slide={slide} theme={theme} width={fit(size.w, size.h)} label={`Slide ${i + 1}`} />}
      </div>
      <div className="sl-show-tools">
        <button onClick={() => go(i - 1)} disabled={i === 0} aria-label="Previous slide"><LuChevronLeft /></button>
        <span>{i + 1} / {deck.slides.length}</span>
        <button onClick={() => go(i + 1)} disabled={i === last} aria-label="Next slide"><LuChevronRight /></button>
        <button onClick={() => setPresenter(true)} aria-label="Presenter view" title="Presenter view"><LuMonitor /></button>
        <button onClick={() => onExit(i)} aria-label="End show" title="End show (Esc)"><LuX /></button>
      </div>
    </>}
  </div>;
}
