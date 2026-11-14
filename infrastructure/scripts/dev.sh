#!/usr/bin/env bash
# Start the Atlas development stack: Rust core host, Python engine, and the shell UI.
# Everything binds to 127.0.0.1 only. Ctrl+C stops all three.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export ATLAS_DATA_DIR="${ATLAS_DATA_DIR:-$HOME/.local/share/atlas-dev}"
UI_PORT="${ATLAS_UI_PORT:-5173}"
export ATLAS_CORE_PORT="${ATLAS_CORE_PORT:-47801}"
export ATLAS_ENGINE_PORT="${ATLAS_ENGINE_PORT:-47802}"
export ATLAS_DEV_ORIGIN="http://127.0.0.1:${UI_PORT}"

echo "→ building core"; (cd "$ROOT/crates/atlas-core" && cargo build --release -q)
echo "→ building shell"; (cd "$ROOT/apps/shell" && node build.mjs >/dev/null)

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

rm -f "$ATLAS_DATA_DIR/runtime/core.json"
"$ROOT/crates/atlas-core/target/release/atlas-core-host" & pids+=($!)
for _ in $(seq 50); do [ -f "$ATLAS_DATA_DIR/runtime/core.json" ] && break; sleep 0.1; done
(cd "$ROOT/services/engine" && python3 -m atlas_engine.devserver --port "$ATLAS_ENGINE_PORT") & pids+=($!)
python3 "$ROOT/infrastructure/scripts/serve_spa.py" "$ROOT/apps/shell/dist" "$UI_PORT" & pids+=($!)
sleep 0.5

TOKEN=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['ui_token'])" "$ATLAS_DATA_DIR/runtime/core.json")
echo
echo "Atlas is running. Open:"
echo "  http://127.0.0.1:${UI_PORT}/#token=${TOKEN}&core=${ATLAS_CORE_PORT}&engine=${ATLAS_ENGINE_PORT}"
echo "(data: $ATLAS_DATA_DIR)"
wait
