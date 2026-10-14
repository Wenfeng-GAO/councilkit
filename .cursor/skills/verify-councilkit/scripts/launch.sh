#!/usr/bin/env bash
# Start one isolated CouncilKit Runtime Host. Default is `pnpm dev`.
# `--production` runs `pnpm start` after `pnpm build` has produced dist-host.
set -euo pipefail

SCRIPT_SELF=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$SCRIPT_SELF/lib.sh"
verify_init
refuse_shared_if_held

MODE="development"
for arg in "$@"; do
  case "$arg" in
    --development) MODE="development" ;;
    --production) MODE="production" ;;
    -h|--help)
      echo "usage: launch.sh [--development|--production]"
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ -f "$STATE" ]]; then
  existing_mode=$(node -p "try{JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).mode}catch(e){''}" "$STATE" 2>/dev/null || true)
  if node "$SCRIPT_DIR/doctor-check.mjs" >/dev/null 2>&1; then
    if [[ "$existing_mode" == "$MODE" ]]; then
      node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).origin" "$STATE"
      echo "already running"
      exit 0
    fi
    echo "a verification host is already running in mode ${existing_mode}; run cleanup.sh before launching $MODE" >&2
    exit 2
  fi
  node "$SCRIPT_DIR/cleanup.mjs" || true
fi

if [[ "$MODE" == "production" && ! -f "$ROOT/dist-host/main.mjs" ]]; then
  echo "dist-host/main.mjs is missing. Run pnpm build, then launch.sh --production." >&2
  exit 1
fi

if [[ "$MODE" == "development" ]]; then
  HOST_CMD=(pnpm dev)
else
  HOST_CMD=(pnpm start)
fi

SCRATCH=$(mktemp -d /tmp/verify-councilkit.XXXXXX)
mkdir -m 0700 "$SCRATCH/home"
LOG="$EVIDENCE/host.log"
CHILD_PID_FILE="$EVIDENCE/host.child.pid"
mkdir -p "$EVIDENCE"

write_state() {
  local port="$1"
  local supervisor="$2"
  local status="$3"
  node --input-type=module - "$STATE" "$port" "$supervisor" "$status" "$MODE" "$SHA" "$ROOT_REAL" "$SCRATCH" "$LOG" <<'NODE'
import { writeFileSync } from "node:fs";
const [path, port, supervisor, status, mode, sha, cwd, scratch, log] = process.argv.slice(2);
const state = {
  status,
  mode,
  supervisorPid: Number(supervisor),
  port: Number(port),
  origin: `http://127.0.0.1:${port}`,
  cwd,
  sha,
  scratchRoot: scratch,
  scratchHome: `${scratch}/home`,
  log,
  command: mode === "production" ? ["pnpm", "start"] : ["pnpm", "dev"],
  startedAt: new Date().toISOString(),
};
writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
NODE
}

mark_running() {
  node --input-type=module - "$STATE" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const path = process.argv[2];
const state = JSON.parse(readFileSync(path, "utf8"));
state.status = "running";
writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
NODE
}

cleanup_attempt() {
  node "$SCRIPT_DIR/cleanup.mjs" || true
}

wait_ready() {
  local supervisor="$1"
  local i code
  for i in $(seq 1 90); do
    if ! kill -0 "$supervisor" 2>/dev/null; then
      return 1
    fi
    # `if` with no else returns 0 when the check is not ready, so capture the
    # doctor exit code directly. Exit 10 means retry; anything else stops.
    node "$SCRIPT_DIR/doctor-check.mjs" >>"$LOG" 2>&1
    code=$?
    if [[ "$code" -eq 0 ]]; then
      return 0
    fi
    if [[ "$code" -ne 10 ]]; then
      return "$code"
    fi
    sleep 1
  done
  echo "timed out waiting for the Runtime Host to become usable" >&2
  return 1
}

attempt=1
while [[ "$attempt" -le 5 ]]; do
  PORT=$(node "$SCRIPT_DIR/proc.mjs" free-port)
  if [[ "$PORT" == "43127" ]]; then
    echo "refusing to bind canonical port 43127" >&2
    exit 2
  fi
  {
    echo "----- launch attempt ${attempt} port ${PORT} mode ${MODE} -----"
  } >>"$LOG"
  export COUNCILKIT_E2E=1
  export COUNCILKIT_PORT="$PORT"
  export COUNCILKIT_HOME="$SCRATCH/home"
  unset COUNCILKIT_MODE || true
  if command -v setsid >/dev/null 2>&1; then
    setsid node "$SCRIPT_DIR/host-supervise.mjs" \
      --log "$LOG" \
      --child-pid-file "$CHILD_PID_FILE" \
      -- "${HOST_CMD[@]}" >>"$LOG" 2>&1 < /dev/null &
  else
    node "$SCRIPT_DIR/host-supervise.mjs" \
      --log "$LOG" \
      --child-pid-file "$CHILD_PID_FILE" \
      -- "${HOST_CMD[@]}" >>"$LOG" 2>&1 < /dev/null &
  fi
  SUPERVISOR=$!
  write_state "$PORT" "$SUPERVISOR" "starting"
  set +e
  wait_ready "$SUPERVISOR"
  ready_code=$?
  set -e
  if [[ "$ready_code" -eq 0 ]]; then
    mark_running
    echo "http://127.0.0.1:${PORT}"
    exit 0
  fi
  cleanup_attempt
  if grep -q "UNSUPPORTED_NODE" "$LOG"; then
    echo "Runtime Host requires Node.js 22.x. Resolved node is $(command -v node) ($(node -v))." >&2
    exit 1
  fi
  if grep -q "PORT_IN_USE" "$LOG"; then
    attempt=$((attempt + 1))
    continue
  fi
  echo "Runtime Host failed to become ready (doctor exit ${ready_code}). Log: $LOG" >&2
  tail -n 40 "$LOG" >&2 || true
  exit 1
done

echo "could not bind a free non-canonical port after 5 attempts" >&2
exit 1
