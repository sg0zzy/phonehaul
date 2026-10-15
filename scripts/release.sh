#!/usr/bin/env bash
# Stable releases (VERSIONING.md §5, §6, §10).
#
#   scripts/release.sh prepare <X.Y.Z>
#   scripts/release.sh publish <X.Y.Z>
#
# prepare  Validate (clean worktree, exact target, no existing tag, strictly
#          greater than every stable tag, VERSION becomes X.Y.Z), commit the
#          VERSION change, and create the annotated tag locally. Triggers
#          nothing public.
# publish  Explicitly push the branch and the tag, which starts the official
#          CI build/publish workflow. Requires explicit authorization: this
#          is the externally visible operation (§9.9).
#
# Both refuse to run on a dirty worktree or move/recreate an existing tag.
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

usage() {
  cat <<'EOF'
usage: scripts/release.sh prepare <X.Y.Z>
       scripts/release.sh publish <X.Y.Z>

prepare  Validate, set VERSION to X.Y.Z, commit, and tag locally (no push).
publish  Push the release commit and tag to origin (starts official CI).
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

require_clean_worktree() {
  command -v git >/dev/null 2>&1 || phonehaul_die "git is required."
  git -C "$PHONEHAUL_ROOT" rev-parse --git-dir >/dev/null 2>&1 ||
    phonehaul_die "not a git repository: $PHONEHAUL_ROOT"
  if [[ -n "$(git -C "$PHONEHAUL_ROOT" status --porcelain)" ]]; then
    phonehaul_die "release requires a clean worktree (VERSIONING.md §6.1); commit or stash first."
  fi
}

validate_release_target() {
  local target="$1" tag_core
  [[ "$target" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
    phonehaul_die "release target must be an exact stable version X.Y.Z (got '$target')."
  git -C "$PHONEHAUL_ROOT" rev-parse -q --verify "refs/tags/v${target}" >/dev/null 2>&1 &&
    phonehaul_die "tag v${target} already exists; published tags are immutable (§6.5)."
  # Strictly greater than every existing stable tag (§5.3).
  while IFS= read -r tag_ref; do
    [[ -n "$tag_ref" ]] || continue
    tag_core="${tag_ref#refs/tags/v}"
    [[ "$tag_core" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || continue
    version_gt "$target" "$tag_core" ||
      phonehaul_die "release $target must be strictly greater than existing tag v${tag_core} (§5.3)."
  done < <(git -C "$PHONEHAUL_ROOT" for-each-ref --format='%(refname)' 'refs/tags/v*')
  # Platform adapters must accept the stable identity (fails closed).
  # Validate the target itself, not the current VERSION file.
  local probe
  probe="$(mktemp)"
  printf '%s\n' "$target" > "$probe"
  PHONEHAUL_VERSION_FILE="$probe" PHONEHAUL_OFFICIAL=1 \
    node "$PHONEHAUL_ROOT/scripts/shared/version.js" android-code >/dev/null ||
    { rm -f "$probe"; phonehaul_die "release $target has no valid stable Android versionCode (§8)."; }
  rm -f "$probe"
}

command="${1:-}"
target="${2:-}"
case "$command" in
  prepare)
    [[ -n "$target" ]] || { usage >&2; exit 2; }
    require_clean_worktree
    # §6.1 requires passing checks; the repo gate is `npm run check`.
    if [[ "${PHONEHAUL_SKIP_CHECKS:-}" == 1 ]]; then
      echo "WARNING: PHONEHAUL_SKIP_CHECKS=1 — running the release without the check gate." >&2
    else
      (cd "$PHONEHAUL_ROOT" && npm run check)
    fi
    validate_release_target "$target"
    current="$(phonehaul_canonical_version)"
    if [[ "$current" != "$target" ]]; then
      printf '%s\n' "$target" > "$PHONEHAUL_ROOT/VERSION.tmp"
      mv -f -- "$PHONEHAUL_ROOT/VERSION.tmp" "$PHONEHAUL_ROOT/VERSION"
      git -C "$PHONEHAUL_ROOT" add VERSION
      git -C "$PHONEHAUL_ROOT" commit -m "Release v${target}"
      echo "VERSION: $current -> $target (committed)"
    else
      echo "VERSION already is $target; tagging the current commit."
    fi
    git -C "$PHONEHAUL_ROOT" tag -a "v${target}" -m "PhoneHaul v${target}"
    echo "Tagged v${target} on $(git -C "$PHONEHAUL_ROOT" rev-parse HEAD)."
    echo "Next: scripts/release.sh publish ${target} (pushes the branch and tag; starts official CI)."
    ;;
  publish)
    [[ -n "$target" ]] || { usage >&2; exit 2; }
    require_clean_worktree
    git -C "$PHONEHAUL_ROOT" rev-parse -q --verify "refs/tags/v${target}" >/dev/null 2>&1 ||
      phonehaul_die "local tag v${target} not found; run scripts/release.sh prepare ${target} first."
    [[ "$(git -C "$PHONEHAUL_ROOT" describe --tags --exact-match HEAD 2>/dev/null || true)" == "v${target}" ]] ||
      phonehaul_die "HEAD is not tagged v${target}; publish the checked-out release commit."
    branch="$(git -C "$PHONEHAUL_ROOT" branch --show-current)"
    [[ -n "$branch" ]] || phonehaul_die "publish requires a named branch."
    echo "Publishing v${target}: pushing branch '$branch' and tag v${target} to origin."
    echo "This starts the official CI build/publish workflow (§6)."
    git -C "$PHONEHAUL_ROOT" push origin "$branch"
    git -C "$PHONEHAUL_ROOT" push origin "refs/tags/v${target}"
    echo "Pushed. Monitor CI; publication to GitHub Releases / stores is a separate auditable step (§6.6)."
    ;;
  -h | --help | '')
    usage
    [[ -n "$command" ]] && exit 0 || exit 2
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
