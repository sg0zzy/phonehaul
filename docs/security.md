# Security model

The receiver binds HTTPS only to one detected private IPv4 LAN address. The management UI binds to `127.0.0.1`. The QR carries a random 256-bit capability and the SHA-256 fingerprint of an ephemeral TLS certificate. Android must verify both the private destination address and certificate fingerprint.

Manifest paths reject absolute paths, backslashes, empty segments, `.` and `..`. The receiver checks every destination parent with `lstat` to reject symlink traversal. It never uses a source-provided absolute destination path. Incoming files are written with exclusive creation as `*.phonehaul-partial` and committed only after size and hash checks. The receiver does not log session tokens or keys.

Local network address checks are defense in depth, not a firewall. Users should not configure port forwarding to the receiver. The management UI should be used only on a trusted computer account: any local process with access to `127.0.0.1` can change settings or cancel a transfer.
