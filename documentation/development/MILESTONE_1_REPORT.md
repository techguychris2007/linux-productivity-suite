# Milestone 1 Report — Foundation (shell, security core, AI engine)

Date: 14 Nov 2026

## Direction change from the owner
"Everything should be free and lightweight, with no paid API or licence, compatible with Ubuntu. Use a free API like Gemini; don't create an AI from scratch."

How this milestone applies it:
- **Gemini's free tier is the default provider.** It needs a free Google AI Studio key and no card. The model is discovered from the API rather than hard-coded, because model names change. Free-tier rate limits (429 errors) get automatic back-off and a plain-language message.
- A **local model server** (Ollama, llama.cpp or LM Studio through the OpenAI-compatible API) is the fully offline free alternative.
- The engine needs **no third-party Python packages** (standard library only), and the Rust core has **no crates**.
- Atlas's own licence is GPL-3.0, a free licence that costs nobody anything. All planned engines (LibreOffice, FFmpeg, MLT, ComfyUI) are free and open source.

## 1. What was implemented
| Area | Delivered |
|---|---|
| Rust security core (`crates/atlas-core`) | Folder grants: system and credential folders refused, symlink-escape protection, read-only and "AI allowed" flags. Approval queue with single-use tokens bound to the exact action. Audit log (JSONL). Filesystem gateway: list, read, search, write with automatic backup, mkdir, move, and trash (Atlas never deletes). Caller separation: UI vs AI engine. `atlas-core-host` serves this on 127.0.0.1 with two separate tokens and a Host-header check. |
| AI engine (`services/engine`) | A single orchestrator loop: plan → tools → verify, with pause, resume, cancel and take control, a retry limit, and a one-round verifier. Typed tool registry with schema validation and risk tiers. Untrusted-content wrapping, plus a taint rule: after reading files, external actions always need approval. Providers: **Gemini (default)**, OpenAI-compatible (local), Anthropic. Drive toolset. Local HTTP API with a Server-Sent Events stream of **real** execution events. |
| Shell UI (`apps/shell`) | Launcher grouped by department; global search across apps, files and "ask AI" (Ctrl K); Drive with list, preview, new folder/file and trash; Settings for appearance (system/light/dark), folders, Atlas AI provider, and privacy/activity log; notifications; the Atlas AI panel with privacy indicator, live plan checklist, step timeline, approval cards, and Pause / Take control / Stop. Apps that aren't built yet show an honest "Planned for Milestone N" page. |
| Desktop wrapper | `apps/shell/src-tauri` (Tauri 2): commands for core dispatch, engine proxy and the folder picker. **Not yet compiled.** |

## 2. Files
See the repository tree in README.md. Main new code: `crates/atlas-core/src/*`, `services/engine/atlas_engine/*`, `apps/shell/src/*`, `packages/ui/src/*`, `packages/shared-types/src/*`, `tests/e2e/*`.

## 3. Architecture decisions
- **The approval gate lives in Rust.** The AI engine holds only the engine token, so it cannot approve its own actions (tested).
- **Atlas never permanently deletes files.** Files go to Atlas's trash, and overwritten files are backed up first.
- **The activity panel shows only emitted events.** There are no timers and no fake progress.
- Deviations caused by the offline build environment (esbuild instead of Vite, CSS tokens instead of Tailwind, stdlib HTTP instead of FastAPI, a small JSON module instead of serde) are recorded in DECISIONS.md.

## 4. Dependencies introduced
Runtime: React 19, react-dom, react-icons (MIT). Nothing else. The Rust core and Python engine have zero third-party dependencies.

## 5–6. Tests executed and results
| Suite | Result |
|---|---|
| `cargo test` (atlas-core) | **13 / 13 passed.** Covers path confinement, symlink escape, refused roots, persistence, approval single-use/binding/expiry, caller separation, write-backup round-trip, trash approval flow, AI visibility of grants |
| `pytest` (engine) | **16 / 16 passed.** Covers schema, untrusted wrapping, Gemini request/response conversion, model auto-pick, 429 back-off, local-vs-remote detection, plan events, verifier, failure limit, approval/denial, taint rule, pause/cancel, no-provider guidance, and **integration with the real core binary** |
| Playwright E2E (`tests/e2e/run.sh`) | **13 / 13 passed.** Covers home, honest placeholders, sharing a folder, refusing `/etc`, Drive operations verified on disk, search, the no-provider guidance, Gemini as the default, connecting a local model, and a full AI task where the approval card appears, the file is untouched until Approve, then trashed. Also the audit log entry, dark theme, and zero page errors |

The E2E AI task uses `tests/e2e/fake_llm.py`, a **test-only** scripted OpenAI-compatible server. Real Gemini calls could not be tested because the build environment had no internet access.

## 7. Known bugs / gaps
- Gemini has been tested against recorded request/response shapes only, not live. **First thing to check on your machine.**
- No TypeScript type-check in CI yet (`@types/react` wasn't installed offline). esbuild only transpiles.
- In development mode the API key is stored in a 0600 file. It moves to the Ubuntu keyring in Milestone 2.
- `window.confirm` is used for the manual "move to trash" confirmation. It will be replaced by an Atlas dialog.

## 8. Remaining limitations
- Desktop packaging (.deb / AppImage) needs the Tauri wrapper to be compiled, which needs network access.
- No document apps yet (Writer is Milestone 3).

## 9. Run instructions
See README.md (`pnpm dev`).

## 10. Next milestone
**Milestone 2:** compile the Tauri app and produce the first `.deb` and AppImage. Store keys in the Ubuntu keyring. Test Gemini live and tune the prompts for Flash models. Add a "ghost cursor" for visible AI actions inside Atlas apps. Then the Milestone 0.5 spikes that matter for Writer (LibreOffice headless round-trip).
