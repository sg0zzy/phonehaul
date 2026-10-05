# PhoneHaul — Developer Guide

Build, run, test, and release the PhoneHaul receiver, desktop app, and Android app.

This guide is the single source of truth for **developer** tasks (build, release, env vars, settings). User-facing docs (what it is, how to download/use, troubleshooting) live in [README.md](../README.md).

## Repository layout

```
.
├── receiver/            # Node.js receiver (LAN + UI servers, transfer + send pipelines, settings)
│   ├── src/
│   │   ├── server/      # HTTP app, LAN handshake, loopback guard, SSE, QR
│   │   ├── settings/    # settings.json store + downloads-dir discovery
│   │   └── transfer/    # receiver (incoming), send-queue (outgoing), manifest
│   └── package.json     # npm workspaces: build, test, smoke, package:sea/appimage
├── desktop/             # Tauri desktop app wrapping the receiver as a bundled sidecar
│   ├── src/             # Tauri frontend (HTML/CSS/JS)
│   └── src-tauri/       # Rust backend + bundled phonehaul-server
├── android/             # Android app (Kotlin, Compose, Gradle)
├── integration-tests/   # smoke / end-to-end tests
├── protocol/            # protocol.json (schema for the LAN protocol)
├── assets/              # App icon master + AppImage icon asset
└── .github/workflows/   # CI builds
```

## Prerequisites

| Area | Toolchain | Install |
|------|-----------|---------|
| Node (all) | **Node.js 24** — [.nvmrc](../.nvmrc) pins `24.21.0` | `nvm use` (or install 24) |
| receiver | Node 24 | `npm ci --prefix receiver` |
| desktop (Tauri) | Node 24 + Rust | `npm ci --prefix receiver && npm ci --prefix desktop` |
| desktop (Tauri, Linux) | Rust + GTK/WebKit2 dev libs | see **Linux** below |
| desktop (Tauri, Windows) | Rust + NSIS | see **Windows** below |
| android | JDK 17 + Android SDK | `sdkmanager "platforms;android-36" "build-tools;36.0.0"` |

**All JS/TS installs use `npm ci`** (the locked `package-lock.json` files). Never hand-edit a lockfile or run a plain `npm install`.

## Running the receiver locally

```sh
# from the repo root
npm ci --prefix receiver
npm run dev --prefix receiver          # start the receiver + UI (Node source)
npm run smoke:sea --prefix receiver   # standalone SEA smoke test
```

The receiver listens on:
- the **LAN port** `PHONEHAUL_TRANSFER_PORT` (default `57322`; `0` = random, see env vars below) — all interfaces on Linux;
- the **UI** on `127.0.0.1:<uiPort>` (loopback only; the UI is never exposed on the LAN).

Settings persist to the settings file (see **Settings** below).

## Running the desktop app (Tauri)

The desktop app **bundles the receiver** (`phonehaul-server`) and launches it as a child process. It does **not** use a fixed LAN port — the sidecar picks a **random** port each launch (see [README](../README.md#troubleshooting)).

```sh
# from the repo root
npm ci --prefix receiver
npm ci --prefix desktop
npm run desktop:dev                    # run the Tauri desktop app in dev mode
npm run desktop:build                  # build Tauri bundles (default)
```

The Rust backend (in-process Tauri plugin) supervises the sidecar: it starts it with
`PHONEHAUL_DESKTOP_MANAGED=1 PHONEHAUL_NO_BROWSER=1 PHONEHAUL_TRANSFER_PORT=0`,
waits up to 30 s for the `PHONEHAUL_READY <json>` line on the sidecar's stdout
(`{uiUrl, host, port}`), then issues Tauri commands (`get_status`, `refresh_qr`,
`set_destination`, `send_files`, `queue_dropped_paths`) and relays
`event`/`drop` events back to the frontend. It talks to the sidecar only over
`127.0.0.1` (the sidecar's loopback guard rejects everything else, HTTP 403).
The sidecar is killed (`SIGTERM` on Unix / `kill` on Windows) when the desktop
app exits. See [docs/security.md](security.md) for the boundary details.

**Window size.** The window starts at **580 × 763** logical pixels, the size that
exactly fits the rendered content at the frontend's `max-width: 580px` (measured in
headless Chromium with the queue and message areas empty). The minimum is
**284 × 520**: 284 is the narrowest width the content reflows to without horizontal
overflow, and below the content height the page scrolls. The `window-state` plugin
remembers only the window **position** (`StateFlags::POSITION`, file
`window-state-compact.json` in the app config dir); size and maximized state are not
restored, so startup is always the content-fit default.

## Building the standalone receiver

The standalone receiver is a **Node.js SEA** executable (the receiver bundled
into one file). It is what users download for Linux (plus a Linux-only
AppImage wrapper).

```sh
# from the repo root
npm run package:sea --prefix receiver          # SEA executable -> dist/phonehaul-{platform}-{arch}
npm run package:appimage --prefix receiver     # Linux AppImage (+ SEA executable)
```

### Linux AppImage — runtime requirement

The AppImage **runtime is not auto-downloaded at runtime**. It must be
present at **build time** and passed to `appimagetool` via `--runtime-file`.
`appimagetool` must be on `PATH`.

```sh
# 1. appimagetool + runtime must be available (one-off)
#    appimagetool:  https://github.com/AppImage/type2-runtime
#    runtime:       https://github.com/AppImage/type2-runtime/releases (runtime-{arch})

# 2. build
APPIMAGETOOL=appimagetool APPIMAGE_RUNTIME=./runtime-x86_64 \
  npm run package:appimage --prefix receiver
chmod +x dist/PhoneHaul-*.AppImage
```

Outputs:
- `dist/PhoneHaul-x86_64.AppImage` (or `dist/PhoneHaul-aarch64.AppImage`;
  Linux only)
- `dist/phonehaul-linux-x64` (or `-arm64`) — SEA executable, also works on Linux

Run either:

```sh
./dist/PhoneHaul-*.AppImage        # or
./dist/phonehaul-linux-x64
```

> **Note:** the standalone receiver AppImage is **Linux-only**. On Linux you
> also have the *desktop* app's AppImage — see [README](../README.md#which-appimage)
> for which one to pick.

## Building the Android app

```sh
# debug APK
cd android
./gradlew :app:assembleDebug        # -> app-debug.apk

# unit tests + lint (CI)
./gradlew :app:testDebugUnitTest :app:lintDebug :app:ktlintCheck
```

Release builds (APK + AAB with signing) are produced by CI, not locally.
See **Release workflow** below.

## Platform build notes

### Linux (Tauri)

Install Tauri's native dependencies, then build the AppImage:

```sh
sudo apt-get install --yes build-essential curl wget file libssl-dev libxdo-dev \
  libayatana-appindicator3-dev librsvg2-dev libgtk-3-dev libwebkit2gtk-4.1-dev \
  libjavascriptcoregtk-4.1-dev libsoup-3.0-dev libldap2-dev libfuse2 patchelf

npm run desktop:build -- --bundles appimage
# -> desktop/src-tauri/target/release/bundle/appimage/PhoneHaul_*.AppImage
```

### Windows (Tauri, Git Bash)

Requires **Node 24**, **Rust**, and **NSIS** (`makensis`) on PATH.

```sh
bash scripts/build-desktop-windows.sh
# -> desktop/src-tauri/target/release/bundle/nsis/PhoneHaul.exe (NSIS installer)
```

**Windows Store MSIX:** additionally set the Partner Center identity repo
variables `MSIX_IDENTITY_NAME` and `MSIX_PUBLISHER` (GitHub repo variables).
Without them the MSIX build is skipped.

> macOS and Windows commands above are **unverified on this (Linux) workstation**.
> The Windows Store MSIX path requires a Partner Center account.

### macOS (Tauri)

Requires **Node 24**, Xcode Command Line Tools, **Rust**, and `codesign`.

```sh
bash scripts/build-desktop-macos.sh
# -> desktop/src-tauri/target/release/bundle/dmg/PhoneHaul.dmg
```

> macOS commands above are **unverified on this (Linux) workstation**.
> The macOS build script produces an **unsigned DMG**. Public signing /
> notarization (codesigning certificate + notarization key) is **future work**
> — not part of the current release.

## Environment variables

| Variable | Default | Effect |
|----------|---------|--------|
| `PHONEHAUL_TRANSFER_PORT` | `57322` | LAN port the receiver binds. `0` = random (used by the desktop sidecar). Must be in `0–65535`. |
| `PHONEHAUL_NO_BROWSER` | unset | `1` suppresses auto-opening a browser on the LAN UI. Set by the desktop app. |
| `PHONEHAUL_SETTINGS_FILE` | platform default | Absolute path overriding where the settings file is read/written. |
| `PHONEHAUL_EXIT_ON_UI_CLOSE` | unset | `1` makes the receiver exit 15 s after the last UI heartbeat (no open UI tab). |
| `PHONEHAUL_DESKTOP_MANAGED` | unset | `1` (desktop-managed): emit `PHONEHAUL_READY {…}` on stdout and exit on `SIGINT`/`SIGTERM` or stdin EOF instead of auto-browsing. |
| `PHONEHAUL_SERVER_BIN` | `dist/phonehaul-…` | Debug-only: override which server binary the desktop launches. |
| `XDG_DOWNLOAD_DIR` | `$XDG_DATA_HOME/phonehaul/downloads` or `~/Downloads` | Linux override for the downloads directory. |
| `APPIMAGETOOL` | `appimagetool` | Path to `appimagetool` (build-time, AppImage). |
| `APPIMAGE_RUNTIME` | unset | Path to the AppImage runtime file (build-time, passed to `appimagetool --runtime-file`). |
| `MSIX_IDENTITY_NAME` / `MSIX_PUBLISHER` | unset | GitHub repo variables for the Windows Store MSIX build. |

The UI (not the server) also accepts these as **query params** on the LAN UI
root (for the "Open phone UI" / pairing links): `host` (override), `port`
(override), `ui` (force UI on LAN, `ui=1`), and `pair` (QR refresh).

## Settings

The receiver stores a small JSON settings file.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `destination` | string (abs path) | `<Downloads>/PhoneHaul` | Destination folder for incoming files. Must be an existing directory. |
| `conflict` | string | `rename` | `rename` \| `skip` \| `replace` — what to do when a file already exists. |

### Settings file location

| Platform | Path |
|----------|------|
| Linux | `${XDG_CONFIG_HOME:-$HOME/.config}/phonehaul/settings.json` |
| Windows | `%APPDATA%\PhoneHaul\settings.json` |
| macOS | `~/Library/Application Support/PhoneHaul/settings.json` |

## App icons

Every platform icon comes from one master asset, `assets/icon.png` (1024x1024,
square, transparent corners). The artwork is a gradient-heavy raster, so it is
**not** vectorizable — the committed platform assets are downscaled rasters
generated from the master.

| Platform | Assets | Sizes |
|----------|--------|-------|
| Tauri (Linux/Windows/macOS) | `desktop/src-tauri/icons/icon.png`, `icon.ico`, `icon.icns` | 512; ICO 16/32/48/64/128/256; ICNS 16–1024 |
| Windows Store (MSIX) | `desktop/msix/Assets/{StoreLogo,Square150x150Logo,Square44x44Logo}.png` | 50 / 150 / 44 |
| Android launcher | `android/app/src/main/res/mipmap-*/ic_launcher.png` + `ic_launcher_foreground.png`, `mipmap-anydpi-v26/ic_launcher.xml` | 48/72/96/144/192; foreground 108dp with the artwork inset to the 72dp safe zone |
| Linux AppImage | `assets/appicon-128.png` → `usr/share/icons/hicolor/128x128/apps/phonehaul.png` + `.DirIcon` | 128 |

Regenerate with ImageMagick:

```sh
magick assets/icon.png -resize 512x512 desktop/src-tauri/icons/icon.png
for s in 16 32 48 64 128 256; do magick assets/icon.png -resize ${s}x${s} /tmp/i${s}.png; done
magick /tmp/i16.png /tmp/i32.png /tmp/i48.png /tmp/i64.png /tmp/i128.png /tmp/i256.png \
  desktop/src-tauri/icons/icon.ico
magick assets/icon.png -resize 50x50 desktop/msix/Assets/StoreLogo.png
magick assets/icon.png -resize 150x150 desktop/msix/Assets/Square150x150Logo.png
magick assets/icon.png -resize 44x44 desktop/msix/Assets/Square44x44Logo.png
magick assets/icon.png -resize 128x128 assets/appicon-128.png

for d in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  n=${d%%:*}; s=${d##*:}
  magick assets/icon.png -resize ${s}x${s} android/app/src/main/res/mipmap-$n/ic_launcher.png
done
for d in mdpi:108 hdpi:162 xhdpi:216 xxhdpi:324 xxxhdpi:432; do
  n=${d%%:*}; s=${d##*:}
  magick assets/icon.png -resize $((s*2/3))x$((s*2/3)) -background none -gravity center -extent ${s}x${s} \
    android/app/src/main/res/mipmap-$n/ic_launcher_foreground.png
done
```

ImageMagick writes an ICNS as a single PNG, so the container is built directly:

```python
import struct, subprocess
pairs = [('ic11', 16), ('ic12', 32), ('ic13', 32), ('ic14', 64),
         ('ic15', 128), ('ic16', 256), ('ic09', 512), ('ic10', 1024)]
entries = []
for t, s in pairs:
    p = f'/tmp/icns_{t}.png'
    subprocess.run(['magick', 'assets/icon.png', '-resize', f'{s}x{s}', p], check=True)
    entries.append((t.encode(), open(p, 'rb').read()))
body = b''.join(t + struct.pack('>I', 8 + len(d)) + d for t, d in entries)
open('desktop/src-tauri/icons/icon.icns', 'wb').write(b'icns' + struct.pack('>I', 8 + len(body)) + body)
```

> The ICNS above was generated on **Linux**; macOS rendering is **unverified on
> this workstation**. The Android adaptive background (`@color/ic_launcher_background`,
> `#0146FD`) is the dominant blue of the artwork.

## Checking the code

**Canonical gate (root):**

```sh
npm run check          # = check:format && lint && test && smoke
```

- `check:format` — `prettier --check` over `receiver/`, `desktop/`, `integration-tests/`, `protocol/`, `package.json`
- `lint` — ESLint over `receiver`, `desktop`, `integration-tests`
- `test` — `npm --prefix receiver test` (unit tests)
- `smoke` — `node integration-tests/smoke.js` (integration smoke)

Per area:

| Area | Commands |
|------|----------|
| receiver (JS) | `npm --prefix receiver test` · `npm --prefix receiver smoke:sea` |
| desktop (Rust) | `cargo fmt --check` · `cargo clippy -- -D warnings` · `cargo test` (run in `desktop/src-tauri`) |
| android (Kotlin) | `./gradlew :app:testDebugUnitTest :app:lintDebug :app:ktlintCheck` |

Formatting is automatic (Prettier/`cargo fmt`); run `npm run check` before
committing. See [AGENTS.md](../AGENTS.md) for durable contributor rules.

## Release workflow

CI workflow **`PhoneHaul builds`** (`.github/workflows/`) runs on push/PR and on
release tags. Artifacts are available in a workflow run's **Files** tab.

| Job | Platform | Output | CI artifact |
|-----|----------|--------|-------------|
| `android` | Android | debug APK + unit/lint/ktlint | `phonehaul-android-debug` |
| `sea` | Linux x64 + arm64 | AppImage + SEA executable | `phonehaul-{linux-x64,linux-arm64}` |
| `desktop` | Linux (AppImage) | Tauri AppImage | `phonehaul-desktop-linux` |
| `desktop` | Windows (NSIS) | installer `.exe` | `phonehaul-desktop-windows` |
| `desktop` | macOS x64 + arm64 (DMG) | `.dmg` (unsigned) | `phonehaul-desktop-macos-{x64,arm64}` |

Release signing is handled by CI secrets; **keystores are never committed**.
