#!/usr/bin/env bash
# Fresh, self-contained E2E run: temp data dir + sample files + dev stack + fake model + Playwright.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d /tmp/atlas-e2e.XXXXXX)"
DOCS="$WORK/home/Documents"
mkdir -p "$DOCS/reports"
printf '# Q3 plan\n\n- Ship Atlas Writer MVP\n- Usability test the Drive app\n' > "$DOCS/plan.md"
printf 'name,score\nada,9\nlin,8\n' > "$DOCS/reports/scores.csv"
printf 'Meeting notes from Monday.\n' > "$DOCS/notes.txt"
export ATLAS_DATA_DIR="$WORK/data" ATLAS_UI_PORT="${ATLAS_UI_PORT:-5174}" ATLAS_CORE_PORT="${ATLAS_CORE_PORT:-47811}" ATLAS_ENGINE_PORT="${ATLAS_ENGINE_PORT:-47812}"
pids=(); cleanup() { kill "${pids[@]}" 2>/dev/null || true; }; trap cleanup EXIT
"$ROOT/infrastructure/scripts/dev.sh" > "$WORK/dev.log" 2>&1 & pids+=($!)
python3 "$ROOT/tests/e2e/fake_llm.py" 47899 & pids+=($!)
for _ in $(seq 100); do grep -q 'http://127.0.0.1' "$WORK/dev.log" 2>/dev/null && break; sleep 0.2; done
URL=$(grep -o "http://127.0.0.1:${ATLAS_UI_PORT}/#[^ ]*" "$WORK/dev.log")
ATLAS_URL="$URL" DOCS="$DOCS" SHOTS="${SHOTS:-$ROOT/tests/e2e/screenshots}" node "$ROOT/tests/e2e/shell.e2e.mjs"
