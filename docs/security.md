# Security model

The receiver binds **HTTPS only to one detected private IPv4 LAN address**. The
management UI binds to **`127.0.0.1`** (loopback). The QR carries a random
256-bit capability and the SHA-256 fingerprint of an ephemeral TLS certificate
(regenerated each receiver launch). Android must verify both the private
destination address and certificate fingerprint before sending data.

## Incoming-files model (phone → computer)

Incoming files are validated end to end before they are written to the destination:

- **Manifest validation.** `POST /api/transfers` is checked against
  [manifest.js](../receiver/src/transfer/manifest.js): absolute paths, backslashes,
  empty segments, `.`/`..`, duplicate IDs/paths, and oversized entries (64 GiB
  cap) are rejected.
- **Symlink traversal.** The receiver `lstat`s every destination parent to
  reject symlink traversal. It never uses a source-provided absolute destination.
- **Partial writes.** Files are written with exclusive creation as
  `*.phonehaul-partial`. They are **committed only after** the streamed bytes
  match the manifest size and SHA-256 (or, for hashed items, the receiver's
  streamed hash matches the existing destination for `already_present`).
- **Conflict policy.** When a file already exists, the configured `conflict`
  policy (`rename` | `skip` | `replace`, default `rename`) governs the outcome;
  the PUT upload ack reports the final disposition
  (`committed` | `already_present` | `skipped`).
- **Cleanup.** Interrupted/failed partials are removed on upload failure; an
  unclean process exit may leave partials, which the UI exposes for explicit
  cleanup.

The receiver does not log session tokens, keys, or certificate material.

## Computer → Android paths

Computer → Android paths are checked by the desktop queue **and** re-checked on
Android. Android sets every `MediaStore.Downloads.RELATIVE_PATH` to the fixed
public `Download/` root and uses only the validated final filename segment.
Absolute paths, backslashes, empty segments, `.` and `..` are rejected. Android
inserts each file with `IS_PENDING=1`, checks its byte count and SHA-256, and
publishes it with `IS_PENDING=0` only after verification; on failure it deletes
the pending entry. The queue rejects declared files above 64 GiB and incorrect
byte counts. Queued bytes live in a temporary desktop directory until completion,
failure, cancellation, or receiver shutdown.

## Loopback guard (UI exposure)

The management UI server rejects any request whose `Host` (and, for non-GET
requests, `Origin`) is not the local origin `http://127.0.0.1:<uiPort>` or
`http://localhost:<uiPort>`. A non-loopback request gets **HTTP 403**
("Invalid management host" / "Invalid management origin"). This is why the UI
is safe even though the receiver itself is on the LAN: the UI process is
unreachable from other devices.

Local network address checks are **defense in depth, not a firewall**. Users
should not configure port forwarding to the receiver. The management UI should be
used only on a trusted computer account: any local process with access to
`127.0.0.1` can change settings or cancel a transfer.

## Tauri ↔ sidecar boundary (desktop app)

The desktop app does **not** speak the LAN protocol directly. It runs the
receiver as a bundled child process ("the sidecar") and talks to it **only over
localhost**:

- **Launch.** The Rust backend (`desktop/src-tauri`) bundles `phonehaul-server`
  and starts it with
  `PHONEHAUL_DESKTOP_MANAGED=1 PHONEHAUL_NO_BROWSER=1 PHONEHAUL_TRANSFER_PORT=0`
  (random port) and pipes stdout/stderr.
- **Handshake.** The backend waits up to 30 s for the sidecar's
  `PHONEHAUL_READY { "uiUrl", "host", "port" }` line on stdout; the sidecar then
  exits on `SIGINT`/`SIGTERM` or stdin EOF.
- **Control.** The backend issues Tauri commands over `127.0.0.1` HTTP
  (`get_status` → `GET /api/ui`, `refresh_qr` → `POST /api/qr/refresh`,
  `set_destination` → native folder picker + `POST /api/settings`,
  `send_files` → native file picker + `POST /api/send/items`,
  `queue_dropped_paths` → drop events → `POST /api/send/items`). It uses a
  single `reqwest` client (5 s connect / 10 s request timeout).
- **Isolation.** The sidecar's **LAN port is random** and the **UI is
  loopback-only** (403 guard). The LAN HTTPS surface is not exposed by the
  desktop; the desktop never forwards user credentials to the sidecar.
- **Lifecycle.** The sidecar is killed (`SIGTERM` on Unix / `kill` on Windows)
  when the desktop app exits, so it never outlives its owner. If the exit hook
  never runs, stdin EOF ends the sidecar when the backend exclusively holds the
  pipe's write end; when that write end is held open elsewhere, the sidecar stops
  15 s after the last `heartbeat` line. That heartbeat is a supervisor-only
  channel: a browser tab at the loopback UI cannot keep the sidecar alive after
  its owner is gone.

Because the backend is a static in-process Tauri command set (no `TauriPlugin`
with arbitrary code execution) and the sidecar is a separate, killed-on-exit
process, the desktop app's ability to act is bounded to the loopback UI.
