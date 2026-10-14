#!/usr/bin/env bash
# Stop the host this run started and delete its /tmp scratch home.
# Leaves artifacts/verify/<sha>/ in place. Never signals by process name.
set -euo pipefail

SCRIPT_SELF=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$SCRIPT_SELF/lib.sh"
verify_init
refuse_shared_if_held --except-verify-host
exec node "$SCRIPT_DIR/cleanup.mjs"
