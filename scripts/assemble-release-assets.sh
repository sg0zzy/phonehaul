#!/usr/bin/env bash
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"
node "$PHONEHAUL_ROOT/scripts/shared/assemble-release.js" "$@"
