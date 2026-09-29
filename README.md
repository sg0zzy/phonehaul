# PhoneHaul

**Scan. Select. Move.** PhoneHaul moves files from an Android phone to a computer on the same local network. It has no accounts, cloud service, or Internet relay.

This repository contains the desktop receiver, a native Android client, and a fake sender for protocol testing. The fake sender never deletes source files; MOVE deletion belongs to the Android client.

## Desktop Receiver

End users do not need Node.js, npm, or development tools. Download the PhoneHaul Receiver for your system and launch it. The receiver starts and opens the PhoneHaul page in your default browser. Scan the displayed QR code with PhoneHaul on Android, select files, then choose MOVE or COPY.

Linux AppImages are the primary Linux distribution format:

```sh
chmod +x PhoneHaul-x86_64.AppImage
./PhoneHaul-x86_64.AppImage
```

The receiver binds the management page to `127.0.0.1`, while its HTTPS transfer listener remains reachable at the selected private LAN address. The AppImage browser page sends a heartbeat every 5 seconds; if no heartbeat arrives for 15 seconds, the receiver shuts down. The executable stores settings in the normal per-user configuration directory and does not write mutable data beside itself. No administrator/root privileges are required.

Current local builds produce a standalone host executable. Linux can also wrap it in an AppImage. Windows Setup and macOS DMG installers are future distribution work; unsigned public Windows/macOS downloads can trigger operating-system warnings, and public releases should be signed/notarized.

### Run from source

Developers need Node.js 24 LTS and npm:

Use Node.js 24 LTS (`.nvmrc` selects the major version).

```sh
nvm install
nvm use
npm install --prefix receiver
npm run dev
```

The receiver opens a browser on `127.0.0.1`. Its HTTPS transfer listener binds only to a private LAN IPv4 address, on port `57322` by default. Scan the displayed QR code with a compatible sender. The destination defaults to the system Downloads folder with `PhoneHaul` beneath it, and can be changed in the local UI. On Linux this honors `XDG_DOWNLOAD_DIR` or `user-dirs.dirs`; Windows uses the user's Downloads known-folder setting. Settings persist in `$XDG_CONFIG_HOME/phonehaul/` (Linux), `%APPDATA%/PhoneHaul/` (Windows), or `~/Library/Application Support/PhoneHaul/` (macOS). Set `PHONEHAUL_TRANSFER_PORT` before launching if that port is unavailable.

### Build the desktop receiver

Install the receiver dependencies once, then use these commands from the repository root:

```sh
npm install --prefix receiver
npm run build             # bundle the Node receiver for inspection
npm run package:sea       # standalone executable for the current OS/architecture
npm run package:appimage  # Linux AppImage (also creates the SEA executable)
npm test
```

SEA outputs go in `dist/` (for example, `dist/phonehaul-linux-x64`). `package:sea` packages only for the current host; build each release target on its matching OS and CPU. The Linux AppImage command also requires `appimagetool` on `PATH` or an `APPIMAGETOOL` path. If it cannot download its runtime automatically, download the matching `runtime-x86_64` or `runtime-aarch64` from [AppImage type2-runtime releases](https://github.com/AppImage/type2-runtime/releases) and set `APPIMAGE_RUNTIME` to that file. CI builds Linux x64/arm64 AppImages and SEA executables, Windows x64/arm64 and macOS x64/arm64 SEA executables, and an Android debug APK with unit tests. macOS x64 SEA support is experimental in Node.js, so that matrix leg is best-effort.

To build the Windows `.exe` locally, use a Windows machine (the SEA package embeds that machine's Node executable). Install Node.js 24 LTS and Git; no .NET or Android SDK is needed for the desktop receiver. In PowerShell, from the repository root, run:

```powershell
npm install --prefix receiver
npm --prefix receiver run package:sea
```

The standalone file is `dist\phonehaul-windows-x64.exe` on Windows x64, or `dist\phonehaul-windows-arm64.exe` on Windows ARM64. It includes its Node runtime, so end users do not need Node installed. The existing GitHub Actions workflow also builds these Windows executables and uploads them as workflow artifacts; they are executable packages, not a Setup installer.

The source workflow remains available with `npm run dev`. To smoke-test a generated SEA executable, run `npm run smoke:sea` after packaging it.

### Build with helper scripts

From the repository root on Linux, the scripts under `scripts/` select the Node version from `.nvmrc` with nvm (installing it if needed), install the receiver's locked npm dependencies, and run the selected build:

```sh
./scripts/build-receiver.sh  # Node bundle for inspection
./scripts/build-android.sh   # Debug APK and Android unit tests
./scripts/build-appimage.sh  # Linux AppImage and embedded SEA executable
./scripts/build-all.sh       # Bundle, Android APK/tests, then AppImage
```

Android builds need a JDK 17 and Android SDK 36. The Gradle wrapper reads `android/local.properties`, `ANDROID_HOME`, or `ANDROID_SDK_ROOT`. AppImage builds need `appimagetool` and the matching type 2 runtime; the script automatically uses `~/opt/appimagetool` and `~/opt/runtime-x86_64` (or `runtime-aarch64`) when present. Override those locations with `APPIMAGETOOL` and `APPIMAGE_RUNTIME` if needed.

For development, obtain the QR URI from the rendered QR and run:

```sh
node integration-tests/fake-sender.js 'phonehaul://pair?v=1&h=...&p=...&s=...&f=...' /path/to/file
```

Run receiver tests with `npm test`.

### Connection troubleshooting

If Android says the QR expired, scan the current code in the receiver browser. Unused QR sessions now refresh automatically every five minutes; restart an older running receiver to get this behavior.

The receiver terminal logs `device connected` after a successful handshake and `pairing rejected` for a stale or invalid QR. If neither appears when the phone tries to connect, check the LAN address and firewall first.

If Android cannot reach the displayed LAN address, check that the browser shows the expected computer IP, that both devices are on the same local network, and that the computer firewall allows incoming TCP on port `57322` (or the port shown in the browser). Guest Wi-Fi or client isolation can block device-to-device traffic even when both devices use the same Wi-Fi name. The localhost browser port is for the computer UI only; Android connects to the LAN HTTPS port in the QR.

If Android reports a secure connection failure, restart the receiver and scan its new QR so the certificate fingerprint matches the current receiver process.

## Build the Android app

Open `android/` in Android Studio, or use the Gradle wrapper with an installed Android SDK:

```sh
cd android
ANDROID_HOME=/path/to/Android/Sdk ./gradlew :app:assembleDebug :app:testDebugUnitTest
```

The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. Install it on an Android 11 or newer phone. Start the receiver on the same local network, scan the QR, select files or a folder, and choose COPY or MOVE. MOVE is enabled only when selected files report deletion support. MediaStore photos and videos use Android's deletion confirmation after the receiver commits them.

## Status

Implemented: local UI, QR sessions, ephemeral HTTPS certificate with QR fingerprint, streaming single-file uploads, manifest and path checks, disk preflight, conflict policies, partial files, SHA-256 verification, atomic file commit, cancellation endpoint, local progress events, persistent destination settings, and a native Android app with QR scanning, SAF and media selection, COPY, and per-file MOVE deletion. Repeated transfers merge into existing directories. Identical files are detected by SHA-256 and skipped; different same-name files use the selected conflict policy. MOVE leaves source folders in place. Desktop SEA and Linux AppImage build scripts and cross-platform build CI are in place.

Pending: Windows Setup and macOS DMG packaging, public code signing/notarization, and device-level testing across Android storage providers. Android 11+ SAF restrictions still apply; some folders and provider-backed files cannot be selected or deleted. The app reports files that could not be deleted after transfer.

See [protocol](docs/protocol.md), [security](docs/security.md), and [architecture](docs/architecture.md).
