# Architecture

`receiver/src/server` owns the local HTTP UI and LAN HTTPS API. `receiver/src/transfer`
validates manifests and streams files to the configured destination.
`receiver/src/security` owns pairing and path checks. `receiver/src/settings`
persists only destination and conflict policy. `receiver/src/web` is the browser
UI; it never receives file bytes.

The Android application owns QR scanning, selection, hashing, upload, and
per-file MOVE deletion. It lives in `android/app`: `PairingParser` validates the
QR, `Selection` and `MediaRepository` enumerate sources, `ReceiverClient` pins the
TLS certificate and streams files, and `PhoneHaulViewModel` manages the transfer
states. The fake sender in `integration-tests` exercises the wire protocol without
an Android device. `protocol/` holds the versioned manifest schema and test
vector.

The receiver's web UI is generated from `receiver/src/web/page.js` and served
only on loopback; no external static files are required.
`receiver/scripts/package-sea.js` bundles the receiver and dependencies as
CommonJS with esbuild, then embeds it in the matching Node.js executable using
SEA. User settings are written to the OS per-user configuration directory. The
LAN HTTPS listener continues to bind to the private address selected by
`localAddress()`.

## Desktop app (Tauri)

The desktop app lives in `desktop/`. It is **not** a separate protocol
implementation — it is a native shell that **bundles the receiver as a child
process** ("the sidecar") and drives it.

- **Layout.** `desktop/src` is the Tauri frontend (HTML/CSS/JS, mirroring the
  browser UI, plus native file/folder pickers and drag-drop). `desktop/src-tauri/src`
  is the Rust backend. The backend is a set of `#[tauri::command]` handlers only
  (`get_status`, `refresh_qr`, `set_destination`, `send_files`,
  `queue_dropped_paths`); there is no plugin with arbitrary code execution.
- **Sidecar lifecycle.** On startup the Rust backend bundles and launches
  `phonehaul-server` with
  `PHONEHAUL_DESKTOP_MANAGED=1 PHONEHAUL_NO_BROWSER=1 PHONEHAUL_TRANSFER_PORT=0`
  (random LAN port), piping stdout/stderr. It waits up to 30 s for the sidecar's
  `PHONEHAUL_READY { "uiUrl", "host", "port" }` line, then writes a `heartbeat`
  line to the sidecar's stdin every 5 s. On exit it kills the sidecar (`SIGTERM`
  on Unix / `kill` on Windows); the sidecar closes its servers and drops its
  stdin handle, so it exits and the Rust `child.wait()` returns. If the desktop
  process is killed without running its exit hook, stdin EOF ends the sidecar
  when the backend exclusively holds the pipe's write end; when that write end
  stays open elsewhere, the sidecar stops 15 s after the last heartbeat instead
  of running on.
- **Backend ↔ sidecar.** The Rust backend talks to the sidecar **only over
  `127.0.0.1`** via a single static `reqwest` client (5 s connect / 10 s
  request timeout). It maps Tauri commands to the sidecar's loopback UI
  (`GET /api/ui`, `POST /api/qr/refresh`, `POST /api/settings`,
  `POST /api/send/items`) and relays `event`/`drop` events back to the frontend.
  The UI is loopback-only (403 guard) and the LAN port is random, so the desktop
  never exposes a fixed, forwardable LAN endpoint — see
  [security.md](security.md).
- **Queue feeding.** The desktop's pickers/drops feed the **same** `SendQueue`
  used by the browser UI, through the same loopback endpoints; the desktop adds a
  native UX layer without changing the dispatch logic.
- **Window.** Starts content-fit at 580 × 763 logical pixels (minimum 284 × 520);
  the `window-state` plugin restores position only, so startup size is always the
  configured default — see [development.md](development.md).

## Computer → Android

Browser selection and folder traversal stay in `page.js`. `SendQueue` owns
staged file state and ordered dispatch independently of browser `File` objects.
The local server streams browser bytes into temporary queue files and exposes
them through the existing paired LAN HTTPS server. `ReceiverClient` polls that
server while connected, and `PhoneInbox` validates paths and writes all files
directly to public Downloads through MediaStore. The Tauri desktop feeds the
same queue (via its pickers/drops) without changing dispatch logic.
