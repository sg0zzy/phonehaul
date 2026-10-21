#!/usr/bin/env bash
# Managed local builds. See docs/development.md and DEVELOPMENT_STANDARDS.md.
# Dirty sources allowed; all selected targets must succeed; outputs are retained.
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

usage() {
  cat <<'EOF'
usage: scripts/build.sh dev [receiver|android|appimage|desktop-linux|desktop-windows|desktop-macos|all]

Build the current worktree (dirty allowed) as a uniquely identified
development build under local_artifacts/<build-id>/.
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
  receiver | android | appimage | desktop-linux | desktop-windows | desktop-macos | all) ;;
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
if [[ "$target" == appimage || "$target" == all ]]; then phonehaul_prepare_appimage_tools; fi
cd "$PHONEHAUL_ROOT"
mkdir -p "$PHONEHAUL_ROOT/.build-state"
archive_lock="$PHONEHAUL_ROOT/.build-state/artifacts.lock"
phonehaul_lock "$archive_lock"
trap 'phonehaul_unlock "$archive_lock"' EXIT
# Hold the same lock across compilation: native intermediate paths are shared.
export PHONEHAUL_ROOT PHONEHAUL_DEV_N PHONEHAUL_BUILD_ID PHONEHAUL_VERSION
export PHONEHAUL_CHANNEL=local
PHONEHAUL_DEV_N="$(phonehaul_next_dev_n)"
PHONEHAUL_BUILD_ID="$(phonehaul_build_id)"
PHONEHAUL_VERSION="$(phonehaul_display_version)"
export PHONEHAUL_CORE
PHONEHAUL_CORE="$(phonehaul_core_version)"
export PHONEHAUL_COMMIT
PHONEHAUL_COMMIT="$(phonehaul_git_commit)"
export PHONEHAUL_DIRTY=0
if phonehaul_git_is_dirty; then PHONEHAUL_DIRTY=1; fi
export PHONEHAUL_SOURCE_DIGEST
PHONEHAUL_SOURCE_DIGEST="$(phonehaul_source_digest)"
export PHONEHAUL_TARGETS_JSON='[]'
node scripts/shared/artifacts.js start "$PHONEHAUL_BUILD_ID"
finish() {
  local status=$?
  if ((status != 0)); then
    PHONEHAUL_TARGETS_JSON="$(node -e 'const a=JSON.parse(process.env.PHONEHAUL_TARGETS_JSON);a.push({id:process.argv[1],required:true,outcome:"failed",reason:"see compilation log"});console.log(JSON.stringify(a))' "$target")"
    export PHONEHAUL_TARGETS_JSON
    node "$PHONEHAUL_ROOT/scripts/shared/artifacts.js" failed "$PHONEHAUL_BUILD_ID" "target $target failed (exit $status); inspect preceding build log" || true
  fi
  phonehaul_unlock "$archive_lock"
}
trap finish EXIT
export PHONEHAUL_PLATFORM
PHONEHAUL_PLATFORM="$(cd "$PHONEHAUL_ROOT" && node -e "import('./scripts/shared/platform.js').then((m) => process.stdout.write(m.normalizedPlatform()))")"
export PHONEHAUL_ARCH
PHONEHAUL_ARCH="$(node -p 'process.arch')"
# --- exclusive managed storage -----------------------------------------------
archive_root="$PHONEHAUL_ARTIFACTS_DIR/$PHONEHAUL_BUILD_ID"
echo "PhoneHaul dev build $PHONEHAUL_VERSION (build $PHONEHAUL_BUILD_ID, commit ${PHONEHAUL_COMMIT:0:9}, dirty=$PHONEHAUL_DIRTY)"
echo "  archive: $archive_root"

products=()
files=()
collect() {
  products+=("$1")
  files+=("$2")
  PHONEHAUL_TARGETS_JSON="$(node -e 'const a=JSON.parse(process.env.PHONEHAUL_TARGETS_JSON);a.push({id:process.argv[1],required:true,outcome:"succeeded"});console.log(JSON.stringify(a))' "$1")"
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
    collect receiver-executable "$PHONEHAUL_ROOT/dist/phonehaul-linux-$(node -p 'process.arch')"
    ;;
  desktop-linux | desktop-windows | desktop-macos)
    host="$(uname -s)"
    case "$target:$host" in
      desktop-linux:Linux|desktop-windows:MINGW*|desktop-windows:MSYS*|desktop-macos:Darwin) ;;
      *) phonehaul_die "unsupported host $host for $target" ;;
    esac
    bash "$PHONEHAUL_ROOT/scripts/build-${target}.sh" "$@"
    shopt -s nullglob
    case "$target" in
      desktop-linux) images=("$PHONEHAUL_ROOT"/desktop/src-tauri/target/release/bundle/appimage/*"$PHONEHAUL_VERSION"*.AppImage) ;;
      desktop-windows) images=("$PHONEHAUL_ROOT"/desktop/src-tauri/target/release/bundle/nsis/*"$PHONEHAUL_VERSION"*.exe) ;;
      desktop-macos) images=("$PHONEHAUL_ROOT"/desktop/src-tauri/target/release/bundle/dmg/*"$PHONEHAUL_VERSION"*.dmg) ;;
    esac
    shopt -u nullglob
    ((${#images[@]} > 0)) || phonehaul_die "the desktop build produced no package"
    for image in "${images[@]}"; do collect "$target" "$image"; done
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
    collect receiver-executable "$PHONEHAUL_ROOT/dist/phonehaul-linux-$(node -p 'process.arch')"
    ;;
esac

# --- archive (never overwrite) + manifest + retention -------------------------
(( ${#files[@]} > 0 )) || phonehaul_die "no artifacts were produced."
[[ "$(phonehaul_source_digest)" == "$PHONEHAUL_SOURCE_DIGEST" ]] ||
  phonehaul_die "source/config inputs changed during compilation; outputs retained as failed, rebuild from stable inputs"
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
# Target platforms of this invocation: android builds target android; the
# host-built binaries target the host platform.
platforms=""
for product in "${products[@]}"; do
  case "$product" in
    android) platform=android ;;
    *) platform="$PHONEHAUL_PLATFORM" ;;
  esac
  [[ " $platforms " == *" $platform "* ]] || platforms+="$platform "
done
# build-info.json is written last: its presence marks the build as completed.
export PHONEHAUL_COMPLETION_SEQ
PHONEHAUL_COMPLETION_SEQ="$(node "$PHONEHAUL_ROOT/scripts/shared/artifacts.js" sequence)"
node "$PHONEHAUL_ROOT/scripts/shared/build-info.js" "$archive_root" "phonehaul-$target" "${platforms% }" "${archived[@]}"
echo "Archived: $archive_root"
# Retention runs only after a fully successful archive; a cleanup
# failure must not fail the build, and cleanup never runs on build failure
# (this point is only reached on success).
if ! PHONEHAUL_LOCK_HELD=1 "$PHONEHAUL_ROOT/scripts/cleanup-artifacts.sh"; then
  echo "warning: retention cleanup failed; artifacts were archived, run scripts/cleanup-artifacts.sh manually" >&2
fi
