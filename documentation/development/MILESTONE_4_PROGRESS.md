# Milestone 4 Progress — Sheets, and the Office-style interface

Feature research and the full gap list: [OFFICE_FEATURE_INVENTORY.md](../research/OFFICE_FEATURE_INVENTORY.md).

## Delivered

**Shared ribbon interface (Writer and Sheets)** — `apps/shell/src/ribbon/Ribbon.tsx`
- Document bar with back, title, save state and quick access (undo, redo, Atlas AI).
- Tabs → labelled groups → large and small commands; collapses to one line (button, double-click a tab, or Ctrl F1).
- File backstage with Info, Export and Close; contextual tabs (Chart Design).
- Status bar with a zoom slider. Atlas keeps its own icons, colours and names.

**Writer**
- Home (undo, font incl. sub/superscript and clear formatting, paragraph incl. justify, styles gallery, Find/Replace), Insert, Layout (A4/Letter), View (zoom, Atlas AI).
- Find & Replace (Ctrl F / Ctrl H) with match count, match case, Replace and Replace all (formatting kept).
- Font colour and highlight (stored as `<span style="color: #rrggbb">` / `background-color`, checked the same way in the shell and engine; kept on DOCX import and export).
- Font family and size (safe font allow-list and 8–72 pt controls; kept on save, DOCX import and export).
- Repeating page headers and footers (editable from Layout, stored in `.atlasdoc`, exposed to Atlas AI, and included in DOCX/ODT/PDF exports).
- Table of contents from Heading 1–3 blocks, with clickable links in the editor and DOCX/ODT/PDF exports; entries regenerate when headings change.
- Block comments with an optional selected-text quote, saved in `.atlasdoc`, shown in a review panel, and resolvable or deletable. Atlas AI can read them.
- Pictures (Insert → Picture): PNG, JPEG, GIF or WebP, scaled to at most 1600 px and stored in the document (limit about 3 MB each); a contextual Picture tab sets size (25–100%), position and alt text. Pictures are exported into DOCX/PDF/ODT.
- Word and character counts in the status bar; export to DOCX/PDF/ODT from File → Export.

**Sheets** — `apps/shell/src/sheets/SheetEditor.tsx`
- Type straight into cells; F2 to edit; Enter/Tab movement (Enter returns to the column where a Tab run started); arrows, Shift-extend, drag-select, row/column/all selection, Page Up/Down, Ctrl Home.
- Name box (type a cell or range to jump), cancel/enter buttons, click a cell to insert its reference while typing a formula.
- Cut/copy/paste as tab-separated text (keeps formulas and formats inside Atlas), undo/redo, Delete clears.
- Bold/italic/underline, font and fill colours, alignment, number formats (number, currency with 12 currencies, percent, date) and decimals. Colours round-trip through XLSX.
- Insert and delete rows and columns (Home → Cells); formula references, formats and chart ranges move with the data, and references to deleted cells become `#REF!`.
- AutoSum (Alt =) and Sum/Average/Count/Min/Max; status bar Average, Count and Sum of the selection.
- Sort A→Z / Z→A (keeps a header row), Find, gridlines toggle, freeze top row, zoom.
- Charts: column, bar, line and pie from a range; movable and resizable; Chart Design tab (type, title, data range, delete). Colours use a validated colour-blind-safe palette with light and dark steps.
- Formula engine (`formula.ts`): proper precedence, comparison and `&` operators, percentages, typed values, error values, cycle detection and ~110 functions across math, statistics, logic, lookup (VLOOKUP, HLOOKUP, XLOOKUP, INDEX/MATCH), text, date (1900 serials) and finance (PMT, FV, PV, NPV, IRR, NPER). Still no JavaScript execution.
- XLSX import/export of the first worksheet, and CSV. Export writes numbers and TRUE/FALSE as real cells (not text, so Excel's SUM counts them), keeps text like `007` as text, writes bold/italic/underline, alignment, number/currency/percent/date formats and Atlas's column widths, and writes charts as native Excel charts (`xl/charts/`) linked to the sheet's cells. Import reads the same formats and charts back, including from workbooks made by Excel or openpyxl. Formulas are recalculated when the file is opened (`fullCalcOnLoad`).

**Atlas AI `sheets.*` tools** — `services/engine/atlas_engine/sheets/tools.py`
- `sheets.create` (rows, formats and charts in one call), `sheets.read`, `sheets.write_range`, `sheets.format_range`, `sheets.create_chart`, `sheets.export_xlsx`.
- Open spreadsheets reload live when Atlas AI changes them, as Writer does.

## Still needed

- XLSX: read more than the first worksheet; fills, borders and fonts beyond bold/italic/underline; chart styling beyond series colours. ODS export.
- Multiple worksheets; column widths; fill handle; merge cells; borders.
- Conditional formatting, data validation, filters, comments; dynamic-array functions.
- Writer tier 2 remaining: preserving comments and headers/footers when importing existing Word files; DOCX/ODT/PDF comment export.
- Additional Sheets and Writer features listed above remain future work. Slides is tracked separately in [the Milestone 5 report](MILESTONE_5_REPORT.md).

## Fixes

- Core: the JSON parser re-validated the rest of the request for every character in a string, so large saves were quadratic (a document with a 1.4 MB picture never finished saving). It now copies runs of text at once; a 4 MB string parses in milliseconds, with a regression test.

## Verification (2026-11-14)

- `pnpm run build:shell` succeeds; TypeScript has no new errors.
- Engine tests: 31 passed. The Sheets tests include an end-to-end budget-with-chart run through the real core, an XLSX round trip of formats and charts, Excel number-format parsing, and an independent read of the exported workbook with openpyxl (skipped if openpyxl is not installed; CI installs it).
- Formula engine: 55 spreadsheet cases checked against documented results (e.g. NPV and IRR examples from Microsoft's docs).
- Manually checked in the dev stack: typing a table, Enter/Tab movement, AutoSum, currency format, status-bar sums, column and pie charts, Chart Design tab, XLSX export, Writer ribbon, File → Export to DOCX, Find & Replace, and a budget built by the `sheets.*` tools.
- `test:e2e` was updated for the ribbon (new Writer find/replace and Sheets steps) but **not run**: Playwright's browsers are not installed on this machine.
- XLSX compatibility with LibreOffice Calc was **not checked**: only LibreOffice Writer is installed (`sudo apt install libreoffice-calc` to check).
