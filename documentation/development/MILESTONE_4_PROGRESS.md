# Milestone 4 Progress — Sheets MVP

## Delivered in this increment

- Added a spreadsheet editor in the Atlas shell with an 80 × 20 grid.
- Added `.atlasheet` files saved in user-shared folders, autosave, recent-file listing, and opening from Drive.
- Added CSV import into a new Atlas sheet and CSV export of calculated cell values.
- Added XLSX import/export through a dependency-free OOXML reader/writer. Import reads the first worksheet's values and formulas; export writes a single-sheet workbook that opens in LibreOffice.
- Added safe, built-in formula evaluation for cell references, ranges in aggregate functions, arithmetic, parentheses, and `SUM`, `AVERAGE`, `MIN`, `MAX`, and `COUNT`. Formula evaluation does not execute JavaScript.

## Still needed for the full milestone

- Charts and broader spreadsheet function / format compatibility.
- XLSX formatting and multiple worksheet preservation.
- `sheets.*` Atlas AI tools and the budget-with-chart milestone scenario.
- Broader manual and automated coverage.

## Verification (2026-11-14)

- `pnpm run build:shell` succeeds.
- `pnpm test:core` passes (16 tests); `test:engine` passes (23 tests) once `pytest` is installed.
- `test:e2e` was not run because Playwright's browsers are not installed on this machine. The placeholder step now checks Slides (Milestone 5), since Sheets is no longer a placeholder.
- Manually checked in the dev stack: share a folder, create a sheet, enter values and `=SUM(A1:A3)`, autosave to `.atlasheet`, reopen from the list.
- Fixed: aggregate functions now skip text cells in ranges (e.g. a header row) instead of returning `#VALUE!`.

## Known gaps in the editor

- Cells are edited only through the formula bar; there is no typing directly into cells and no arrow-key navigation yet.
