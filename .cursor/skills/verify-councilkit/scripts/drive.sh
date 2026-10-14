#!/usr/bin/env bash
# Drive one mapped feature. UI features need a healthy host from launch.sh.
set -euo pipefail

SCRIPT_SELF=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$SCRIPT_SELF/lib.sh"
verify_init
refuse_shared_if_held

FEATURE="${1:-}"
if [[ -z "$FEATURE" ]]; then
  echo "usage: drive.sh <home-landing|host-settings|reports-library|new-council|cli-init>" >&2
  exit 2
fi

if [[ "$FEATURE" != "cli-init" ]]; then
  node "$SCRIPT_DIR/doctor-check.mjs"
fi

exec node "$SCRIPT_DIR/drive.mjs" "$FEATURE"
