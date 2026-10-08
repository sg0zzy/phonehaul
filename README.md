# PhoneHaul

Move files between an Android phone and a computer over your local network.
No cloud, no server to run beyond the receiver itself, and no account.

## How it works

1. Run the receiver on your computer (or the desktop app, which runs one for
   you).
2. Scan the QR code with the PhoneHaul Android app.
3. Select files or folders on your phone; they land in a folder on your
   computer.
4. (Optional) Select files/folders on your computer and they're sent to your
   phone's `Downloads` folder.

Folder contents are preserved; files already present at the destination are
skipped (configurable) rather than re-downloaded.

## Download

Builds are produced by CI (`.github/workflows/`). Download from a workflow run's
**Files** tab, or from GitHub Releases once tagged:

| You are on | Get |
|------------|-----|
| **Android** | the `phonehaul-android-debug` APK/AAB artifact |
| **Linux (receiver only)** | `phonehaul-linux-x64` / `phonehaul-linux-arm64` (receiver + AppImage) |
| **Linux / macOS / Windows (desktop app)** | `phonehaul-desktop-{linux, windows, macos-x64, macos-arm64}` |

### Which AppImage do I pick on Linux?

There are two Linux AppImages — they do different things:

| AppImage | What it is | Use it when |
|----------|-----------|-------------|
| **`PhoneHaul-x86_64.AppImage`** (receiver) | The **standalone receiver**: just the LAN/QR receiver + local UI, as a single portable file. | You only need to **receive** files from your phone and don't need the native desktop shell (file pickers, drag-drop, auto-restart, system tray). |
| **`PhoneHaul_*.AppImage`** (desktop) | The **desktop app**: a full Tauri window that **bundles and supervises the receiver** as a child process, with native file/folder pickers, drag-drop, and auto-restart of the receiver. | You want the **full desktop experience** (or to send files from computer → phone with a native picker). |

Both start the same receiver; the desktop one just manages it for you.

## Run it

**Standalone receiver (Linux):**

```sh
./PhoneHaul-x86_64.AppImage   # or the SEA executable: ./phonehaul-linux-x64
```

**Desktop app:** open its installer/AppImage/DMG. It starts the receiver
automatically. See [docs/development.md](docs/development.md) for the full
build matrix, environment variables, and per-platform notes.

## Troubleshooting

### Desktop app

- **The receiver's LAN port changes between launches.** The desktop app runs
  the receiver as a bundled sidecar with a **random** LAN port
  (`PHONEHAUL_TRANSFER_PORT=0`), so it is not a fixed address like `:57322`.
  Pairing always uses the QR code, which carries the current port — just scan
  a fresh QR after restarting the app.
- **Phone won't connect / QR stopped working.** QR codes expire after 5 minutes
  and are re-generated on restart. The QR also reappears when the paired phone
  goes quiet for 15 s — disconnecting on the phone ends the pairing — so scan
  the code shown again. Click **New QR** or relaunch the app.
- **The desktop restarts the receiver for you.** The sidecar is killed when the
  desktop exits and restarted on relaunch, so a stuck receiver is fixed by
  relaunching the desktop app. A desktop app killed without running its exit hook
  still stops the sidecar 15 s after its last heartbeat.

### Standalone receiver

- **Fixed port `57322` (configurable via `PHONEHAUL_TRANSFER_PORT`).** If
  your firewall blocks the receiver's port, allow **UDP/TCP 57322** (or whatever
  `PHONEHAUL_TRANSFER_PORT` is set to) on the LAN. The standalone receiver does
  **not** pick a random port — it uses this default unless you set it.
  *Note: the desktop app always uses a random port, so firewall advice for a
  fixed port applies only to the standalone receiver.*
- **Auto-shutdown.** If no UI tab is open, the standalone receiver exits 15 s
  after the last UI activity (controlled by `PHONEHAUL_EXIT_ON_UI_CLOSE`).
  Keep a browser tab (or use the desktop app) if you want it to stay up.
- **No `npm install` needed to run a release build.** The receiver ships as a
  single SEA/AppImage file. The `npm ci` instructions in the docs are for
  building from source only.

## Documentation

- [Developer guide — builds, release, env vars, settings](docs/development.md)
- [Protocol](docs/protocol.md)
- [Security model](docs/security.md)
- [Architecture](docs/architecture.md)
- [Privacy policy](docs/privacy.html)
- [Rules for contributors / AI agents](AGENTS.md)
