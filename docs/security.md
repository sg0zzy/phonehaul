# Security model

The receiver binds HTTPS only to one detected private IPv4 LAN address. The management UI binds to `127.0.0.1`. The QR carries a random 256-bit capability and the SHA-256 fingerprint of an ephemeral TLS certificate. Android must verify both the private destination address and certificate fingerprint.

Manifest paths reject absolute paths, backslashes, empty segments, `.` and `..`. The receiver checks every destination parent with `lstat` to reject symlink traversal. It never uses a source-provided absolute destination path. Incoming files are written with exclusive creation as `*.phonehaul-partial` and committed only after size and hash checks. The receiver does not log session tokens or keys.

Local network address checks are defense in depth, not a firewall. Users should not configure port forwarding to the receiver. The management UI should be used only on a trusted computer account: any local process with access to `127.0.0.1` can change settings or cancel a transfer.

Computer → Android paths are checked by the desktop queue and checked again on Android. Android sets every `MediaStore.Downloads.RELATIVE_PATH` to the fixed public `Download/` root and uses only the validated final filename segment. Absolute paths, backslashes, empty segments, `.` and `..` are rejected. Android inserts each file with `IS_PENDING=1`, checks its byte count and SHA-256, and publishes it with `IS_PENDING=0` only after verification. On failure it deletes the pending entry. The queue rejects declared files above 64 GiB and incorrect byte counts. Queued bytes live in a temporary desktop directory until completion, failure, cancellation, or receiver shutdown.
