#!/usr/bin/env bash
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

phonehaul_use_node
phonehaul_install_receiver_deps
cd "$PHONEHAUL_ROOT"
npm run build
phonehaul_build_android
phonehaul_build_appimage
[[ "$(uname -s)" == Linux ]] || phonehaul_die "Tauri AppImage builds must run on Linux."
npm install --prefix "$PHONEHAUL_ROOT/desktop"
cd "$PHONEHAUL_ROOT/desktop"
npm run build -- --bundles appimage
echo "All builds completed."
echo "Receiver bundle: $PHONEHAUL_ROOT/dist/build/phonehaul.cjs"
echo "Android APK: $PHONEHAUL_ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
echo "AppImage output: $PHONEHAUL_ROOT/dist/PhoneHaul-*.AppImage"
echo "Tauri AppImage output: $PHONEHAUL_ROOT/desktop/src-tauri/target/release/bundle/appimage/*.AppImage"
