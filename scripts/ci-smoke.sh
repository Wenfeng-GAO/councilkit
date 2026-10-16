#!/usr/bin/env bash
# CI-03 demo-path smoke: runs in a brand-new HOME with no agent CLI on PATH and
# no tokens. Proves a new user can install, start the Host and use the CLI
# without any account. When the mock driver lands (#272) this script also runs
# the mock review and asserts the report carries `demo: true`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NODE_DIR="$(dirname "$(command -v node)")"
export PATH="$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin"
unset GH_TOKEN GITHUB_TOKEN CURSOR_API_KEY 2>/dev/null || true

case "$HOME" in
  "" | /Users/runner | /home/runner) echo "ci-smoke: HOME must be a fresh directory, got '$HOME'" >&2; exit 1 ;;
esac
if [ -e "$HOME/.config/councilkit" ]; then
  echo "ci-smoke: $HOME/.config/councilkit already exists; HOME is not fresh" >&2
  exit 1
fi
for bin in cld codex kimi grok cursor-agent; do
  if command -v "$bin" >/dev/null 2>&1; then
    echo "ci-smoke: agent CLI '$bin' is on PATH; this smoke must run without any" >&2
    exit 1
  fi
done

CK="node cli/bin/councilkit.mjs"
step() { printf '\n== %s\n' "$*"; }

step "node $(node -v), HOME=$HOME"

step "councilkit --help"
$CK --help >/dev/null

step "councilkit init --json (no agent CLI: expect structured exit 2)"
set +e
init_out="$($CK init --json 2>&1)"
init_code=$?
set -e
echo "$init_out"
if [ "$init_code" -ne 2 ]; then
  echo "ci-smoke: expected init to exit 2 without any agent CLI, got $init_code" >&2
  exit 1
fi

step "councilkit runs list"
$CK runs list

step "Host start + /api/v1/health"
LOG="$(mktemp)"
node dist-host/main.mjs >"$LOG" 2>&1 &
HOST_PID=$!
trap 'kill "$HOST_PID" 2>/dev/null || true' EXIT
ok=""
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:43127/api/v1/health >"$LOG.health" 2>/dev/null; then ok=1; break; fi
  if ! kill -0 "$HOST_PID" 2>/dev/null; then break; fi
  sleep 0.5
done
if [ -z "$ok" ]; then
  echo "ci-smoke: Host did not become healthy" >&2
  cat "$LOG" >&2
  exit 1
fi
head -c 2000 "$LOG.health"; echo

step "councilkit demo (mock review, CI-03)"
$CK demo --json | tee "$LOG.demo"
grep -q '"demo": *true' "$LOG.demo"
demo_id="$(sed -n 's/.*"runId": *"\([^"]*\)".*/\1/p' "$LOG.demo" | head -1)"
[ -n "$demo_id" ] || { echo "ci-smoke: demo printed no runId" >&2; exit 1; }
step "demo report: first two lines carry demo: true (DM-04)"
head -2 "$HOME/.config/councilkit/runs/$demo_id/report.md" | tee "$LOG.demohead"
grep -q 'demo: true' "$LOG.demohead"
step "runs list marks the demo in its own column (DM-05)"
$CK runs list | tee "$LOG.runs"
grep -q "^$demo_id  review  completed  report  \[示例 DEMO\]" "$LOG.runs"
step "ci-smoke: OK"
