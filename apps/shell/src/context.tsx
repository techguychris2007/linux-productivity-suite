import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Grant } from "@atlas/shared-types";
import type { AtlasBridge } from "./bridge";

export type Theme = "system" | "light" | "dark";
export interface Toast { id: number; tone: "info" | "success" | "warning" | "danger"; title: string; body?: string; ts: number; read?: boolean }

interface Ctx {
  bridge: AtlasBridge;
  route: string;
  go: (route: string) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  grants: Grant[];
  refreshGrants: () => Promise<void>;
  toasts: Toast[];
  notify: (t: Omit<Toast, "id" | "ts">) => void;
  dismiss: (id: number) => void;
  markAllRead: () => void;
  aiOpen: boolean;
  setAiOpen: (v: boolean) => void;
  aiDraft: string;
  askAi: (prompt: string) => void;
  /** File the Writer should open next (set by Drive / search). */
  writerTarget: DocRef | null;
  openInWriter: (ref: DocRef | null) => void;
  /** Document currently open in an app; sent to Atlas AI as context. */
  activeDoc: (DocRef & { app: string; title?: string }) | null;
  setActiveDoc: (d: (DocRef & { app: string; title?: string }) | null) => void;
}

export interface DocRef { grant: string; path: string }

const AtlasCtx = createContext<Ctx | null>(null);
export const useAtlas = () => {
  const c = useContext(AtlasCtx);
  if (!c) throw new Error("AtlasProvider missing");
  return c;
};

function load<T>(k: string, d: T): T {
  try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; }
}
function save(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }

export function AtlasProvider({ bridge, children }: { bridge: AtlasBridge; children: React.ReactNode }) {
  const [route, setRoute] = useState<string>(() => location.pathname.length > 1 ? location.pathname.slice(1) : "home");
  const [theme, setThemeState] = useState<Theme>(() => load("atlas.theme", "system"));
  const [grants, setGrants] = useState<Grant[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [aiOpen, setAiOpenState] = useState<boolean>(() => load("atlas.aiOpen", true));
  const [aiDraft, setAiDraft] = useState("");
  const [writerTarget, setWriterTarget] = useState<DocRef | null>(() => load("atlas.writerTarget", null));
  const [activeDoc, setActiveDoc] = useState<Ctx["activeDoc"]>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.dataset.theme = theme === "system" ? (mq.matches ? "dark" : "light") : theme;
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  const go = useCallback((r: string) => {
    setRoute(r);
    try { history.pushState(null, "", "/" + (r === "home" ? "" : r) + location.hash); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    const onPop = () => setRoute(location.pathname.length > 1 ? location.pathname.slice(1) : "home");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const notify = useCallback((t: Omit<Toast, "id" | "ts">) => {
    const toast = { ...t, id: Date.now() + Math.random(), ts: Date.now() };
    setToasts((x) => [toast, ...x].slice(0, 50));
  }, []);
  const dismiss = useCallback((id: number) => setToasts((x) => x.map((t) => (t.id === id ? { ...t, read: true } : t))), []);
  const markAllRead = useCallback(() => setToasts((x) => x.map((t) => ({ ...t, read: true }))), []);

  const refreshGrants = useCallback(async () => {
    try { setGrants(await bridge.core<Grant[]>("grants.list")); }
    catch (e: any) { notify({ tone: "danger", title: "Could not load folders", body: e.message }); }
  }, [bridge, notify]);
  useEffect(() => { refreshGrants(); }, [refreshGrants]);

  const value = useMemo<Ctx>(() => ({
    bridge, route, go, theme, grants, refreshGrants, toasts, notify, dismiss, markAllRead, aiOpen, aiDraft,
    setTheme: (t) => { setThemeState(t); save("atlas.theme", t); },
    setAiOpen: (v) => { setAiOpenState(v); save("atlas.aiOpen", v); },
    askAi: (p) => { setAiDraft(p); if (p) { setAiOpenState(true); save("atlas.aiOpen", true); } },
    writerTarget,
    openInWriter: (ref) => { setWriterTarget(ref); save("atlas.writerTarget", ref); if (ref) go("writer"); },
    activeDoc, setActiveDoc,
  }), [bridge, route, go, theme, grants, refreshGrants, toasts, notify, dismiss, markAllRead, aiOpen, aiDraft, writerTarget, activeDoc]);

  return <AtlasCtx.Provider value={value}>{children}</AtlasCtx.Provider>;
}
