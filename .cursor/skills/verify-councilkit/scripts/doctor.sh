#!/usr/bin/env bash
# Read-only: is the verification Runtime Host up, ours, and usable?
set -euo pipefail

SCRIPT_SELF=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$SCRIPT_SELF/lib.sh"
verify_init
refuse_shared_if_held
exec node "$SCRIPT_DIR/doctor-check.mjs"
