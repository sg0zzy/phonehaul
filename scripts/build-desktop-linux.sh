#!/usr/bin/env bash
set -euo pipefail

PHONEHAUL_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$(uname -s)" != Linux ]]; then
  echo "This script must run on Linux; Tauri AppImage bundles need the native Linux toolchain." >&2
  exit 1
fi
for tool in node npm cargo rustc pkg-config; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required tool '$tool' was not found on PATH. Install Node.js 24, the Rust stable toolchain, and Tauri's Linux native dependencies (see docs/development.md)." >&2
    exit 1
  fi
done
if [[ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
  echo "Node.js 24 is required to build the Linux receiver sidecar." >&2
  exit 1
fi

npm ci --prefix "$PHONEHAUL_ROOT/receiver"
npm ci --prefix "$PHONEHAUL_ROOT/desktop"
cd "$PHONEHAUL_ROOT/desktop"
npm run build -- --bundles appimage

echo "Linux Tauri AppImage output:"
shopt -s nullglob
images=("$PHONEHAUL_ROOT"/desktop/src-tauri/target/release/bundle/appimage/*.AppImage)
if ((${#images[@]} == 0)); then
  echo "The AppImage build finished without producing an .AppImage." >&2
  exit 1
fi
printf '  %s\n' "${images[@]}"
