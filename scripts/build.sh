#!/usr/bin/env bash
# Local development builds (VERSIONING.md §4, §10).
#
#   scripts/build.sh dev [target]
#
# Builds the current worktree (dirty allowed, no commit required) as a
# uniquely identified development build:
#   - advances the local dev.N counter (gitignored .build-state/, reset per core)
#   - creates a unique build ID (UTC timestamp + PID)
#   - exports PHONEHAUL_DEV_N / PHONEHAUL_VERSION so every component of one
#     invocation shares one version
#   - archives outputs under dist/dev/<version>/<build-id>/, never overwrites
#   - writes a machine-readable build-manifest.json (§4.7)
#
# Targets: all (default) | receiver | android | appimage | desktop-linux
# dist/ and .build-state/ are gitignored.
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

usage() {
  cat <<'EOF'
usage: scripts/build.sh dev [receiver|android|appimage|desktop-linux|all]

Build the current worktree (dirty allowed) as a uniquely identified
development build under dist/dev/<version>/<build-id>/.
EOF
}

[[ "${1:-}" == dev ]] || {
  usage >&2
  exit 2
}
shift
target="${1:-all}"
if [[ $# -gt 0 ]]; then shift; fi
case "$target" in
  receiver | android | appimage | desktop-linux | all) ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

command -v git >/dev/null 2>&1 || phonehaul_die "git is required to identify builds."
git -C "$PHONEHAUL_ROOT" rev-parse --git-dir >/dev/null 2>&1 ||
  phonehaul_die "not a git repository: $PHONEHAUL_ROOT"

phonehaul_use_node
phonehaul_install_receiver_deps

# --- build identity (shared by all child builds) -------------------------------
export PHONEHAUL_ROOT
export PHONEHAUL_DEV_N
PHONEHAUL_DEV_N="$(phonehaul_next_dev_n)"
export PHONEHAUL_BUILD_ID
PHONEHAUL_BUILD_ID="$(phonehaul_build_id)"
export PHONEHAUL_VERSION
PHONEHAUL_VERSION="$(phonehaul_display_version)"
export PHONEHAUL_COMMIT
PHONEHAUL_COMMIT="$(phonehaul_git_commit)"
export PHONEHAUL_DIRTY
PHONEHAUL_DIRTY=0
if phonehaul_git_is_dirty; then
  PHONEHAUL_DIRTY=1
  # Preserve the actual inputs: SHA + dirty alone cannot reconstruct source.
  mkdir -p "$PHONEHAUL_ROOT/.build-state/diffs"
  export PHONEHAUL_DIFF_FILE
  PHONEHAUL_DIFF_FILE="$PHONEHAUL_ROOT/.build-state/diffs/$PHONEHAUL_BUILD_ID.patch"
  git -C "$PHONEHAUL_ROOT" diff --binary HEAD > "$PHONEHAUL_DIFF_FILE"
  # Untracked files are not in `git diff`; record their digests too.
  export PHONEHAUL_UNTRACKED_FILE
  PHONEHAUL_UNTRACKED_FILE="$PHONEHAUL_DIFF_FILE.untracked"
  : > "$PHONEHAUL_UNTRACKED_FILE"
  while IFS= read -r -d '' untracked; do
    printf '%s  %s\n' "$(sha256sum -- "$untracked" | cut -d' ' -f1)" "$untracked" >> "$PHONEHAUL_UNTRACKED_FILE"
  done < <(git -C "$PHONEHAUL_ROOT" ls-files --others --exclude-standard -z)
fi
export PHONEHAUL_SOURCE_DIGEST
PHONEHAUL_SOURCE_DIGEST="$(phonehaul_source_digest)"
export PHONEHAUL_PLATFORM
PHONEHAUL_PLATFORM="$(cd "$PHONEHAUL_ROOT" && node -e "import('./scripts/shared/platform.js').then((m) => process.stdout.write(m.normalizedPlatform()))")"
export PHONEHAUL_ARCH
PHONEHAUL_ARCH="$(node -p 'process.arch')"
export PHONEHAUL_TOOLCHAIN
PHONEHAUL_TOOLCHAIN="node $(node -p 'process.versions.node')"
export PHONEHAUL_LOCKFILES
PHONEHAUL_LOCKFILES="$PHONEHAUL_ROOT/receiver/package-lock.json"

archive_root="$PHONEHAUL_ROOT/dist/dev/$PHONEHAUL_VERSION/$PHONEHAUL_BUILD_ID"
echo "PhoneHaul dev build $PHONEHAUL_VERSION (build $PHONEHAUL_BUILD_ID, commit ${PHONEHAUL_COMMIT:0:9}, dirty=$PHONEHAUL_DIRTY)"
echo "  archive: $archive_root"

products=()
files=()
collect() {
  products+=("$1")
  files+=("$2")
}

cd "$PHONEHAUL_ROOT"
case "$target" in
  receiver)
    npm run build
    collect receiver "$PHONEHAUL_ROOT/dist/build/phonehaul.cjs"
    ;;
  android)
    phonehaul_build_android
    collect android "$PHONEHAUL_ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
    ;;
  appimage)
    phonehaul_build_appimage
    arch="$(uname -m)"
    case "$arch" in
      x86_64 | amd64) appimage_arch=x86_64 ;;
      aarch64 | arm64) appimage_arch=aarch64 ;;
      *) phonehaul_die "unsupported AppImage host architecture: $arch" ;;
    esac
    collect appimage "$PHONEHAUL_ROOT/dist/PhoneHaul-$appimage_arch.AppImage"
    ;;
  desktop-linux)
    bash "$PHONEHAUL_ROOT/scripts/build-desktop-linux.sh" "$@"
    shopt -s nullglob
    images=("$PHONEHAUL_ROOT"/desktop/src-tauri/target/release/bundle/appimage/*.AppImage)
    shopt -u nullglob
    ((${#images[@]} > 0)) || phonehaul_die "the desktop build produced no AppImage."
    collect desktop "${images[-1]}"
    ;;
  all)
    npm run build
    collect receiver "$PHONEHAUL_ROOT/dist/build/phonehaul.cjs"
    phonehaul_build_android
    collect android "$PHONEHAUL_ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
    phonehaul_build_appimage
    arch="$(uname -m)"
    case "$arch" in
      x86_64 | amd64) appimage_arch=x86_64 ;;
      aarch64 | arm64) appimage_arch=aarch64 ;;
      *) phonehaul_die "unsupported AppImage host architecture: $arch" ;;
    esac
    collect appimage "$PHONEHAUL_ROOT/dist/PhoneHaul-$appimage_arch.AppImage"
    ;;
esac

# --- archive (never overwrite) + manifest --------------------------------------
((${#files[@]} > 0)) || phonehaul_die "no artifacts were produced."
mkdir -p "$archive_root"
archived=()
for i in "${!files[@]}"; do
  file="${files[$i]}"
  product="${products[$i]}"
  [[ -f "$file" ]] || phonehaul_die "expected artifact missing: $file"
  dest="$archive_root/$product/$(basename -- "$file")"
  mkdir -p "$(dirname -- "$dest")"
  [[ -e "$dest" ]] && phonehaul_die "refusing to overwrite $dest"
  cp -p -- "$file" "$dest"
  archived+=("$dest")
done
if [[ -n "${PHONEHAUL_DIFF_FILE:-}" ]]; then
  cp -p -- "$PHONEHAUL_DIFF_FILE" "$archive_root/worktree.patch"
  cp -p -- "$PHONEHAUL_UNTRACKED_FILE" "$archive_root/untracked.sha256"
fi
node "$PHONEHAUL_ROOT/scripts/shared/build-manifest.js" "$archive_root" "phonehaul-$target" "${archived[@]}"
echo "Archived: $archive_root"
