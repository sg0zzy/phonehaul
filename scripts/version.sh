#!/usr/bin/env bash
# Explicit version bump: see VERSIONING.md for authorization and recovery.
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"
case "${1:-}" in
  show) node "$PHONEHAUL_ROOT/scripts/shared/version.js" json ;;
  bump|set) node "$PHONEHAUL_ROOT/scripts/shared/version-operation.js" "$@" ;;
  *) echo 'usage: scripts/version.sh show | bump major|minor|patch [description] [--dry-run] | set X.Y.Z-dev.0 [--dry-run]'; exit 2 ;;
esac
