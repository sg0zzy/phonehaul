#!/usr/bin/env bash

PHONEHAUL_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

# Managed local artifact storage (DEVELOPMENT_STANDARDS.md). Final
# distributables of local builds live in one immutable subdirectory per build
# under this directory; intermediate files stay in tool-specific build dirs.
: "${PHONEHAUL_ARTIFACTS_DIR:=$PHONEHAUL_ROOT/local_artifacts}"

# Never steal an apparently old lock: a long compilation may still own it.
# Interrupted holders require explicit inspection and lock removal.
phonehaul_lock() {
  local lock="$1" waited=0
  while ! mkdir -- "$lock" 2>/dev/null; do
    sleep 0.1
    waited=$((waited + 1))
    ((waited < 6000)) || phonehaul_die "timed out waiting for $lock; inspect the holder before recovery"
  done
}
phonehaul_unlock() { rmdir -- "$1" 2>/dev/null || true; }

phonehaul_die() {
  printf 'PhoneHaul build: %s\n' "$*" >&2
  exit 1
}

# --- canonical version (DEVELOPMENT_STANDARDS.md) -------------------------------------
# VERSION at the repository root is the single source of truth for the core
# version and development status. N (dev number) and the official flag come
# from the environment, never from the source tree.
phonehaul_canonical_version() {
  [[ -f "$PHONEHAUL_ROOT/VERSION" ]] || phonehaul_die "VERSION file not found at $PHONEHAUL_ROOT/VERSION (DEVELOPMENT_STANDARDS.md)."
  local canonical
  canonical="$(tr -d '[:space:]' < "$PHONEHAUL_ROOT/VERSION")"
  [[ "$canonical" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-dev(\.[0-9]+)?)?$ ]] ||
    phonehaul_die "invalid VERSION content '$canonical': expected X.Y.Z or X.Y.Z-dev."
  printf '%s\n' "$canonical"
}

phonehaul_core_version() {
  local canonical
  canonical="$(phonehaul_canonical_version)"
  printf '%s\n' "${canonical%%-dev*}"
}

# SemVer core comparison: success when $1 > $2 (cores are X.Y.Z).
phonehaul_version_gt() {
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

# Display version for the current build: X.Y.Z when PHONEHAUL_OFFICIAL=1,
# otherwise X.Y.Z-dev.N (N from PHONEHAUL_DEV_N, default 1).
phonehaul_display_version() {
  node "$PHONEHAUL_ROOT/scripts/shared/version.js" display
}

# --- git identity (DEVELOPMENT_STANDARDS.md) ----------------------------------------
phonehaul_git_commit() {
  git -C "$PHONEHAUL_ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown\n'
}

phonehaul_git_is_dirty() {
  [[ -n "$(git -C "$PHONEHAUL_ROOT" status --porcelain 2>/dev/null)" ]]
}

# Canonical input inventory, including relevant ignored configuration inputs.
phonehaul_source_digest() {
  node "$PHONEHAUL_ROOT/scripts/shared/source-identity.js"
}

# --- build identity (DEVELOPMENT_STANDARDS.md) ---------------------------------
# Unique per invocation: UTC timestamp with sub-second precision plus PID.
phonehaul_build_id() {
  local stamp sub
  stamp="$(date -u +%Y%m%dT%H%M%S%N)"
  # BSD/macOS date has no %N and prints a literal 'N'; fall back to $RANDOM.
  if [[ "$stamp" == *N* ]]; then
    stamp="$(date -u +%Y%m%dT%H%M%S)"
    sub="$(( (RANDOM % 900000) + 100000 ))"
    printf '%s%s-%s\n' "$stamp" "$sub" "$$"
  else
    printf '%s-%s\n' "$stamp" "$$"
  fi
}

# Atomic per-workstation dev.N counter under gitignored .build-state/.
# Resets when the selected core changes. Callers must export PHONEHAUL_DEV_N
# before child builds so every artifact of one invocation shares one version.
phonehaul_next_dev_n() {
  node "$PHONEHAUL_ROOT/scripts/shared/artifacts.js" counter "$(phonehaul_core_version)"
}

phonehaul_use_node() {
  if ! command -v nvm >/dev/null 2>&1; then
    local nvm_init="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    [[ -s "$nvm_init" ]] || phonehaul_die "nvm was not found. Install nvm or set NVM_DIR to its installation directory."
    # shellcheck disable=SC1090
    source "$nvm_init"
  fi
  cd "$PHONEHAUL_ROOT" || phonehaul_die "cannot enter $PHONEHAUL_ROOT"
  if ! nvm use; then
    nvm install
    nvm use
  fi
}

phonehaul_install_receiver_deps() {
  if [[ ! -x "$PHONEHAUL_ROOT/receiver/node_modules/.bin/esbuild" || ! -d "$PHONEHAUL_ROOT/receiver/node_modules/postject" ]]; then
    npm ci --prefix "$PHONEHAUL_ROOT/receiver"
  else
    echo "Receiver dependencies are already installed."
  fi
}

phonehaul_build_android() {
  command -v java >/dev/null 2>&1 || phonehaul_die "Java is required for Gradle. Install a JDK 17."
  if [[ -z "${ANDROID_HOME:-}${ANDROID_SDK_ROOT:-}" && ! -f "$PHONEHAUL_ROOT/android/local.properties" ]]; then
    for sdk_candidate in "$HOME/Android/Sdk" "$HOME/Library/Android/sdk"; do
      if [[ -d "$sdk_candidate" ]]; then
        export ANDROID_HOME="$sdk_candidate"
        break
      fi
    done
  fi
  if [[ -z "${ANDROID_HOME:-}${ANDROID_SDK_ROOT:-}" && ! -f "$PHONEHAUL_ROOT/android/local.properties" ]]; then
    phonehaul_die "Android SDK not found. Set ANDROID_HOME/ANDROID_SDK_ROOT or configure android/local.properties."
  fi
  cd "$PHONEHAUL_ROOT/android" || phonehaul_die "cannot enter $PHONEHAUL_ROOT/android"
  ./gradlew :app:assembleDebug :app:testDebugUnitTest
  printf '\nAndroid APK: %s\n' "$PHONEHAUL_ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
}

phonehaul_prepare_appimage_tools() {
  [[ "$(uname -s)" == Linux ]] || phonehaul_die "AppImage builds must run on Linux."
  if [[ -z "${APPIMAGETOOL:-}" && -x "$HOME/opt/appimagetool" ]]; then
    export APPIMAGETOOL="$HOME/opt/appimagetool"
  fi
  if [[ -z "${APPIMAGETOOL:-}" ]]; then
    phonehaul_die "appimagetool not found. Install it or set APPIMAGETOOL to its executable path."
  fi
  if [[ "$APPIMAGETOOL" == */* ]]; then
    [[ -x "$APPIMAGETOOL" ]] || phonehaul_die "APPIMAGETOOL is not executable: $APPIMAGETOOL"
  else
    command -v "$APPIMAGETOOL" >/dev/null 2>&1 || phonehaul_die "appimagetool is not available on PATH."
  fi

  local runtime_arch
  case "$(uname -m)" in
    x86_64|amd64) runtime_arch=x86_64 ;;
    aarch64|arm64) runtime_arch=aarch64 ;;
    *) phonehaul_die "Unsupported AppImage host architecture: $(uname -m)" ;;
  esac
  if [[ -z "${APPIMAGE_RUNTIME:-}" && -f "$HOME/opt/runtime-$runtime_arch" ]]; then
    export APPIMAGE_RUNTIME="$HOME/opt/runtime-$runtime_arch"
  fi
  if [[ -z "${APPIMAGE_RUNTIME:-}" || ! -f "$APPIMAGE_RUNTIME" ]]; then
    phonehaul_die "AppImage runtime not found. Set APPIMAGE_RUNTIME to runtime-$runtime_arch."
  fi
}

phonehaul_build_appimage() {
  phonehaul_prepare_appimage_tools
  cd "$PHONEHAUL_ROOT" || phonehaul_die "cannot enter $PHONEHAUL_ROOT"
  npm run package:appimage
}
