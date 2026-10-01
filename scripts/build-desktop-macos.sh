#!/usr/bin/env bash
set -euo pipefail

PHONEHAUL_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$(uname -s)" != Darwin ]]; then
  echo "This script must run on macOS; Tauri DMG bundles need the native macOS toolchain." >&2
  exit 1
fi
for tool in node npm cargo rustc codesign; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required tool '$tool' was not found on PATH. Install Node.js 24, Xcode Command Line Tools, and the Rust stable toolchain." >&2
    exit 1
  fi
done
if [[ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
  echo "Node.js 24 is required to build the macOS receiver sidecar." >&2
  exit 1
fi

npm ci --prefix "$PHONEHAUL_ROOT/receiver"
npm ci --prefix "$PHONEHAUL_ROOT/desktop"
cd "$PHONEHAUL_ROOT/desktop"
npm run build -- --bundles dmg

echo "macOS Tauri DMG output:"
shopt -s nullglob
images=("$PHONEHAUL_ROOT"/desktop/src-tauri/target/release/bundle/dmg/*.dmg)
if ((${#images[@]} == 0)); then
  echo "The DMG build finished without producing a .dmg." >&2
  exit 1
fi
printf '  %s\n' "${images[@]}"
