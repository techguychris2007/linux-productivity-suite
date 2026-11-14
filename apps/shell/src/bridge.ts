// AtlasBridge: how the UI reaches the Rust core and the AI engine.
//  - TauriBridge: packaged desktop app (core over IPC, engine proxied by Rust).
//  - HttpBridge:  browser-based development against atlas-core-host + atlas-engine on localhost.

import type { EngineEvent } from "@atlas/shared-types";

export class BridgeError extends Error {
  constructor(public code: string, message: string, public data?: any) { super(message); }
}

export interface AtlasBridge {
  readonly kind: "tauri" | "http";
  core<T = any>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  engine<T = any>(method: "GET" | "POST", path: string, body?: unknown): Promise<T>;
  subscribe(after: number, onEvent: (e: EngineEvent) => void, onStatus: (connected: boolean) => void): () => void;
  pickFolder?(): Promise<string | null>;
}

async function unwrap(res: Response) {
  let payload: any = null;
  try { payload = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok || payload?.error) {
    const e = payload?.error ?? { code: `http_${res.status}`, message: res.statusText };
    throw new BridgeError(e.code, e.message, e.data);
  }
  return payload.result;
}

export class HttpBridge implements AtlasBridge {
  readonly kind = "http" as const;
  constructor(private token: string, private corePort: number, private enginePort: number) {}

  async core<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${this.corePort}/v1/${cmd}`, {
        method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body: JSON.stringify(args),
      });
    } catch { throw new BridgeError("core_unreachable", "Atlas core is not running."); }
    return unwrap(res);
  }

  async engine<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${this.enginePort}/v1${path}`, {
        method, headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      });
    } catch { throw new BridgeError("engine_unreachable", "Atlas AI engine is not running."); }
    return unwrap(res);
  }

  subscribe(after: number, onEvent: (e: EngineEvent) => void, onStatus: (c: boolean) => void) {
    let last = after;
    let es: EventSource | null = null;
    let closed = false;
    let retry: number | undefined;
    const open = () => {
      es = new EventSource(`http://127.0.0.1:${this.enginePort}/v1/events?after=${last}&token=${encodeURIComponent(this.token)}`);
      es.onopen = () => onStatus(true);
      es.onmessage = (m) => { const ev = JSON.parse(m.data) as EngineEvent; last = Math.max(last, ev.seq); onEvent(ev); };
      es.onerror = () => { onStatus(false); es?.close(); if (!closed) retry = window.setTimeout(open, 2000); };
    };
    open();
    return () => { closed = true; es?.close(); if (retry) clearTimeout(retry); };
  }
}

/** Tauri implementation (compiled only in the desktop build; see apps/shell/src-tauri). */
export class TauriBridge implements AtlasBridge {
  readonly kind = "tauri" as const;
  private get t(): any { return (window as any).__TAURI__; }

  async core<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    try { return await this.t.core.invoke("core_dispatch", { cmd, args }); }
    catch (e: any) { throw new BridgeError(e?.code ?? "core_error", e?.message ?? String(e), e?.data); }
  }
  async engine<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    try { return await this.t.core.invoke("engine_request", { method, path, body: body ?? null }); }
    catch (e: any) { throw new BridgeError(e?.code ?? "engine_error", e?.message ?? String(e), e?.data); }
  }
  subscribe(_after: number, onEvent: (e: EngineEvent) => void, onStatus: (c: boolean) => void) {
    let un: (() => void) | undefined;
    this.t.event.listen("engine-event", (m: any) => onEvent(m.payload)).then((u: () => void) => { un = u; onStatus(true); });
    return () => un?.();
  }
  async pickFolder() { return (await this.t.core.invoke("pick_folder")) as string | null; }
}

export function createBridge(): AtlasBridge | null {
  if ((window as any).__TAURI__) return new TauriBridge();
  const p = new URLSearchParams(location.hash.slice(1));
  let token = p.get("token");
  try {
    if (token) sessionStorage.setItem("atlas.devtoken", token); else token = sessionStorage.getItem("atlas.devtoken");
  } catch { /* storage unavailable */ }
  if (!token) return null;
  return new HttpBridge(token, Number(p.get("core") ?? 47801), Number(p.get("engine") ?? 47802));
}
