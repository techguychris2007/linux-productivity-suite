# Product Comparison — Productivity Suites

> Scope note: The productivity-suite feature facts below come mainly from general product knowledge and are marked **[UNVERIFIED]** unless a source is given. The licence and architecture facts that drive decisions *were* verified (see GITHUB_REPOSITORY_AUDIT.md). A deeper, source-by-source feature audit can be done during Milestone 4 planning if you want one.

## 1. Suite comparison matrix

| Dimension | Microsoft 365 | LibreOffice | ONLYOFFICE | Google Workspace | WPS Office | Zoho Workplace |
|---|---|---|---|---|---|---|
| Licence | Proprietary [PAID] | MPL-2.0 [VERIFIED] | AGPL-3.0 Community; proprietary EE/DE [VERIFIED] | Proprietary SaaS | Proprietary freemium | Proprietary SaaS |
| Native Linux desktop | No (web only) [UNVERIFIED] | Yes | Yes (Desktop Editors) | Web | Yes [UNVERIFIED current status] | Web |
| OOXML fidelity (docx/xlsx/pptx) | Reference | Good, with layout drift | Very high; OOXML is its native model [VERIFIED claim from project README] | Good | High | Good |
| Engine architecture | Native C++ | C++ (VCL), UNO API, LibreOfficeKit C API [VERIFIED LOK] | JS canvas editors (sdkjs, web-apps) + C++ core + Node server [VERIFIED repos] | Web (canvas) | Native | Web |
| Embeddability | Office JS add-ins only | LibreOfficeKit (tiled rendering, convert, UNO commands) [VERIFIED] | DocumentServer API + plugins; Document Builder [VERIFIED plugin API exists] | Apps Script | Limited | APIs |
| AI integration | Copilot [PAID] | Minimal | AI plugin with your own key [UNVERIFIED] | Gemini [PAID] | WPS AI | Zia |
| Offline/local-first | Partial | Full | Full | Poor | Full | Poor |

## 2. Per-application lessons

| Reference app | What makes it effective (worth adopting) | Weakness to improve in Atlas |
|---|---|---|
| **Word** | Styles-first formatting; Navigation pane; track changes; robust tables; fields (TOC, cross-references) | AI bolted onto the side; style misuse is common. Atlas: let the AI apply **styles**, not direct formatting. |
| **Excel** | Formula language; tables with structured references; PivotTables; conditional formatting; dynamic arrays | Formula errors are opaque. Atlas: "Explain this error", plus formula provenance shown inline. |
| **PowerPoint** | Masters and layouts; Designer suggestions; Morph; presenter view | Generated decks look generic. Atlas: theme tokens from a design system, so the AI fills layouts instead of drawing free-form. |
| **Access** | Relational tables, query designer, forms and reports in one file | Old UI, Windows-only. Atlas Database: SQLite file + a visual schema tool + SQL + generated forms. |
| **OneNote** | Free-form canvas, notebooks, sections, pages; ink | Sync problems, weak export. Atlas Notes: Markdown-backed pages with optional canvas blocks. |
| **Publisher** (retired by Microsoft [UNVERIFIED date]) | Frame-based layout for print | Atlas Design covers this, with frames, bleed and CMYK export later. |
| **Visio** | Smart connectors, stencils, data-linked shapes | Expensive and proprietary. Atlas Diagram: an Excalidraw/React Flow style editor [UNVERIFIED licences: MIT] plus Mermaid import. |
| **Acrobat** | Annotation, forms, organising pages, OCR, redaction | Subscription. Atlas PDF: pdf.js viewer + qpdf/pikepdf for page operations + OCRmyPDF (Tesseract) [UNVERIFIED licences: Apache/MPL/MPL]. |

## 3. Implications for Atlas
1. **Fidelity versus control is the central trade-off.** ONLYOFFICE has the best OOXML fidelity, but it's AGPL, it's a server stack, and Atlas AI can only reach its document model through a plugin layer. A native editor (ProseMirror/Univer) gives Atlas AI typed access to the document model and full control of the UX, at the cost of round-trip fidelity. That gap is bridged with LibreOffice import/export. **Recommendation: native model + LibreOffice converter** (details in TECHNOLOGY_SELECTION.md).
2. **AI must work through structure:** styles, layouts, named ranges and themes. This is where Atlas can be better than incumbent suites: the AI edits semantic structures, and the user can always adjust them by hand.
3. **Local-first is a real differentiator.** Of the suites compared, only LibreOffice and ONLYOFFICE are fully offline on Linux. Atlas should keep that.
