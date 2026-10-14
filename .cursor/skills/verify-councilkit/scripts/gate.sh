#!/usr/bin/env bash
# Pre-merge gate for an unattended CouncilKit hunt.
# Order, fail-fast: install (only if needed), typecheck, baseline-relative
# lint, baseline-relative test, build, then baseline-relative Playwright when
# the diff touches src or UI. The e2e step fails only on new failing ids.
# Home-landing screenshots are captured whenever that step runs.
set -euo pipefail

SCRIPT_SELF=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$SCRIPT_SELF/lib.sh"
verify_init
refuse_shared_if_held

FORCE_E2E=0
for arg in "$@"; do
  case "$arg" in
    --force-e2e) FORCE_E2E=1 ;;
    -h|--help)
      echo "usage: gate.sh [--force-e2e]"
      echo "Merge only when this command exits 0, the PR body Verify section shows CI green for this SHA, and no unresolved Codex P1 remains on the latest commit. Otherwise leave the PR open and report."
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

UI_RE='^(src/|index\.html$|public/|tests/e2e/|playwright[^/]*\.config\.ts$|tailwind\.config\.ts$|postcss\.config\.js$|vite\.config\.ts$|runtime-host/|shared/)'

changed_files() {
  local base="" cand
  for cand in origin/main origin/master main master; do
    if git rev-parse --verify --quiet "${cand}^{commit}" >/dev/null; then
      base=$cand
      break
    fi
  done
  {
    if [[ -n "$base" ]]; then
      git diff --name-only "$(git merge-base HEAD "$base")" HEAD
    else
      echo "NO_MERGE_BASE"
    fi
    git diff --name-only
    git diff --name-only --cached
    git ls-files --others --exclude-standard
  } | sed '/^$/d' | sort -u
}

CHANGED="$(changed_files)"
UI_FILES="$(printf '%s\n' "$CHANGED" | grep -E "$UI_RE" || true)"
NO_BASE=0
if printf '%s\n' "$CHANGED" | grep -qx "NO_MERGE_BASE"; then
  NO_BASE=1
fi

DIRTY_FILE="$EVIDENCE/dirty-paths.txt"
EXTERNAL_FILE="$EVIDENCE/external-node-modules.txt"
mkdir -p "$EVIDENCE/logs"
external_node_modules_links >"$EXTERNAL_FILE" || true
git status --porcelain >"$DIRTY_FILE.raw" || true
: >"$DIRTY_FILE"
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" ]] && continue
  path="${line:3}"
  if [[ "$path" == \"*\" ]]; then
    path="${path#\"}"
    path="${path%\"}"
  fi
  case "$path" in
    node_modules|node_modules/)
      grep -q '^node_modules -> ' "$EXTERNAL_FILE" && continue
      ;;
    cli/node_modules|cli/node_modules/)
      grep -q '^cli/node_modules -> ' "$EXTERNAL_FILE" && continue
      ;;
  esac
  printf '%s\n' "$line" >>"$DIRTY_FILE"
done <"$DIRTY_FILE.raw"
node "$SCRIPT_DIR/summary.mjs" init \
  --dir "$EVIDENCE" \
  --sha "$SHA" \
  --branch "$BRANCH" \
  --repo "$ROOT_REAL" \
  --node "$(node -v)" \
  --started "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --dirty-file "$DIRTY_FILE" \
  --external-links-file "$EXTERNAL_FILE"

# Fail closed: a green gate must certify HEAD bytes, not uncommitted edits.
if [[ -s "$DIRTY_FILE" ]]; then
  {
    echo "gate refused: worktree is dirty; commit or stash before certifying HEAD"
    cat "$DIRTY_FILE"
  } | tee "$EVIDENCE/logs/dirty.log" >&2
  node "$SCRIPT_DIR/summary.mjs" finish --dir "$EVIDENCE" --ok false
  exit 2
fi

record_step() {
  local extra_args=()
  if [[ -f "$EVIDENCE/logs/${1}.extra.json" ]]; then
    extra_args+=(--extra-file "$EVIDENCE/logs/${1}.extra.json")
  fi
  node "$SCRIPT_DIR/summary.mjs" step \
    --dir "$EVIDENCE" \
    --name "$1" \
    --status "$2" \
    --exit "$3" \
    --log "$4" \
    --detail "$5" \
    --started "$6" \
    "${extra_args[@]}"
}

finish() {
  node "$SCRIPT_DIR/summary.mjs" finish --dir "$EVIDENCE" --ok "$1"
}

run_step() {
  local name="$1"
  shift
  local log="$EVIDENCE/logs/${name}.log"
  local started
  started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local code=0
  set +e
  {
    echo "node=$(node -v) pwd=$(pwd)"
    echo "command: $*"
    "$@"
  } >"$log" 2>&1
  code=$?
  set -e
  local status="pass"
  if [[ "$code" -ne 0 ]]; then
    status="fail"
  fi
  record_step "$name" "$status" "$code" "logs/${name}.log" "$*" "$started"
  if [[ "$code" -ne 0 ]]; then
    finish false
    echo "gate failed at ${name} (exit ${code}). Log: ${log}" >&2
    if [[ -f "$EVIDENCE/logs/${name}.extra.json" ]]; then
      node --input-type=commonjs -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (data.detail) console.error(data.detail);' "$EVIDENCE/logs/${name}.extra.json" >&2 || true
    fi
    exit "$code"
  fi
}

# Integrity pairs lockfile content with the current modules.yaml fingerprint.
# A foreign install into a shared node_modules target rewrites modules.yaml and
# invalidates the stamp even when pnpm-lock.yaml is unchanged.
LOCKFILE_SHA=""
MODULES_SHA=""
if [[ -f "$ROOT/pnpm-lock.yaml" ]]; then
  LOCKFILE_SHA=$(sha256sum "$ROOT/pnpm-lock.yaml" | awk '{print $1}')
fi
if [[ -f "$ROOT/node_modules/.modules.yaml" ]]; then
  MODULES_SHA=$(sha256sum "$ROOT/node_modules/.modules.yaml" | awk '{print $1}')
fi
LOCK_STAMP="$ROOT/node_modules/.councilkit-lockfile-sha"
EXPECTED_STAMP=""
if [[ -n "$LOCKFILE_SHA" && -n "$MODULES_SHA" ]]; then
  EXPECTED_STAMP="${LOCKFILE_SHA} ${MODULES_SHA}"
fi
write_lock_stamp() {
  if [[ -n "$EXPECTED_STAMP" && -d "$ROOT/node_modules" ]]; then
    # Recompute modules sha after install (install may rewrite modules.yaml).
    if [[ -f "$ROOT/node_modules/.modules.yaml" ]]; then
      MODULES_SHA=$(sha256sum "$ROOT/node_modules/.modules.yaml" | awk '{print $1}')
      EXPECTED_STAMP="${LOCKFILE_SHA} ${MODULES_SHA}"
    fi
    printf '%s\n' "$EXPECTED_STAMP" >"$LOCK_STAMP"
  fi
}

need_install=0
if [[ ! -d "$ROOT/node_modules/.bin" || ! -f "$ROOT/node_modules/.modules.yaml" ]]; then
  need_install=1
fi
if [[ -z "$EXPECTED_STAMP" ]]; then
  need_install=1
else
  stamped=""
  if [[ -f "$LOCK_STAMP" ]]; then
    stamped=$(tr -s '[:space:]' ' ' <"$LOCK_STAMP" | sed 's/[[:space:]]*$//' || true)
  fi
  if [[ "$stamped" != "$EXPECTED_STAMP" ]]; then
    need_install=1
  fi
fi

EXTERNAL_LINKS="$(cat "$EXTERNAL_FILE" 2>/dev/null || true)"
if [[ -n "$EXTERNAL_LINKS" ]]; then
  install_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [[ "$need_install" -eq 1 ]]; then
    {
      echo "refusing pnpm install --frozen-lockfile"
      echo "These symlinks resolve outside $ROOT_REAL. pnpm would rewrite the target:"
      printf '%s\n' "$EXTERNAL_LINKS"
      echo "Replace each symlink with a real node_modules directory inside this worktree (unlink the symlink only), then re-run the gate."
    } >"$EVIDENCE/logs/install.log"
    record_step install fail 1 "logs/install.log" "refusing pnpm install: node_modules symlink points outside this worktree" "$install_started"
    finish false
    echo "gate failed at install (exit 1). Log: $EVIDENCE/logs/install.log" >&2
    exit 1
  fi
  record_step install skip 0 "" "skipped pnpm install; lockfile+modules.yaml stamp matches and the node_modules symlink points outside this worktree ($(printf '%s' "$EXTERNAL_LINKS" | tr '\n' ' '))" "$install_started"
elif [[ "$need_install" -eq 1 ]]; then
  run_step install pnpm install --frozen-lockfile
  write_lock_stamp
else
  write_lock_stamp
  record_step install skip 0 "" "node_modules lockfile+modules.yaml stamp matches; pnpm install --frozen-lockfile skipped" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi

run_step typecheck pnpm typecheck
run_step lint node "$SCRIPT_DIR/lint-baseline.mjs" --extra-out "$EVIDENCE/logs/lint.extra.json"
run_step test node "$SCRIPT_DIR/test-baseline.mjs" --extra-out "$EVIDENCE/logs/test.extra.json" --report-out "$EVIDENCE/logs/vitest.json"
run_step build pnpm build

port_busy() {
  local pids
  pids=$(node "$SCRIPT_DIR/proc.mjs" listeners --port "$1")
  [[ -n "$pids" ]]
}

choose_broad_e2e() {
  E2E_PORT=$(node "$SCRIPT_DIR/proc.mjs" free-port)
  E2E_SUITE="playwright.config.ts"
  E2E_PORT_MODE="isolated"
  E2E_DETAIL="pnpm exec playwright test -c playwright.config.ts --reporter=json COUNCILKIT_E2E_PORT=$E2E_PORT"
}

choose_fixed_e2e() {
  local suite="$1"
  local port="$2"
  E2E_SUITE="$suite"
  E2E_PORT="$port"
  E2E_PORT_MODE="fixed:$port"
  E2E_DETAIL="pnpm exec playwright test -c $suite --reporter=json (fixed port $port)"
}

pick_e2e() {
  E2E_DETAIL=""
  E2E_SUITE=""
  E2E_PORT=""
  E2E_PORT_MODE=""
  if [[ "$FORCE_E2E" -eq 0 && "$NO_BASE" -eq 0 && -z "$UI_FILES" ]]; then
    E2E_DETAIL="diff does not touch src or UI; pnpm test:e2e skipped"
    return 1
  fi
  local only="$UI_FILES"
  local broad=0
  if [[ "$NO_BASE" -eq 1 || "$FORCE_E2E" -eq 1 ]]; then
    broad=1
  fi
  if printf '%s\n' "$only" | grep -qE '^(src/|index\.html$|public/|runtime-host/|shared/|tailwind\.config\.ts$|postcss\.config\.js$|vite\.config\.ts$|playwright\.config\.ts$)'; then
    broad=1
  fi
  if printf '%s\n' "$only" | grep -qE '^tests/e2e/' && printf '%s\n' "$only" | grep -qvE '^tests/e2e/(review-explainer/|repair-observability/|repair-panel-ui\.spec\.ts$|finding-ledger-layout\.spec\.ts$)'; then
    broad=1
  fi
  if [[ "$broad" -eq 1 ]]; then
    choose_broad_e2e
    return 0
  fi
  local kinds=0
  if printf '%s\n' "$only" | grep -qE '^(tests/e2e/review-explainer/|playwright\.review-explainer\.config\.ts$)'; then
    kinds=$((kinds + 1))
    choose_fixed_e2e "playwright.review-explainer.config.ts" 43839
  fi
  if printf '%s\n' "$only" | grep -qE '^(tests/e2e/repair-observability/|playwright\.repair-observability\.config\.ts$)'; then
    kinds=$((kinds + 1))
    choose_fixed_e2e "playwright.repair-observability.config.ts" 43837
  fi
  if printf '%s\n' "$only" | grep -qE '^(tests/e2e/repair-panel-ui\.spec\.ts$|playwright\.repair-ui\.config\.ts$)'; then
    kinds=$((kinds + 1))
    choose_fixed_e2e "playwright.repair-ui.config.ts" 4188
  fi
  if printf '%s\n' "$only" | grep -qE '^(tests/e2e/finding-ledger-layout\.spec\.ts$|playwright\.preview\.config\.ts$)'; then
    kinds=$((kinds + 1))
    choose_fixed_e2e "playwright.preview.config.ts" 4179
  fi
  if [[ "$kinds" -ne 1 ]]; then
    choose_broad_e2e
  fi
  return 0
}

append_extra_detail() {
  local file="$1"
  local note="$2"
  [[ -f "$file" ]] || return 0
  node --input-type=module - "$file" "$note" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const [file, note] = process.argv.slice(2);
const data = JSON.parse(readFileSync(file, "utf8"));
data.detail = data.detail ? `${data.detail}; ${note}` : note;
writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
NODE
}

run_e2e_baseline() {
  local -a cmd
  cmd=(
    node "$SCRIPT_DIR/e2e-baseline.mjs"
    --extra-out "$EVIDENCE/logs/e2e.extra.json"
    --report-out "$EVIDENCE/logs/playwright.json"
    --artifacts-out "$EVIDENCE/e2e"
    --suite "$E2E_SUITE"
    --port-mode "$E2E_PORT_MODE"
  )
  if [[ "$E2E_PORT_MODE" == "isolated" ]]; then
    env "COUNCILKIT_E2E_PORT=$E2E_PORT" "${cmd[@]}"
  else
    env -u COUNCILKIT_E2E_PORT "${cmd[@]}"
  fi
}

capture_screenshots() {
  local code=0
  local clean=0
  "$SCRIPT_DIR/launch.sh" --production || code=$?
  if [[ "$code" -eq 0 ]]; then
    "$SCRIPT_DIR/doctor.sh" || code=$?
  fi
  if [[ "$code" -eq 0 ]]; then
    "$SCRIPT_DIR/drive.sh" home-landing || code=$?
  fi
  "$SCRIPT_DIR/cleanup.sh" || clean=$?
  if [[ "$code" -eq 0 ]]; then
    code=$clean
  fi
  return "$code"
}

run_e2e() {
  if ! pick_e2e; then
    record_step e2e skip 0 "" "$E2E_DETAIL" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    return 0
  fi
  if [[ "$E2E_PORT_MODE" == fixed:* ]]; then
    if port_busy "$E2E_PORT"; then
      local started
      started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      {
        echo "port $E2E_PORT is in use. Listeners (not signaled):"
        node "$SCRIPT_DIR/proc.mjs" listeners --port "$E2E_PORT" || true
      } >"$EVIDENCE/logs/e2e.log"
      record_step e2e fail 1 "logs/e2e.log" "port $E2E_PORT is held; gate will not kill the listener. $E2E_DETAIL" "$started"
      finish false
      exit 1
    fi
  fi
  local started code shot_code shot_note
  started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  code=0
  set +e
  {
    echo "node=$(node -v) pwd=$(pwd)"
    echo "command: ${E2E_DETAIL}"
    echo "ui files:"
    printf '%s\n' "$UI_FILES"
    run_e2e_baseline
  } >"$EVIDENCE/logs/e2e.log" 2>&1
  code=$?
  set -e
  # Realistic UI evidence, including when every Playwright failure is already in the baseline.
  set +e
  capture_screenshots >"$EVIDENCE/logs/e2e-screenshots.log" 2>&1
  shot_code=$?
  set -e
  if [[ "$shot_code" -eq 0 ]]; then
    shot_note="screenshots in drive/home-landing/"
  else
    shot_note="screenshot drive failed"
  fi
  append_extra_detail "$EVIDENCE/logs/e2e.extra.json" "$shot_note" || true
  if [[ "$code" -ne 0 ]]; then
    record_step e2e fail "$code" "logs/e2e.log" "$E2E_DETAIL; $shot_note" "$started"
    finish false
    echo "gate failed at e2e (exit ${code}). Log: $EVIDENCE/logs/e2e.log" >&2
    if [[ -f "$EVIDENCE/logs/e2e.extra.json" ]]; then
      node --input-type=commonjs -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (data.detail) console.error(data.detail);' "$EVIDENCE/logs/e2e.extra.json" >&2 || true
    fi
    exit "$code"
  fi
  if [[ "$shot_code" -ne 0 ]]; then
    record_step e2e fail "$shot_code" "logs/e2e-screenshots.log" "$E2E_DETAIL; $shot_note" "$started"
    finish false
    echo "gate failed while capturing UI screenshots (exit ${shot_code})." >&2
    exit "$shot_code"
  fi
  record_step e2e pass 0 "logs/e2e.log" "$E2E_DETAIL; $shot_note" "$started"
}

run_e2e
finish true
echo "gate passed sha=$SHA evidence=$EVIDENCE"
echo "Merge only when this gate exits 0, the PR body Verify section shows CI green for this SHA, and no unresolved Codex P1 remains on the latest commit. Otherwise leave the PR open and report."
