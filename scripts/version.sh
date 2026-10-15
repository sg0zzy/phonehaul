#!/usr/bin/env bash
# Version transitions (VERSIONING.md §5, §10).
#
#   scripts/version.sh show
#   scripts/version.sh bump patch|minor|major
#   scripts/version.sh set <X.Y.Z-dev|X.Y.Z>
#
# Edits only the canonical VERSION file (core + dev status). Never creates a
# tag, never commits, never builds. Bumping selects the next development core
# and resets the local dev.N counter (the counter resets automatically when
# its recorded core differs). Agents must not bump versions incidentally
# (§9.3): this is an explicit operation.
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

usage() {
  cat <<'EOF'
usage: scripts/version.sh show
       scripts/version.sh bump patch|minor|major
       scripts/version.sh set <X.Y.Z-dev|X.Y.Z>

show   Print the canonical version, derived display version and platform codes.
bump   Select the next development core (resets the local dev.N counter).
set    Explicitly select a core, e.g. `set 0.9.6-dev` or `set 0.9.6`.

Never tags or commits; see scripts/release.sh for releases.
EOF
}

# SemVer core comparison: success when $1 > $2.
version_gt() {
  local -a a b
  IFS=. read -r -a a <<< "$1"
  IFS=. read -r -a b <<< "$2"
  local i
  for i in 0 1 2; do
    if ((a[i] > b[i])); then return 0; fi
    if ((a[i] < b[i])); then return 1; fi
  done
  return 1
}

# Fail closed on regressions, invalid syntax, tag conflicts, and platform
# adapter overflow (VERSIONING.md §9.6).
validate_candidate() {
  local candidate="$1" current current_core candidate_core tag_core tag_ref
  [[ "$candidate" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-dev)?$ ]] ||
    phonehaul_die "invalid version '$candidate': expected X.Y.Z or X.Y.Z-dev."
  current="$(phonehaul_canonical_version)"
  [[ "$candidate" != "$current" ]] || phonehaul_die "VERSION already is $candidate."
  current_core="${current%-dev}"
  candidate_core="${candidate%-dev}"
  if [[ "$candidate_core" == "$current_core" ]]; then
    # Same core: only X.Y.Z-dev -> X.Y.Z (release transition) sorts higher.
    [[ "$current" == *-dev && "$candidate" != *-dev ]] ||
      phonehaul_die "refusing regression: $candidate does not sort after current $current."
  else
    version_gt "$candidate_core" "$current_core" ||
      phonehaul_die "refusing regression: core $candidate_core <= current core $current_core."
  fi
  # The candidate core must sort after every existing stable tag (single
  # update line; maintenance lines need a documented exception, §7).
  while IFS= read -r tag_ref; do
    [[ -n "$tag_ref" ]] || continue
    tag_core="${tag_ref#refs/tags/v}"
    [[ "$tag_core" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || continue
    if [[ "$tag_core" == "$candidate_core" ]] || version_gt "$tag_core" "$candidate_core"; then
      phonehaul_die "refusing: stable tag v${tag_core} is at or above candidate core $candidate_core (never reuse a published stable version, §2.8)."
    fi
  done < <(git -C "$PHONEHAUL_ROOT" for-each-ref --format='%(refname)' 'refs/tags/v*')
  # Platform adapters must accept the candidate (fails closed on overflow).
  # Validate against the candidate itself, not the current VERSION file.
  local probe
  probe="$(mktemp)"
  printf '%s\n' "$candidate" > "$probe"
  PHONEHAUL_VERSION_FILE="$probe" PHONEHAUL_OFFICIAL=0 PHONEHAUL_DEV_N=1 \
    node "$PHONEHAUL_ROOT/scripts/shared/version.js" android-code >/dev/null ||
    { rm -f "$probe"; phonehaul_die "candidate $candidate has no valid Android versionCode (§8)."; }
  if [[ "$candidate" != *-dev ]]; then
    PHONEHAUL_VERSION_FILE="$probe" PHONEHAUL_OFFICIAL=1 \
      node "$PHONEHAUL_ROOT/scripts/shared/version.js" android-code >/dev/null ||
      { rm -f "$probe"; phonehaul_die "candidate $candidate has no valid stable Android versionCode (§8)."; }
  fi
  rm -f "$probe"
}

write_version() {
  printf '%s\n' "$1" > "$PHONEHAUL_ROOT/VERSION.tmp"
  mv -f -- "$PHONEHAUL_ROOT/VERSION.tmp" "$PHONEHAUL_ROOT/VERSION"
}

command="${1:-}"
case "$command" in
  show)
    canonical="$(phonehaul_canonical_version)"
    echo "canonical:  $canonical (VERSION)"
    echo "display:    $(phonehaul_display_version)"
    echo "android:    dev versionCode $(PHONEHAUL_OFFICIAL=0 PHONEHAUL_DEV_N="${PHONEHAUL_DEV_N:-1}" node "$PHONEHAUL_ROOT/scripts/shared/version.js" android-code)"
    echo "msix:       $(node "$PHONEHAUL_ROOT/scripts/shared/version.js" msix)"
    echo "last tag:   $(git -C "$PHONEHAUL_ROOT" describe --tags --abbrev=0 2>/dev/null || echo none)"
    ;;
  bump)
    kind="${2:-}"
    [[ -n "$kind" ]] || { usage >&2; exit 2; }
    canonical="$(phonehaul_canonical_version)"
    IFS=. read -r major minor patch <<< "${canonical%-dev}"
    case "$kind" in
      patch) candidate="$major.$minor.$((patch + 1))-dev" ;;
      minor) candidate="$major.$((minor + 1)).0-dev" ;;
      major) candidate="$((major + 1)).0.0-dev" ;;
      *) usage >&2; exit 2 ;;
    esac
    validate_candidate "$candidate"
    write_version "$candidate"
    echo "VERSION: $canonical -> $candidate (local dev.N counter resets on the next build)"
    ;;
  set)
    candidate="${2:-}"
    [[ -n "$candidate" ]] || { usage >&2; exit 2; }
    current="$(phonehaul_canonical_version)"
    validate_candidate "$candidate"
    write_version "$candidate"
    echo "VERSION: $current -> $candidate"
    ;;
  -h | --help)
    usage
    ;;
  '')
    usage >&2
    exit 2
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
