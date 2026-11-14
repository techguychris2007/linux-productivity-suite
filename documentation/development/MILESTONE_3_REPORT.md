# Milestone 3 Report — Atlas Writer MVP

Date: 14 Nov 2026. Writer was moved ahead of the remaining Milestone 2 packaging work: packaging needs network access, and Writer could be built fully in the offline build environment.

## 1. What was implemented
| Area | Delivered |
|---|---|
| Document model (`.atlasdoc`, JSON) | Ordered typed blocks: title, heading 1–3, paragraph, quote, bulleted and numbered items, table, page break. Inline formatting is a sanitised HTML subset (bold, italic, underline, strike, code, sub/sup, links limited to http/https/mailto). The engine and UI sanitise with the same rules. |
| Conversion (LibreOffice headless, free) | Export to **DOCX** (real Word "Heading 1/2/3" styles), **PDF** and **ODT**. Import from **DOCX, DOC, ODT, RTF, HTML and TXT**. Runs in a private profile, one conversion at a time, with a 120 s timeout. Each conversion took about a second here. |
| Writer UI | Documents list; new document; import list; page view (A4/Letter) with toolbar: undo/redo, paragraph style, B/I/U/S, link, lists, quote, alignment, table (add/remove rows and columns), page break, and an Export menu. Enter splits a block and Backspace merges; lists continue and exit naturally. Paste is sanitised. Autosave after 0.9 s, and Ctrl+S saves immediately. Word count and save state appear in the footer. Dark mode keeps the page paper-white. |
| Atlas AI in Writer | Tools: `writer.create_document`, `read_document`, `insert_blocks`, `update_block`, `delete_blocks`, `export`, `import`. The AI knows which document is open (`open_document` context). When the AI edits the open document, the editor reloads it live and **highlights the changed blocks**. If you have unsaved edits, it asks before replacing them. |
| Core | `fs.read_base64` / `fs.write_base64` for binary files (25 MB limit). Autosave can skip backups, but **only for the user's own editor**: AI edits are always backed up. |
| Drive | `.atlasdoc` opens in Writer, and Word/ODT files have an "Open in Writer" button. |

## 2. Architecture decision: block editor instead of ProseMirror
ProseMirror could not be installed (no network). Writer uses Atlas's own lightweight block editor: each block is a `contentEditable` element bound to the typed model. Advantages: no dependency; the AI edits exactly the same structure the user sees; it maps 1:1 to Word paragraph styles. Trade-offs: no multi-block text selection or cross-block copy in v1, and inline formatting uses `document.execCommand`, which is deprecated but still supported by both Chromium and WebKitGTK. Revisit if those limits matter in practice.

## 3. Tests
| Suite | Result |
|---|---|
| Rust core | **16 / 16** (adds the binary round trip and "only the UI may skip backups") |
| Engine (pytest) | **23 / 23**. Adds the sanitiser (scripts, `javascript:` links, mis-nesting), Markdown inline, list grouping, import of LibreOffice HTML, a **real LibreOffice round trip** (doc → DOCX with Heading1 → PDF → back, keeping bold, italic, list and table), and Writer tools against the real core |
| Browser E2E | **18 / 18**. Adds: type, change style, bold, list, with autosave verified **on disk**; export DOCX (checks `Heading1` inside the .docx) and PDF (`%PDF-`); the AI edits the open document and it updates live with a highlight; import a real Word file; the AI writes a report with a table and exports it to Word |

## 4. Bugs found and fixed while testing
- Changing a block's style (paragraph → heading) emptied its text on screen. The element changes type, and the content sync didn't re-run. Fixed and covered by a test.
- The editor reopened its live-update connection on every save-state change. It now uses one connection per open document.
- The Export menu opened off-screen when the toolbar wrapped. The save status moved to the footer and the toolbar fits on one row next to the AI panel.

## 5. Known limitations
- No images in documents yet. No headers/footers, page numbers, table of contents, comments, or find & replace (planned for Writer v2).
- On screen the page is one continuous sheet. Real page breaks appear in PDF/DOCX output.
- Import keeps structure, bold/italic/underline, lists and tables. Fonts, colours and complex layouts are simplified.
- Gemini is still untested live (the build environment has no internet).

## 6. Next
Sheets MVP (Milestone 4), or the Writer v2 items above. Milestone 2's packaging (.deb/AppImage) still needs a networked build.
