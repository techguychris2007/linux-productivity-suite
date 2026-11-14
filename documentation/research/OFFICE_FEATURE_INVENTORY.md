# Office feature inventory and Atlas gap list

Researched 2026-11-14 to plan Atlas Writer, Sheets and Slides against current Microsoft 365 Word, Excel and PowerPoint.
Atlas copies the *conventions* people know (ribbon with tabs and groups, File backstage, status bar, keyboard
shortcuts, formula names) but not Microsoft's logos, icons, product names or exact colours.

Sources: [Excel functions by category](https://support.microsoft.com/en-us/office/excel-functions-by-category-5f91f4e9-7b42-46d2-9bd1-63f26a86c0eb),
[Customize the ribbon in Word](https://support.microsoft.com/en-us/word/customize-the-ribbon-in-word-1),
[Word ribbon tabs guide](https://itsourcecode.com/ms-word/ms-word-ribbon-how-to-use/),
[Where are the menus and toolbars? (PowerPoint)](https://support.microsoft.com/en-us/powerpoint/where-are-the-menus-and-toolbars),
[Handy Excel features](https://www.howtogeek.com/807862/handy-excel-features/),
[Copilot placement changes, 2026](https://office-watch.com/2026/copilot-button-move-to-ribbon/).

Status key: ✅ in Atlas · 🟡 partial · ⬜ not yet · ⛔ not planned (reason given).
Tier: **1** = this milestone, **2** = next, **3** = later.

## Shared interface

| Feature | Office | Atlas | Tier |
|---|---|---|---|
| Ribbon: tabs → labelled groups → commands, collapsible to one line (Ctrl F1) | ✓ | ✅ (this increment) | 1 |
| File backstage: Info, New, Open, Save a copy, Export, Print, Close | ✓ | 🟡 Info, Export, Close | 1 |
| Quick access (undo/redo), title with save state | ✓ | ✅ | 1 |
| Contextual tabs (Picture, Table, Chart Design) | ✓ | 🟡 Chart Design | 1 |
| Status bar with zoom slider | ✓ | ✅ | 1 |
| Search / "Tell me" command search | ✓ | 🟡 global search (Ctrl K) only | 2 |
| AI assistant pane acting on the selection | Copilot | 🟡 Atlas AI pane (document-level) | 2 |
| Real-time co-authoring, cloud comments, sharing | ✓ | ⛔ local-first; revisit after sync design | 3 |
| Macros / VBA | ✓ | ⛔ security risk; Atlas AI tools cover automation | — |

## Excel → Atlas Sheets

| Area | Office features | Atlas | Tier |
|---|---|---|---|
| Editing | type into cells, F2, Enter/Tab movement, arrow keys, Shift-select, drag-select, fill handle, undo/redo, cut/copy/paste (TSV), Delete clears | ⬜ → 1 (fill handle: 2) | 1 |
| Formatting | bold/italic/underline, alignment, number formats (general, number, currency, percent, date), decimals ±, font colour, fill colour, borders, merge & centre, wrap text, column width | ✅ B/I/U, align, number/currency/percent/date, decimals, font & fill colours; borders, merge, widths in 2 | 1–2 |
| Formulas | ~500 functions in 14 categories (logical, lookup/reference, text, date/time, math/trig, statistical, financial, information, database, engineering, cube, web, compatibility, dynamic arrays) | 🟡 5 → ~80 most-used (IF, IFS, AND/OR/NOT, IFERROR, SUMIF(S), COUNTIF(S), AVERAGEIF, ROUND*, ABS, INT, MOD, POWER, SQRT, PRODUCT, MEDIAN, STDEV, LARGE/SMALL, RANK, VLOOKUP/HLOOKUP/XLOOKUP/INDEX/MATCH, CONCAT/TEXTJOIN/LEFT/RIGHT/MID/LEN/UPPER/LOWER/PROPER/TRIM/SUBSTITUTE/FIND/TEXT/VALUE, DATE/TODAY/NOW/YEAR/MONTH/DAY/WEEKDAY/DAYS/EDATE/EOMONTH, PMT/FV/PV/NPV, ISNUMBER/ISBLANK/ISTEXT), comparison operators and `&` | 1 |
| | cube, web service, LAMBDA/LET, dynamic-array spill (FILTER, SORT, UNIQUE, SEQUENCE) | ⬜ | 3 |
| Formula bar | name box (jump to cell), fx, cancel/enter, click-to-reference while editing | ⬜ → 1 | 1 |
| AutoSum and status-bar Sum / Average / Count of the selection | ✓ | ⬜ → 1 | 1 |
| Charts | column, bar, line, pie, area, scatter, combo, chart title, legend, axis titles, Chart Design tab | ⬜ → column/bar/line/pie + title + legend + Chart Design in 1; area/scatter in 2 | 1 |
| Data | sort, filter, remove duplicates, data validation, text to columns, flash fill, what-if | ⬜ → sort in 1; filter, validation in 2; flash fill 3 | 1–3 |
| Structure | insert/delete rows & columns (with reference adjustment), multiple worksheets, freeze panes, hide rows/cols, named ranges, tables | 🟡 insert/delete rows & columns ✅, freeze top row ✅; rest ⬜ | 2 |
| Analysis | conditional formatting, sparklines, PivotTables, slicers | ⬜ | 2–3 |
| Review | comments/notes, protect sheet | ⬜ | 2 |
| Files | XLSX import/export, CSV, ODS, print/PDF | ✅ XLSX, CSV; ODS/PDF 2 | — |

## Word → Atlas Writer

| Tab | Office features | Atlas | Tier |
|---|---|---|---|
| Home | clipboard, font family/size/colour/highlight, B/I/U/S, sub/superscript, clear formatting, lists, indent, alignment incl. justify, line spacing, styles gallery, find/replace | 🟡 ribbon, font family/size/colour/highlight, sub/sup, clear, justify, styles gallery and find/replace ✅; indent/spacing 2 | 1–2 |
| Insert | tables, pictures, shapes, links, page break, header/footer, page numbers, symbols, equations, text box, comments | 🟡 tables, links, page breaks, pictures (size, position, alt text), repeating header/footer text ✅; page numbers, comments 2 | 2 |
| Design | themes, colour schemes, watermark, page colour/borders | ⬜ | 3 |
| Layout | margins, orientation, size, columns, breaks, indent/spacing | 🟡 size (A4/Letter); margins/orientation 2 | 2 |
| References | table of contents, footnotes/endnotes, citations, captions, index | 🟡 linked TOC generated from Heading 1–3; footnotes/endnotes and citations 2–3 | 2–3 |
| Mailings | mail merge, envelopes, labels | ⬜ (could merge from a Sheets file) | 3 |
| Review | spelling & grammar, word count, read aloud, comments, track changes, compare, protect | 🟡 word count; spelling via system spell-check; comments/track changes 2 | 2 |
| View | read mode, print layout, ruler, navigation pane, zoom, focus mode | 🟡 zoom; navigation pane 2 | 2 |
| Files | DOCX/ODT/PDF export, DOCX/ODT/RTF/HTML import, print | ✅ | — |

## PowerPoint → Atlas Slides (Milestone 5)

**Available in the first Slides release:** Office-style ribbon, create/open/save Atlas `.atlasdeck` presentations, six layouts,
five themes, editable and movable/resizable text boxes, slide reorder/duplicate/delete, speaker notes, outline and slide-sorter
views, audience and presenter modes with a timer, PPTX export (including speaker notes), and `slides.*` AI tools for creating,
reading, editing, reorganizing, theming, and exporting decks.

**Still missing:** opening/importing PPTX, images and other media, shapes, tables, charts, transitions, animations, review tools,
custom slide size, and design suggestions. The editor uses a fixed 16:9 canvas; its native `.atlasdeck` format is JSON.

## Other Office apps

Access → Atlas Database (Milestone 7), OneNote → Notes (8), Forms → Forms (8), Visio → Diagram (8),
Outlook / Teams → not planned for the suite.

## Milestone 4 build order

1. Ribbon interface for Writer and Sheets.
2. Sheets editor: in-cell editing, keyboard, ranges, clipboard, undo, formatting, number formats, AutoSum, status-bar stats, sort.
3. ~80 common functions plus comparison and text operators.
4. Charts: column, bar, line, pie, with a Chart Design tab.
5. Writer: find & replace.
6. `sheets.*` Atlas AI tools (create, read, write range, format, chart) for the "AI builds a budget with a chart" scenario.
