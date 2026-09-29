# Architecture

`receiver/src/server` owns the local HTTP UI and LAN HTTPS API. `receiver/src/transfer` validates manifests and streams files to the configured destination. `receiver/src/security` owns pairing and path checks. `receiver/src/settings` persists only destination and conflict policy. `receiver/src/web` is the browser UI; it never receives file bytes.

The Android application owns QR scanning, selection, hashing, upload, and per-file MOVE deletion. It lives in `android/app`: `PairingParser` validates the QR, `Selection` and `MediaRepository` enumerate sources, `ReceiverClient` pins the TLS certificate and streams files, and `PhoneHaulViewModel` manages the transfer states. The fake sender in `integration-tests` exercises the wire protocol without an Android device. `protocol/` holds the versioned manifest schema and test vector.

The receiver's web UI is generated from `receiver/src/web/page.js` and served only on loopback; no external static files are required. `receiver/scripts/package-sea.js` bundles the receiver and dependencies as CommonJS with esbuild, then embeds it in the matching Node.js executable using SEA. User settings are written to the OS per-user configuration directory. The LAN HTTPS listener continues to bind to the private address selected by `localAddress()`.
