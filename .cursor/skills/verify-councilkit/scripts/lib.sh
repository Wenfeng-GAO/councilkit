# Shared helpers for verify-councilkit. Source this file; do not execute it.
# shellcheck shell=bash

verify_init() {
  if [[ "${VERIFY_INIT:-}" == "1" ]]; then
    return 0
  fi
  VERIFY_INIT=1
  SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  ROOT=$(cd -P "$SCRIPT_DIR/../../../.." && pwd -P)
  ROOT_REAL=$ROOT
  if [[ ! -f "$ROOT/package.json" ]]; then
    echo "verify-councilkit: $ROOT has no package.json" >&2
    exit 2
  fi
  local name
  name=$(node -p "JSON.parse(require('fs').readFileSync('$ROOT/package.json','utf8')).name")
  if [[ "$name" != "councilkit" ]]; then
    echo "verify-councilkit: $ROOT is not the councilkit repo (package name is $name)" >&2
    exit 2
  fi
  local node_bin
  node_bin=$(resolve_node22) || exit 1
  export PATH="$(dirname "$node_bin"):$PATH"
  hash -r
  cd "$ROOT"
  SHA=$(git rev-parse HEAD)
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  EVIDENCE="$ROOT/artifacts/verify/$SHA"
  STATE="$EVIDENCE/run-state.json"
  SHARED_REAL=""
  if [[ -d /workspace/councilkit ]]; then
    SHARED_REAL=$(realpath /workspace/councilkit)
  fi
  export VERIFY_INIT SCRIPT_DIR ROOT ROOT_REAL SHA BRANCH EVIDENCE STATE SHARED_REAL
  export VERIFY_ROOT="$ROOT_REAL"
  export VERIFY_SHA="$SHA"
  export VERIFY_EVIDENCE="$EVIDENCE"
  export VERIFY_STATE="$STATE"
  export VERIFY_ENTRY=1
}

resolve_node22() {
  local candidate major
  local -a candidates=()
  if [[ -n "${COUNCILKIT_NODE:-}" ]]; then
    candidates+=("$COUNCILKIT_NODE")
  fi
  if command -v node >/dev/null 2>&1; then
    candidates+=("$(command -v node)")
  fi
  if [[ -x /home/box/.local/node/bin/node ]]; then
    candidates+=("/home/box/.local/node/bin/node")
  fi
  local shopt_state
  shopt_state=$(shopt -p nullglob || true)
  shopt -s nullglob
  local nvm_node
  for nvm_node in "$HOME/.nvm/versions/node/v22."*/bin/node; do
    candidates+=("$nvm_node")
  done
  eval "$shopt_state"
  local seen=" "
  for candidate in "${candidates[@]}"; do
    if [[ ! -x "$candidate" ]]; then
      continue
    fi
    if [[ "$seen" == *" $candidate "* ]]; then
      continue
    fi
    seen+=" $candidate "
    major=$("$candidate" -p "process.versions.node.split('.')[0]" 2>/dev/null || true)
    if [[ "$major" == "22" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  echo "CouncilKit Runtime Host requires Node.js 22.x. Set COUNCILKIT_NODE to a Node 22 binary." >&2
  return 1
}

# Comma-separated PIDs for the recorded verification supervisor tree, if state
# still names that host. Empty when there is no matching recorded host.
recorded_verify_host_pids() {
  if [[ ! -f "${STATE:-}" ]]; then
    return 0
  fi
  node --input-type=module - "$STATE" "$SCRIPT_DIR/proc.mjs" <<'NODE'
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const statePath = process.argv[2];
const procUrl = pathToFileURL(process.argv[3]).href;
const { descendants, isVerificationProcess, readProc } = await import(procUrl);
let state;
try {
  state = JSON.parse(readFileSync(statePath, "utf8"));
} catch {
  process.exit(0);
}
if (!state || state.status === "stopped" || !state.supervisorPid || !state.cwd) process.exit(0);
const supervisor = readProc(state.supervisorPid);
if (!supervisor || !isVerificationProcess(supervisor, state.cwd)) process.exit(0);
if (
  state.supervisorStarttime != null &&
  supervisor.starttime !== state.supervisorStarttime
) {
  process.exit(0);
}
process.stdout.write(descendants(state.supervisorPid).join(","));
NODE
}

refuse_shared_if_held() {
  if [[ -z "${SHARED_REAL:-}" || "$ROOT_REAL" != "$SHARED_REAL" ]]; then
    return 0
  fi
  local exclude=""
  if [[ "${1:-}" == "--except-verify-host" ]]; then
    exclude=$(recorded_verify_host_pids || true)
  fi
  local holders
  if [[ -n "$exclude" ]]; then
    holders=$(node "$SCRIPT_DIR/proc.mjs" holders --root "$ROOT_REAL" --exclude "$exclude")
  else
    holders=$(node "$SCRIPT_DIR/proc.mjs" holders --root "$ROOT_REAL")
  fi
  if [[ -n "$holders" ]]; then
    echo "REFUSE: $ROOT_REAL is the shared CouncilKit checkout and another process holds it." >&2
    echo "This run will not install, build, test, or bind a Host there, and it will not signal those processes." >&2
    echo "$holders" >&2
    exit 2
  fi
  mkdir -p "$EVIDENCE"
}

# Symlinks named node_modules are not matched by the gitignore rule `node_modules/`.
# pnpm install follows them and rewrites the target. Print "rel -> realpath" when
# the target sits outside this worktree.
external_node_modules_links() {
  local rel target
  for rel in node_modules cli/node_modules; do
    if [[ ! -L "$ROOT/$rel" ]]; then
      continue
    fi
    target=$(realpath "$ROOT/$rel" 2>/dev/null || true)
    if [[ -z "$target" ]]; then
      continue
    fi
    case "$target" in
      "$ROOT_REAL"|"$ROOT_REAL"/*) ;;
      *) printf '%s -> %s\n' "$rel" "$target" ;;
    esac
  done
}

evidence_dir() {
  echo "$EVIDENCE"
}
