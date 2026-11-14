// Draws a slide at any size: thumbnails, the editing canvas and the slide show all use SlideView.
import React from "react";
import { type Slide, type SlideElement, type Theme, PLACEHOLDER, SLIDE_H, SLIDE_W } from "./model";

export function elementStyle(e: SlideElement, theme: Theme): React.CSSProperties {
  const heading = e.role === "title";
  return {
    position: "absolute", left: e.x, top: e.y, width: e.w, height: e.h,
    fontSize: e.size, lineHeight: heading ? 1.15 : 1.3,
    fontFamily: heading ? theme.heading : theme.body,
    fontWeight: e.bold ? 700 : 400, fontStyle: e.italic ? "italic" : "normal", textDecoration: e.underline ? "underline" : "none",
    textAlign: e.align ?? "left",
    color: e.role === "subtitle" ? theme.muted : theme.fg,
    overflow: "hidden", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
    display: "flex", flexDirection: "column", justifyContent: heading || e.role === "subtitle" ? "center" : "flex-start",
  };
}

/** The text of one element. Text is rendered as React text nodes, never as HTML. */
export function ElementText({ e, theme, placeholders }: { e: SlideElement; theme: Theme; placeholders?: boolean }) {
  if (!e.text.trim()) {
    return placeholders && e.role !== "text" ? <span className="sl-placeholder" style={{ color: theme.muted }}>{PLACEHOLDER[e.role]}</span> : null;
  }
  if (e.bullets) {
    return <ul className="sl-bullets" style={{ ["--sl-accent" as string]: theme.accent }}>
      {e.text.split("\n").map((line, i) => {
        const depth = line.match(/^(\t| {2})*/)?.[0].replace(/ {2}/g, "\t").length ?? 0;
        return <li key={i} style={{ marginLeft: Math.min(depth, 4) * 1.2 + "em" }} className={line.trim() ? "" : "is-empty"}>{line.trim() || " "}</li>;
      })}
    </ul>;
  }
  return <span>{e.text}</span>;
}

export function SlideSurface({ slide, theme, placeholders, children }: { slide: Slide; theme: Theme; placeholders?: boolean; children?: React.ReactNode }) {
  return <div className="sl-surface" style={{ width: SLIDE_W, height: SLIDE_H, background: theme.bg, color: theme.fg }}>
    {slide.layout === "section" && <div className="sl-section-bar" style={{ background: theme.accent }} />}
    {slide.elements.map((e) => <div key={e.id} style={elementStyle(e, theme)}><ElementText e={e} theme={theme} placeholders={placeholders} /></div>)}
    {children}
  </div>;
}

/** A slide scaled to `width` pixels wide. */
export function SlideView({ slide, theme, width, placeholders, label }: { slide: Slide; theme: Theme; width: number; placeholders?: boolean; label?: string }) {
  const scale = width / SLIDE_W;
  return <div className="sl-view" style={{ width, height: SLIDE_H * scale }} role="img" aria-label={label}>
    <div style={{ transform: `scale(${scale})`, transformOrigin: "0 0" }}><SlideSurface slide={slide} theme={theme} placeholders={placeholders} /></div>
  </div>;
}
