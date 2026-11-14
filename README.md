# Project Atlas

A private, local-first AI productivity and entertainment suite for Ubuntu.

Atlas is **free and lightweight**. It doesn't ship its own AI model and doesn't need paid services. Atlas AI connects to one of these:

- **Google Gemini free tier** (default). It needs a free API key from Google AI Studio and no card. Free-tier prompts may be used by Google to improve its products, and Atlas says so before anything is sent.
- **A local model server** (Ollama, llama.cpp or LM Studio). It's fully offline, and nothing leaves your computer.
- Anthropic Claude (optional, paid).

## Status: Milestone 1 (foundation)

| Part | State |
|---|---|
| Security core (Rust): folder grants, path confinement, approvals, audit log, filesystem gateway | ✅ Working, 13 tests |
| Atlas Engine (Python, standard library only): orchestrator, tool registry, Gemini / local / Anthropic providers, Drive tools, live event stream | ✅ Working, 16 tests incl. real core integration |
| Shell UI (React): launcher, search (Ctrl K), Drive, Settings, notifications, Atlas AI panel with live plan, approvals, pause, stop and take-control | ✅ Working, 13 end-to-end browser checks |
| Writer, Sheets, Slides and the other apps | Planned (see the milestone on each tile) |
| Desktop packaging (Tauri → .deb / AppImage) | Code written, **not yet compiled** (the build environment was offline) |

See `documentation/development/MILESTONE_1_REPORT.md` for details.

## Run it (Ubuntu 24.04 / 26.04)

Requirements: Rust (stable), Node 22 + pnpm, Python 3.12+.

```bash
pnpm install
pnpm dev            # builds and starts core + engine + UI, then prints a URL to open
```

Then open **Settings → Atlas AI**, paste a free Gemini key (or point it at a local Ollama server), and share a folder under **Settings → Folders**.

## Tests

```bash
pnpm test:core      # Rust security core
pnpm test:engine    # Python engine (includes an integration test against the real core)
pnpm test:e2e       # Browser test of the whole stack (Playwright + Chromium)
```

## Layout

```
apps/shell/            React shell + src-tauri desktop wrapper
packages/ui/           Design tokens and shared components
packages/shared-types/ Types shared by UI and engine API
crates/atlas-core/     Rust security core + atlas-core-host
services/engine/       Python Atlas Engine (AI orchestrator)
infrastructure/        Dev scripts (packaging comes in Milestone 2)
documentation/         Research, architecture, decisions, milestone reports
tests/e2e/             End-to-end browser tests
```

## Licence

GPL-3.0-or-later (provisional; see `documentation/development/DECISIONS.md`). It's a free and open-source licence; nobody has to pay for anything.
