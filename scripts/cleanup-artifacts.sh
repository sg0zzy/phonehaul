#!/usr/bin/env bash
# Managed storage maintenance; implementation and containment in shared/artifacts.js.
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"
keep=10
op=clean
id=""
flags=()
while (($#)); do
  case "$1" in
    --dry-run) flags+=(--dry-run) ;;
    --keep) shift; keep="${1:?--keep needs a count}" ;;
    --keep=*) keep="${1#--keep=}" ;;
    --list) op=list ;;
    --protect|--unprotect|--remove) op="${1#--}"; shift; id="${1:?build ID required}" ;;
    --yes) flags+=(--yes) ;;
    --verbose) ;;
    -h|--help) echo 'cleanup-artifacts.sh [--dry-run] [--keep N] [--list] | --protect ID | --unprotect ID --yes | --remove ID --yes'; exit 0 ;;
    *) phonehaul_die "unknown argument $1" ;;
  esac
  shift
done
[[ "$keep" =~ ^(0|[1-9][0-9]*)$ ]] || phonehaul_die 'keep must be a nonnegative integer'
mkdir -p "$PHONEHAUL_ROOT/.build-state"
lock="$PHONEHAUL_ROOT/.build-state/artifacts.lock"
if [[ "${PHONEHAUL_LOCK_HELD:-}" != 1 ]]; then
  phonehaul_lock "$lock"
  trap 'phonehaul_unlock "$lock"' EXIT
fi
node "$PHONEHAUL_ROOT/scripts/shared/artifacts.js" "$op" "${id:-$keep}" "${flags[@]}"
