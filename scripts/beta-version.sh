#!/usr/bin/env bash
# Intended for the trusted manual beta workflow; local preview is read-only.
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"
case "${1:-next}" in
  next) node "$PHONEHAUL_ROOT/scripts/shared/official.js" reserve-beta "${2:-HEAD}" ;;
  allocate) PHONEHAUL_RESERVE_BETA=1 node "$PHONEHAUL_ROOT/scripts/shared/official.js" reserve-beta "${2:-HEAD}" ;;
  *) phonehaul_die 'usage: beta-version.sh next|allocate [commit]' ;;
esac
