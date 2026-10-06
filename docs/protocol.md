# Transfer protocol v1

The QR encodes
`phonehaul://pair?v=1&h=<private IPv4>&p=<HTTPS port>&s=<base64url 256-bit token>&f=<lowercase SHA-256 certificate fingerprint>`.
The certificate is generated each receiver launch. A sender must reject nonlocal
destinations and verify the TLS peer certificate against `f` before sending any
application data.

All transfer requests use `Authorization: Bearer <token>`. The unused pairing
token expires after five minutes; the receiver then generates a new QR and
updates the local browser UI. `POST /api/session/connect` associates it with
the running receiver session. Restart invalidates it. A connected session also
ends when a phone that declared `send-to-phone` stays quiet for 15 s, which
generates a new QR: pairing is either connected or not connected, and the QR is
shown whenever it is not. Receivers supporting per-file streaming advertise
`incremental-transfer` in the connection capabilities; the current Android app
requires that capability.

## Phone → Computer transfers

`POST /api/transfers` accepts `{ protocol: 1, operation: "copy"|"move",
items: [...] }`. File items have `id`, `type: "file"`, `relativePath`, integer
`size`, and an optional SHA-256; directory items have `id`, `type:
"directory"`, and `relativePath`. IDs and paths must be unique, and paths are
slash-separated relative paths. Existing directories are reused. If a file
supplies a hash and the destination has the same size and SHA-256, its create
response disposition is `already_present`. Otherwise a file is `queued`, or
`skipped` under the configured skip policy. The response includes a generated
`transferId`, progress fields, and each item's disposition.
`POST /api/transfers/:id/items` appends one file item to an active transfer and
returns `{ id, status }`.

Upload only files whose disposition is `queued`, using `PUT
/api/transfers/:transferId/files/:id` and `Content-Length`. Supply
`X-PhoneHaul-SHA256` when the item included a hash. Exactly one upload may be
active. The receiver streams to a partial file and calculates SHA-256 as bytes
arrive. For an item without a manifest hash, Android calculates SHA-256 during
upload and checks the receiver's `{ size, sha256 }` response before treating
the copy as verified. The receiver checks size and any supplied hash, then
either commits the partial file or reports `already_present` if the existing
destination matches the streamed hash. A `skipped` item is never a commit and
its MOVE source remains. MOVE deletes a source only after the Android-calculated
hash matches the received one.

`GET /api/transfers/:id` returns progress. `POST /api/transfers/:id/finish`
ends a batch; `POST /api/transfers/:id/cancel` stops the current upload. A new
`POST /api/transfers` automatically cancels any unfinished batch on that paired
session before starting the new one. Files already committed stay at the
destination; an interrupted partial upload is removed. The local browser uses
`GET /api/events` for Server-Sent Events.

There is no resume in v1. Failed and cancelled uploads leave their Android
sources intact. Partial files are removed on upload failure; unexpected process
termination may leave them for explicit cleanup through the local UI.

## Computer → Android extension

The same paired HTTPS session and bearer token are used for the reverse
direction. `POST /api/session/connect` still reports protocol 1 and additionally
advertises `capabilities: ["send-to-phone"]`; newer Android clients do not
poll older receivers that lack it. New Android clients advertise
`X-PhoneHaul-Capabilities: send-to-phone` so the computer can distinguish an
older, send-only app. The browser submits each selected file to the loopback
management server with `POST /api/send/items`, a URL-encoded
`X-PhoneHaul-Relative-Path` header, and the file as the request body. The
receiver streams it to a temporary queue file, calculates SHA-256, and keeps
input order. Only one file is dispatched at a time. Android polls authenticated
`GET /api/send/next`; it returns the next item's metadata, then the file bytes
via `GET /api/send/:id/content`, then `POST /api/send/:id/complete` to
acknowledge.

The sender still provides relative paths so the receiving app can reject
malformed or traversing paths, but Android stores each file directly in its
fixed public `Downloads` directory using the final filename segment. No protocol
field can change the destination. Folder selections are expanded into file
entries and their relative structure is preserved on Android. Empty folders are
not represented. Duplicate destination names, including names from different
source folders, are renamed with the first available ` (n)` suffix before the
extension, starting at 1. This extension leaves the v1 phone → computer
manifest and upload endpoints unchanged.

## Endpoints and response bodies

### LAN (bearer token required)

| Method + path | Success | Body |
|---|---|---|
| `POST /api/session/connect` | 200 | `{ status, protocol, capabilities }` |
| `GET /api/send/next` | 200 | `{ id, relativePath, name, size, sha256, type }` or `{ item: null }` |
| `GET /api/send/:id/content` | 200 | file bytes (binary stream) |
| `POST /api/send/:id/complete` | 200 | `{ status: "acknowledged" }` |
| `POST /api/transfers` | 201 | `{ transferId, progress, items[] }` |
| `GET /api/transfers/:id` | 200 | transfer summary |
| `POST /api/transfers/:id/items` | 201 | `{ id, status }` |
| `PUT /api/transfers/:id/files/:fileId` | 200 | upload ack (see below) |
| `POST /api/transfers/:id/finish` | 200 | transfer summary |
| `POST /api/transfers/:id/cancel` | 200 | transfer summary |

`POST /api/session/connect` 200:

```json
{ "status": "connected", "protocol": 1,
  "capabilities": ["send-to-phone", "incremental-transfer"] }
```

**PUT upload ack** — `{ status, size, sha256, destination }`; when `status` is
`"skipped"` only `{ status: "skipped" }` is returned:

```json
{ "status": "committed", "size": 123456, "sha256": "ab…", "destination": "/abs/path/name" }
```

`status` is one of `committed` | `already_present` | `skipped`.

### Loopback UI (no bearer token; `127.0.0.1` only)

| Method + path | Success | Body |
|---|---|---|
| `GET /` | 200 | HTML page |
| `POST /api/heartbeat` | 204 | — |
| `GET /api/events` | 200 | SSE: `data: <uiState JSON>\n\n` |
| `GET /api/ui` | 200 | `{ settings, qr, host, port, partials, transfer, connected, sendConnected, pairingVersion, sendQueue }` |
| `POST /api/send/items` | 201 | `{ id }` |
| `DELETE /api/send/items/:id` | 200 | `{ status: "cancelled" }` |
| `POST /api/qr/refresh` | 200 | `{ status: "ready" }` |
| `POST /api/settings` | 200 | `{ destination, conflict, available }` |

`available` is the number of free bytes in the destination directory.
`connected` is the pairing state the UI renders: the session is connected and,
for a phone that declared `send-to-phone`, it has been seen within the 15 s
offline window. `sendConnected` is `connected` plus that capability. The UI
shows the QR whenever `connected` is false.

## Error codes

All errors return JSON `{ "error": "<message>", ... }`.

| Code | Condition | Body |
|---|---|---|
| `401` | Bad, expired, or offline-gap-ended pairing session | `{ error }` |
| `403` | Loopback guard — non-loopback `Host` or `Origin` on the UI | `{ error: "Invalid management host" }` / `{ error: "Invalid management origin" }` |
| `404` | Unknown route | `{ error: "Not found" }` |
| `400` | Default / malformed request; may include `available` | `{ error, available? }` |
| `507` | Not enough destination space | `{ error, available }` — `available` = free bytes |

The `507` `available` value tells the caller (and UI) how many free bytes the
destination has, so a too-large transfer can be reported precisely.
