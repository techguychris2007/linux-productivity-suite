# Technology Selection

## 1. Confirmed from the proposal
| Layer | Choice | Status | Notes |
|---|---|---|---|
| Desktop shell | **Tauri 2** (Rust) | ✅ Confirmed | Official deb and AppImage bundling [VERIFIED]. Caveats: WebKitGTK (see §4) |
| Frontend | **React + TypeScript + Vite** | ✅ Confirmed | pnpm workspaces monorepo; every app is a lazy-loaded package |
| Styling | **Tailwind CSS + Atlas design tokens** | ✅ Confirmed | Tokens (colour, type, spacing, radius, motion) live in `packages/ui`; dark and light themes |
| Components | Headless primitives (Radix UI [UNVERIFIED licence: MIT]) + Atlas components | ✅ | Accessibility built in |
| Backend | **Python + FastAPI + WebSockets** as a Tauri sidecar | ✅ Confirmed, with a narrower role | Used for AI orchestration, the media/ML service clients and the content APIs. **Not** used for permissions or filesystem access: those live in Rust |
| Storage | **SQLite** (app data, library, history), files on disk for documents | ✅ | PostgreSQL isn't justified for a single-user local app. Revisit only if multi-user sync is added |
| Video engine | **MLT** (LGPL core) + **FFmpeg** | ✅ Confirmed | GES is plan B |
| Generation | **ComfyUI** as an optional external service | ✅ Confirmed | Remote ComfyUI and hosted APIs through a provider abstraction |
| Browser automation | **Playwright** | ✅ | Only for Atlas-launched browsers |

## 2. Changes from the proposal
| Proposal | Change | Why |
|---|---|---|
| "Research ONLYOFFICE and LibreOffice integration" as the office engine | **Native editors: ProseMirror/Tiptap (Writer), Univer (Sheets), a custom canvas editor (Slides). LibreOffice headless for DOCX/XLSX/PPTX/PDF conversion** | AGPL plus branding terms; a heavyweight server; and AI tools need typed access to the document model. See §3 |
| Native desktop automation (generic) | **Wayland-first Operator: portals + libei + AT-SPI2; VLM grounding as a fallback** | Ubuntu 26.04 has no X11 session [VERIFIED] |
| "Agent" per domain | **One orchestrator + toolsets + profiles + a verifier** | Reliability, cost, testability |
| PostgreSQL where justified | **SQLite only** for v1 | Single-user, local-first |
| Flatpak as a third format | **Deferred** | Sandbox conflicts with the Operator and host engines |
| Jellyfin as the Cinema foundation | **Built-in lightweight library + optional Jellyfin client mode** | Avoids requiring a server daemon; GPL-2.0-only boundary |
| — (new) | **MCP server exposing the Atlas tool registry** | Lets external agents use Atlas with the user's permission; standard tool schema |
| — (new) | **Rust permission broker** | Security-critical code in a memory-safe, minimal core that the model can't influence |

## 3. Office engine decision record
**Options considered**
| | A. Embed ONLYOFFICE DocumentServer | B. Native editors + LibreOffice converter (**recommended**) | C. Drive LibreOffice GUI through LOK tiled rendering |
|---|---|---|---|
| OOXML fidelity | ★★★★★ | ★★★ (converter-dependent) | ★★★★ |
| AI tool access to the model | Through plugins/macros | **Direct, typed** | UNO commands; awkward |
| UX control / Atlas look | Limited (ONLYOFFICE UI + branding terms) | **Full** | Poor (tile rendering in a webview) |
| Footprint | Server stack (Node, DB, broker [UNVERIFIED]) | Light; LibreOffice optional at runtime | LibreOffice required |
| Licence impact on Atlas | AGPL | None (out of process) | None (out of process) |
| Build effort | Low to integrate, high to customise | **High** (especially Writer pagination, Slides) | High and fragile |

**Decision:** B, with an explicit fidelity budget. Atlas's native formats are JSON-based (`.atlasdoc`, `.atlassheet`, `.atlasdeck`, zipped). Import and export to OOXML go through LibreOffice, and a **"round-trip report"** warns the user about features that may not convert exactly. Option A stays open as an optional compatibility plugin if fidelity proves insufficient.

## 4. WebKitGTK caveats that shape the design
| Issue | Impact | Mitigation |
|---|---|---|
| No Widevine | No Netflix or other DRM playback in-app | Launch an external browser (policy-compliant anyway) |
| `tauri://` origin sends no Referer | YouTube Error 153 [VERIFIED pattern] | Spike S-ENT-1: serve the player page from an http(s) origin |
| Codecs via GStreamer | Local MKV/HEVC may not play | Transcode on demand with FFmpeg; Jellyfin mode; open in the system player |
| WebGL/Canvas performance [UNVERIFIED] | Large spreadsheets, timelines | Univer is Canvas2D; test with a 100k-row sheet in a spike |

## 5. Final stack summary
```
Tauri 2 (Rust core: windows, permission broker, fs gateway, secrets, sidecar supervisor, event bus)
 ├─ React/TS frontend (pnpm monorepo: shell + 20 app modules, lazy-loaded)
 ├─ Atlas Engine (Python 3.12 FastAPI sidecar): orchestrator, LLM providers, tool router, content APIs
 ├─ Operator service: portal (ScreenCast/RemoteDesktop) + libei + AT-SPI2 (+ optional VLM)
 └─ External engines (separate processes, optional where marked):
      LibreOffice headless · FFmpeg · MLT/melt · ComfyUI (opt) · Jellyfin (opt) · Ollama/llama.cpp (opt)
```
