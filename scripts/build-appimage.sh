#!/usr/bin/env bash
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

phonehaul_use_node
phonehaul_install_receiver_deps
phonehaul_build_appimage
