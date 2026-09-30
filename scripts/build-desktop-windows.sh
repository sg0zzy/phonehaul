#!/usr/bin/env bash
set -euo pipefail

PHONEHAUL_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 24 is required. Install it on Windows and reopen Git Bash." >&2
  exit 1
fi
if [[ "$(node -p 'process.platform')" != win32 ]]; then
  echo "This script must run in Git Bash on Windows; Tauri Windows bundles need the native Windows toolchain." >&2
  exit 1
fi
for tool in npm cargo rustc makensis; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required tool '$tool' was not found on PATH. Install the Rust stable toolchain and NSIS, then reopen Git Bash." >&2
    exit 1
  fi
done

cd "$PHONEHAUL_ROOT"
npm ci --prefix receiver
npm ci --prefix desktop
npm --prefix desktop run build -- --bundles nsis

echo "Windows Tauri installer output:"
shopt -s nullglob
installers=("$PHONEHAUL_ROOT"/desktop/src-tauri/target/release/bundle/nsis/*.exe)
if ((${#installers[@]} == 0)); then
  echo "The NSIS build finished without producing an installer .exe." >&2
  exit 1
fi
printf '  %s\n' "${installers[@]}"
