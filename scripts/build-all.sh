#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
"$root/scripts/build.sh" dev all
"$root/scripts/build.sh" dev desktop-linux
