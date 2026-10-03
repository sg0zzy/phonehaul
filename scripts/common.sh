#!/usr/bin/env bash

PHONEHAUL_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

phonehaul_die() {
  printf 'PhoneHaul build: %s\n' "$*" >&2
  exit 1
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
