#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PIDS=()
CLEANED_UP=0

cleanup() {
  if [ "$CLEANED_UP" -eq 1 ]; then
    return
  fi
  CLEANED_UP=1
  trap - INT TERM EXIT
  for pid in "${PIDS[@]:-}"; do
    if command -v pkill >/dev/null 2>&1; then
      pkill -TERM -P "$pid" 2>/dev/null || true
    fi
    kill -TERM "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}

trap cleanup INT TERM EXIT

wait_for_http() {
  local url="$1"
  local label="$2"
  local pid="$3"
  local attempts=0

  while [ "$attempts" -lt 60 ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[opsdeck-dev] $label exited before becoming healthy (ensure Docker infra is up via 'pnpm infra:up')." >&2
      return 1
    fi
    if node -e "fetch(process.argv[1]).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" "$url" 2>/dev/null; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 0.5
  done

  echo "[opsdeck-dev] Timed out waiting for $label at $url" >&2
  return 1
}

echo "[opsdeck-dev] Building opsdeck-server-ops..."
cargo build -p opsdeck-server-ops

echo "[opsdeck-dev] Starting server-ops (:8080)..."
./target/debug/opsdeck-server-ops &
SERVER_OPS_PID=$!
PIDS+=("$SERVER_OPS_PID")
wait_for_http "http://127.0.0.1:8080/healthz" "server-ops" "$SERVER_OPS_PID"

echo "[opsdeck-dev] Starting gateway (:8090)..."
(cd "$ROOT_DIR/apps/gateway" && go run .) &
GATEWAY_PID=$!
PIDS+=("$GATEWAY_PID")
wait_for_http "http://127.0.0.1:8090/healthz" "gateway" "$GATEWAY_PID"

echo "[opsdeck-dev] Starting host-api (:3001)..."
pnpm --filter @opsdeck/host-api dev &
HOST_API_PID=$!
PIDS+=("$HOST_API_PID")
wait_for_http "http://127.0.0.1:3001/api/health" "host-api" "$HOST_API_PID"

echo "[opsdeck-dev] Starting web (:5173)..."
pnpm --filter @opsdeck/web dev &
WEB_PID=$!
PIDS+=("$WEB_PID")

echo "[opsdeck-dev] All 4 services ready -> http://localhost:5173 (Ctrl-C to stop)"
wait
