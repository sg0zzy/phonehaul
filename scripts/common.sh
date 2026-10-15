#!/usr/bin/env bash

PHONEHAUL_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

phonehaul_die() {
  printf 'PhoneHaul build: %s\n' "$*" >&2
  exit 1
}

# --- canonical version (VERSIONING.md §3) -------------------------------------
# VERSION at the repository root is the single source of truth for the core
# version and development status. N (dev number) and the official flag come
# from the environment, never from the source tree.
phonehaul_canonical_version() {
  [[ -f "$PHONEHAUL_ROOT/VERSION" ]] || phonehaul_die "VERSION file not found at $PHONEHAUL_ROOT/VERSION (VERSIONING.md §3)."
  local canonical
  canonical="$(tr -d '[:space:]' < "$PHONEHAUL_ROOT/VERSION")"
  [[ "$canonical" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-dev)?$ ]] ||
    phonehaul_die "invalid VERSION content '$canonical': expected X.Y.Z or X.Y.Z-dev."
  printf '%s\n' "$canonical"
}

phonehaul_core_version() {
  local canonical
  canonical="$(phonehaul_canonical_version)"
  printf '%s\n' "${canonical%-dev}"
}

# Display version for the current build: X.Y.Z when PHONEHAUL_OFFICIAL=1,
# otherwise X.Y.Z-dev.N (N from PHONEHAUL_DEV_N, default 1).
phonehaul_display_version() {
  local canonical core
  canonical="$(phonehaul_canonical_version)"
  core="${canonical%-dev}"
  if [[ "${PHONEHAUL_OFFICIAL:-}" == 1 ]]; then
    [[ "$canonical" != *-dev ]] || phonehaul_die "official builds require a stable VERSION (found $canonical)."
    printf '%s\n' "$core"
  else
    local n="${PHONEHAUL_DEV_N:-1}"
    [[ "$n" =~ ^[1-9][0-9]*$ ]] || phonehaul_die "invalid PHONEHAUL_DEV_N '$n': expected a positive integer without leading zeroes."
    printf '%s\n' "$core-dev.$n"
  fi
}

# --- git identity (VERSIONING.md §4.5) ----------------------------------------
phonehaul_git_commit() {
  git -C "$PHONEHAUL_ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown\n'
}

phonehaul_git_is_dirty() {
  [[ -n "$(git -C "$PHONEHAUL_ROOT" status --porcelain 2>/dev/null)" ]]
}

# Content digest of all tracked files plus the canonical VERSION file, so a
# dirty build can be tied to its actual inputs (SHA + dirty alone is not
# enough to reconstruct source).
phonehaul_source_digest() {
  {
    git -C "$PHONEHAUL_ROOT" ls-files -z | LC_ALL=C sort -z |
      xargs -0 -r git -C "$PHONEHAUL_ROOT" cat-file --batch 2>/dev/null | sha256sum | cut -d' ' -f1
    [[ -f "$PHONEHAUL_ROOT/VERSION" ]] && sha256sum "$PHONEHAUL_ROOT/VERSION" | cut -d' ' -f1
  } | sha256sum | cut -d' ' -f1
}

# --- build identity (VERSIONING.md §4.2/§4.4) ---------------------------------
# Unique per invocation: UTC timestamp with sub-second precision plus PID.
phonehaul_build_id() {
  printf '%s-%s\n' "$(date -u +%Y%m%dT%H%M%S%N)" "$$"
}

# Atomic per-workstation dev.N counter under gitignored .build-state/.
# Resets when the selected core changes. Callers must export PHONEHAUL_DEV_N
# before child builds so every artifact of one invocation shares one version.
phonehaul_next_dev_n() {
  local state_dir="$PHONEHAUL_ROOT/.build-state" core state n lock waited=0
  core="$(phonehaul_core_version)"
  mkdir -p "$state_dir"
  state="$state_dir/dev-counter"
  lock="$state.lock"
  while ! mkdir -- "$lock" 2>/dev/null; do
    # Steal locks older than ~30 s (crashed builder).
    if [[ -n "$(find "$lock" -maxdepth 0 -mmin +0.5 2>/dev/null)" ]]; then
      rm -rf -- "$lock"
    else
      sleep 0.1
      waited=$((waited + 1))
      ((waited < 300)) || phonehaul_die "timed out waiting for $lock"
    fi
  done
  n=1
  if [[ -f "$state" ]]; then
    local recorded_core recorded_n
    recorded_core="$(sed -n 's/^core=//p' "$state")"
    recorded_n="$(sed -n 's/^n=//p' "$state")"
    if [[ "$recorded_core" == "$core" && "$recorded_n" =~ ^[1-9][0-9]*$ ]]; then
      n=$((recorded_n + 1))
    fi
  fi
  printf 'core=%s\nn=%s\n' "$core" "$n" > "$state.tmp" && mv -f -- "$state.tmp" "$state"
  rmdir -- "$lock"
  printf '%s\n' "$n"
}

phonehaul_use_node() {
  if ! command -v nvm >/dev/null 2>&1; then
    local nvm_init="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    [[ -s "$nvm_init" ]] || phonehaul_die "nvm was not found. Install nvm or set NVM_DIR to its installation directory."
    # shellcheck disable=SC1090
    source "$nvm_init"
  fi
  cd "$PHONEHAUL_ROOT"
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
  cd "$PHONEHAUL_ROOT/android"
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
  cd "$PHONEHAUL_ROOT"
  npm run package:appimage
}
