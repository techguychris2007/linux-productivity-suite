# Decision Log

When building started (14 Nov 2026), the six open questions from the architecture recommendation hadn't been answered. Defaults were chosen so work could proceed. Each can be reversed; the cost of reversing is noted.

| # | Decision | Default taken | Status | Cost to reverse |
|---|---|---|---|---|
| D1 | Licence for Atlas code | **GPL-3.0-or-later** (`LICENSE` copied from Ubuntu's common-licenses) | Provisional, awaiting owner | Low while private: relicense before first public push |
| D2 | Office engine | **Native editors + LibreOffice headless converter** (Option B) | Provisional | Medium after Milestone 3 |
| D3 | Hardware tier | Unknown → video generation remains optional and is detected at runtime | Open | None |
| D4 | Default AI provider | **None configured.** The user picks Anthropic, an OpenAI-compatible endpoint (incl. local Ollama/llama.cpp/LM Studio), or nothing. No data leaves the machine until a cloud provider is chosen. | Provisional | None |
| D5 | GitHub repo | Local git repo only; push when a private repo is connected | Open | None |
| D6 | Ubuntu target | 26.04 primary, 24.04 secondary (pending spike S-OP-4) | Provisional | Low |

## Build-environment deviations (Milestone 1)

The build environment used for Milestone 1 had **no network access**, so only toolchains already installed could be used:

| Planned | Used now | Plan |
|---|---|---|
| Vite dev server/bundler | **esbuild** (already a Vite dependency) via `apps/shell/build.mjs` | Add Vite on the first networked build; the source is bundler-agnostic |
| Tailwind CSS | **CSS custom properties** (design tokens) in `packages/ui/src/tokens.css` | Tokens are the source of truth either way; Tailwind can map to them later via `@theme` |
| FastAPI + WebSockets | **stdlib `http.server` + Server-Sent Events** in `atlas_engine/devserver.py` | `atlas_engine/app_fastapi.py` is written against the same engine API but is **untested** until FastAPI can be installed |
| serde / serde_json in Rust | A small, tested JSON module in `atlas-core` (`json.rs`) | Swap for serde when the Tauri app is compiled |
| Tauri 2 | `apps/shell/src-tauri` is written but **not compiled** | Compile on an Ubuntu machine with network access |

## D7 — Writer editor engine (14 Nov 2026)
Atlas's own block editor (contentEditable per typed block) instead of ProseMirror, because ProseMirror could not be installed offline. It's lighter, and the AI edits the same structure the user sees. Trade-offs and the revisit trigger are in MILESTONE_3_REPORT.md §2.

## D8 — Office conversion engine
LibreOffice headless (free, MPL-2.0, out of process) with the "HTML (StarWriter)" filter in both directions. Verified: headings become real Word Heading styles.
