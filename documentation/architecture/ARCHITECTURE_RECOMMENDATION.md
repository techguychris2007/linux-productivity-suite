# Project Atlas — Architecture Recommendation

Status: **proposed — awaiting your approval.** Date: 14 Nov 2026. It is based on the nine research documents in `documentation/research/`.

## 1. System overview

```
┌───────────────────────────── Atlas desktop (one Tauri 2 app) ─────────────────────────────┐
│  React/TS UI                                                                               │
│  ┌ Shell: launcher · global search · notifications · settings · activity panel · AI dock ┐ │
│  │ Apps (lazy modules): Writer · Sheets · Slides · Database · PDF · Notes · Forms ·       │ │
│  │   Diagram · Design · Video Studio · Video Generator · Play/Cinema/Shorts/Library ·     │ │
│  │   Streaming · Drive · Project Manager                                                  │ │
│  │ Each app registers: tools (typed) · document model · undo stack · ghost-cursor hooks   │ │
│  └────────────────────────────────────────────────────────────────────────────────────────┘ │
│        ▲ Tauri IPC (commands + events)                                                       │
│  Rust core: Permission Broker · FS Gateway (granted roots only) · Secret store              │
│             (Secret Service) · Sidecar supervisor · Event bus · Audit log · Approval tokens│
└───────────────▲──────────────────────────────▲─────────────────────────────▲──────────────┘
                │ localhost WS + per-launch token (or Unix socket)            │
      ┌─────────┴──────────┐        ┌──────────┴───────────┐       ┌─────────┴─────────┐
      │ Atlas Engine (Py)  │        │ Operator service     │       │ Media service     │
      │ Orchestrator       │        │ Portal ScreenCast    │       │ MLT preview/render│
      │ LLM providers      │        │ RemoteDesktop+libei  │       │ FFmpeg jobs       │
      │ Tool router / MCP  │        │ AT-SPI2 · VLM ground │       │ Library scanner   │
      │ Content APIs (YT,  │        └──────────────────────┘       └───────────────────┘
      │ IA) · Verifier     │
      └────────────────────┘
   External, optional, separate processes: LibreOffice headless · ComfyUI · Jellyfin · Ollama/llama.cpp
```

### Design principles
1. **API first, GUI second.** Atlas apps are driven only through typed tools. The "visible AI" inside Atlas is a ghost cursor that the UI draws as tool events arrive. The real mouse and keyboard are used only for external apps.
2. **The model proposes and Rust decides.** Every side effect goes through the Rust broker, which enforces scopes, risk tiers, approval tokens and the audit log.
3. **Copyleft engines stay out of process.** That keeps licences clean, isolates crashes and keeps each engine optional.
4. **Local-first.** Cloud is opt-in per provider, and a visible indicator shows when data is leaving the computer.
5. **Honest UI.** Progress shows real events, unfinished features are hidden behind flags, and nothing is mocked.

## 2. Permission model
| Risk tier | Examples | Default |
|---|---|---|
| read | Read the open document, list a granted folder | Auto |
| write | Edit the current document (undoable) | Auto, inside an active task the user started |
| destructive | Delete or overwrite files, empty trash | Approval every time |
| external | Upload a file, send data to a cloud model, download | Approval (can be remembered per provider and per folder) |
| system | Operator control of other apps, install packages, change settings | Approval per session; install and settings changes are **not offered** in v1 |

Filesystem grants are per folder and are recorded in SQLite. They can be revoked in Settings. The model never sees paths outside the granted folders.

## 3. Revised milestone plan
| # | Milestone | Main deliverable | Exit test |
|---|---|---|---|
| 0 | Research & architecture | This pack | **Your approval** |
| **0.5** | **Technical spikes (new)** | S-OP-1/4, S-ENT-1/2, S-VID-1, S-DOC-1 (LibreOffice round-trip), S-DIST-1 | A go/no-go report for each spike |
| 1 | Desktop shell + design system | Launcher, search, settings, theme, Drive (granted folders), notifications, .deb builds in CI | Installs on clean 26.04; opens and saves files in a granted folder |
| 2 | Atlas AI core + permissions | Provider interface, orchestrator, tool registry, activity panel (pause/stop/take control), approval UI, audit log | AI completes a 3-step Drive task with a real event stream; denied scopes are blocked in tests |
| 3 | **Writer MVP** *(moved up)* | ProseMirror editor, styles, tables, images, PDF/DOCX export via LibreOffice, writer.* tools | AI writes a 5-page formatted report; it round-trips through DOCX |
| 4 | Sheets MVP | Univer, formulas, charts, CSV/XLSX, sheets.* tools | AI builds a budget with charts; XLSX opens in LibreOffice |
| 5 | Slides MVP | Layout and theme editor, presenter mode, PPTX export, slides.* tools | The flagship deck request works end to end |
| 6 | **Operator MVP** *(moved later)* | Wayland Operator levels 1–3 behind feature flags | Operates Files and Firefox for a scripted task, with consent and interruption |
| 7 | Database + PDF | | |
| 8 | Notes, Forms, Diagram | | |
| 9 | Design Studio | | |
| 10 | Video Studio | | |
| 11 | Video Generator | | |
| 12 | Atlas Play hub | | Compliance checklist passed |
| 13 | Cross-app workflows | | Flagship "documentaries" workflow |
| 14 | Hardening + distribution | AppImage, release process | Signed release with SHA256SUMS |

**Why the Operator moved:** with API-first design, Atlas's own apps don't need it, and it carries the most platform risk. Building three real apps first proves the tool architecture the Operator also depends on.

## 4. Top risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Writer pagination and page layout in ProseMirror | High | High | Spike early in M3; consider a paged-view layer; scope a v1 "continuous + print preview" fallback |
| YouTube embed in WebKitGTK (Error 153) | Medium | High for Play | S-ENT-1; fallback to opening in the browser |
| MLT preview latency in the webview | Medium | High for Video | S-VID-1; GES plan B |
| Wayland input differs across GNOME versions | Medium | Medium | S-OP-1/4; backend abstraction; scope to GNOME first |
| Python sidecar packaging size and fragility | Medium | Medium | S-DIST-1; keep ML dependencies out of the bundle |
| Scope: 20 apps for one developer | **Very high** | High | Strict milestones; MVP definitions; feature flags |
| YouTube derived-data policy vs recommendations | Medium | Medium | Atlas-side signals only; review before M12 |

## 5. Repository strategy
- One **private** GitHub repository (monorepo), shaped like the brief's tree with these adjustments: `apps/shell` (Tauri) instead of `apps/desktop`; `services/engine` (Python), `services/operator`, `services/media`; `packages/{ui,tools-sdk,shared-types,permissions}`.
- Conventional commits, CI on every PR, and draft releases built from tags.
- Make it public only after the licence decision and the compliance checklist.

## 6. Decisions needed from you
1. **Licence for Atlas's own code:** GPL-3.0-or-later (recommended for an open-source future) or Apache-2.0. Either works with this architecture.
2. **Office engine:** approve Option B (native editors + LibreOffice converter), or prefer ONLYOFFICE (higher fidelity, AGPL obligations).
3. **Your hardware:** the GPU model and VRAM. This decides whether local video generation and local LLMs are realistic.
4. **Default AI provider:** a cloud model (better multi-step reliability; data leaves the computer), local models, or both.
5. **GitHub:** create the private repository and connect it to this session, so Milestone 0.5 can start committing.
6. **Ubuntu version on your machine:** 24.04 or 26.04. This decides the dev VM and the first CI target.
