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
It writes a `heartbeat` line to the sidecar's stdin immediately and then every
5 s; managed mode exits 15 s after the last heartbeat, so a desktop app killed
without running its exit hook still takes the sidecar with it. On a normal exit
the backend kills the sidecar (`SIGTERM` on Unix / `kill` on Windows). See
[docs/security.md](security.md) for the boundary details.

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
> also have the *desktop* app's AppImage — see
> [README](../README.md#which-appimage-do-i-pick-on-linux) for which one to pick.

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
| `PHONEHAUL_HEARTBEAT_TIMEOUT_MS` | `15000` | Desktop-managed mode: exit this many milliseconds after the last `heartbeat` line on stdin. Inert until the first heartbeat arrives. |
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
| Tauri (Linux/Windows/macOS) | `desktop/src-tauri/icons/icon.png`, `icon.ico`, `icon.icns`, `16x16.png`–`256x256.png` | 512; ICO 16/32/48/64/128/256; ICNS 16–1024; AppImage hicolor 16/32/48/64/128/256/256@2/512 |
| Windows Store (MSIX) | `desktop/msix/Assets/{StoreLogo,Square150x150Logo,Square44x44Logo}.png` | 50 / 150 / 44 |
| Android launcher | `android/app/src/main/res/mipmap-*/ic_launcher.png` + `ic_launcher_foreground.png`, `mipmap-anydpi-v26/ic_launcher.xml` | 48/72/96/144/192; foreground 108dp with the artwork inset to the 72dp safe zone |
| Linux AppImage | `assets/appicon-128.png` → `usr/share/icons/hicolor/128x128/apps/phonehaul.png` + `.DirIcon` | 128 |
| In-app UI | `desktop/frontend/public/icon.png` (favicon + header mark), `receiver/src/web/icon.js` (data URI — the receiver has no static-asset route and the SEA bundle has no filesystem assets) | 128 / 64 |

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
for s in 16 32 48 64 128 256; do
  magick assets/icon.png -resize ${s}x${s} desktop/src-tauri/icons/${s}x${s}.png
done
magick assets/icon.png -resize 256x256 'desktop/src-tauri/icons/128x128@2x.png'
magick assets/icon.png -resize 128x128 desktop/frontend/public/icon.png
magick assets/icon.png -resize 64x64 /tmp/i64.png
printf "export const icon =\\n  'data:image/png;base64,%s';\\n" "$(base64 -w0 /tmp/i64.png)" > receiver/src/web/icon.js

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

## Store publishing

Both stores are wired in CI. The build/sign scripts are already in the repo;
what's left is account registration plus a few GitHub secrets/variables you
add once. Neither store requires a paid code-signing certificate — Android
uses a free self-generated keystore, and the Microsoft Store re-signs the
MSIX with a Microsoft certificate (no cert needed for an MSIX submission).

### Google Play (Android)

The workflow **`Android signed release`** (`.github/workflows/android-signed-release.yml`)
runs on `v*` tags (and `workflow_dispatch`), in the protected **`release`**
environment, and uploads a signed **APK** and **AAB** as the artifact
`phonehaul-android-release`. Signing is read from four `release`-environment
secrets (never committed):

| Secret | What it is |
|--------|-----------|
| `ANDROID_KEYSTORE_BASE64` | `base64` of the `.jks` upload keystore |
| `ANDROID_STORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | key alias |
| `ANDROID_KEY_PASSWORD` | key password |

`versionCode` is taken from `GITHUB_RUN_NUMBER` (auto-increments per tag);
`versionName` is `0.1.0` in `android/app/build.gradle.kts`. To upload:

1. In Play Console, create the app and **enroll in Play app signing** (Google
   keeps the production key; you supply an *upload* key).
2. Generate a free upload keystore (never commit it):
   ```sh
   keytool -genkeypair -v -keystore phonehaul-upload.jks -storetype PKCS12 \
     -alias phonehaul -keyalg RSA -keysize 2048 -validity 10000
   ```
   Enter the same value as both the keystore and the key password when
   prompted. That value is **both** `ANDROID_STORE_PASSWORD` and
   `ANDROID_KEY_PASSWORD`. **Back up the `.jks` and its passwords offline** —
   losing them means you can never update the app.
3. Add the four secrets above to the `release` environment
   (Settings → Environments → `release` → Secrets); `ANDROID_KEYSTORE_BASE64`
   is the output of `base64 -w0 phonehaul-upload.jks`.
4. Tag and push: `git tag v0.1.0 && git push origin v0.1.0`.
5. Download the `phonehaul-android-release` artifact; upload the **`.aab`** in
   Play Console (an AAB is required for production; the APK is for
   internal/managed tracks).

### Privacy policy and Data safety

The policy is [docs/privacy.html](privacy.html). The `docs/` folder is the GitHub
Pages source, so it serves at
`https://sg0zzy.github.io/phonehaul/privacy.html`; the Android app opens that URL
from its About screen, which is what Play requires (policy linked in the Console
**and** reachable inside the app).

Keep the Data safety answers consistent with the policy text. Play defines
"collect" as transmitting data off the device, so the file contents and metadata
PhoneHaul sends to the paired computer are collected even though the recipient is
a device the user controls. The policy must name the developer exactly as the Play
listing does; privacy inquiries are handled through GitHub issues, which is the
policy's contact mechanism.

Play also requires a prominent disclosure inside the app, immediately before each
runtime permission request, with an affirmative user action. The app shows a
"Before you continue" screen (`Screen.DISCLOSE`) ahead of the camera, notification,
and media permission prompts whenever a prompt is about to be launched, so the
disclosure always precedes the request. Keep its wording aligned with the policy.

### Microsoft Store (Windows, MSIX)

The **`desktop`** job in **`PhoneHaul builds`** builds an **unsigned** MSIX on
the Windows runner when the repo variables `MSIX_IDENTITY_NAME` and
`MSIX_PUBLISHER` are set, and uploads it under `dist/msix/*.msix` in the
`phonehaul-desktop-windows` artifact. It is **x64** (the CI runner is x64).
The Store re-signs it with a Microsoft certificate, so no code-signing
certificate is needed.

Set these GitHub **repository variables** (Settings → Secrets and variables →
Actions → Variables):

| Variable | Value | Notes |
|----------|-------|-------|
| `MSIX_IDENTITY_NAME` | e.g. `youraccount.PhoneHaul` | 3–50 chars, `[A-Za-z0-9.-]`; exact Partner Center package name |
| `MSIX_PUBLISHER` | e.g. `CN=Your Name, O=Your Name, L=City, S=State, C=US` | full Publisher DN, **exact** match to Partner Center, must start with `CN=` |
| `MSIX_PUBLISHER_DISPLAY_NAME` | e.g. `Your Name` | optional, shown in the Store |
| `MSIX_VERSION` | e.g. `1.0.0.0` | optional, default `1.0.0.0`; four numbers, first nonzero, last `0` |

To register and submit:

1. Register as a Microsoft Store developer (Partner Center) — one-time fee.
2. In Partner Center, **New product → "MSIX or APPX"** (a *packaged* product,
   **not** "EXE or MSI app"). Reserve the app name.
3. Note the exact **Package identity** and **Publisher** DN from the product's
   identity details, and put them in the variables above.
4. Build (tag `v*`, or run `workflow_dispatch`) and download the `.msix`.
5. In Partner Center, create a submission and upload the `.msix`.

**Two things to expect on this path** (a `runFullTrust` / "packaged classic"
Win32 app):
- **WebView2.** The manifest's `MinVersion` is `10.0.19041.0` (21H1). The
  Evergreen WebView2 runtime is preinstalled on every Windows 11 device and was
  pushed to eligible Windows 10 devices by Microsoft, so the app finds it on
  essentially all supported machines without bundling one. Do **not** add a
  `Microsoft.WebView2` ExternalDependency — those are a known install failure
  and aren't needed at this `MinVersion`. On the rare device missing the
  runtime, the user installs it from
  <https://developer.microsoft.com/microsoft-edge/webview2/>.
- **`runFullTrust` review.** Packaging a desktop app as an MSIX marks it
  `runFullTrust`; the Store may ask for a justification and gives it extra
  vetting. If certification rejects it, the documented fallback is to register
  the product as **"EXE or MSI app"** and upload a *code-signed* NSIS
  installer (offline WebView2) instead — that path needs a paid CA
  code-signing certificate, which is why the free default here is the MSIX.

### Local signing (optional, for sideloading)

- **Android:** `build.gradle.kts` also reads `~/.secrets/android/phonehaul/keystore.properties`
  (keys `storeFile`, `storePassword`, `keyAlias`, `keyPassword`) so you can
  build a signed release locally.
- **Windows:** `npm --prefix desktop run package:msix` produces an unsigned
  MSIX (needs `MSIX_IDENTITY_NAME`/`MSIX_PUBLISHER` set). To sideload it,
  sign it yourself with `signtool` using a self- or CA-signed cert
  (`makeappx pack` is used by the script; add `signtool sign /fd sha256 /a`
  after, then install with `Add-AppPackage`).
