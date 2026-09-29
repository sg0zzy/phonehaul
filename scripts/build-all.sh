#!/usr/bin/env bash
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

phonehaul_use_node
phonehaul_install_receiver_deps
cd "$PHONEHAUL_ROOT"
npm run build
phonehaul_build_android
phonehaul_build_appimage
echo "All builds completed."
echo "Receiver bundle: $PHONEHAUL_ROOT/dist/build/phonehaul.cjs"
echo "Android APK: $PHONEHAUL_ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
echo "AppImage output: $PHONEHAUL_ROOT/dist/PhoneHaul-*.AppImage"
