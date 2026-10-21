#!/usr/bin/env bash
# Explicit stable preparation/push; never called by compilation.
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"
case "${1:-}" in
  prepare) shift; node "$PHONEHAUL_ROOT/scripts/shared/version-operation.js" prepare "$@" ;;
  publish)
    target="${2:?exact stable version required}"
    node "$PHONEHAUL_ROOT/scripts/shared/official.js" validate "$target"
    [[ -z "$(git -C "$PHONEHAUL_ROOT" status --porcelain)" ]] || phonehaul_die 'publish requires a clean tree'
    branch="$(git -C "$PHONEHAUL_ROOT" branch --show-current)"
    [[ -n "$branch" ]] || phonehaul_die 'publish requires a named branch'
    [[ "$(git -C "$PHONEHAUL_ROOT" rev-parse HEAD)" == "$(git -C "$PHONEHAUL_ROOT" rev-parse "v${target}^{commit}")" ]] || phonehaul_die 'HEAD differs from release tag'
    if [[ "${3:-}" == --dry-run ]]; then
      echo "Would atomically push $branch and refs/tags/v$target to origin; no remote changes."
    else
      node "$PHONEHAUL_ROOT/scripts/shared/official.js" candidate "$target"
      git -C "$PHONEHAUL_ROOT" push --atomic origin "$branch" "refs/tags/v${target}"
    fi ;;
  *) echo 'usage: release.sh prepare X.Y.Z [--dry-run] | publish X.Y.Z [--dry-run]'; exit 2 ;;
esac
