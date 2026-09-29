# Transfer protocol v1

The QR encodes `phonehaul://pair?v=1&h=<private IPv4>&p=<HTTPS port>&s=<base64url 256-bit token>&f=<lowercase SHA-256 certificate fingerprint>`. The certificate is generated each receiver launch. A sender must reject nonlocal destinations and verify the TLS peer certificate against `f` before sending any application data.

All transfer requests use `Authorization: Bearer <token>`. The unused pairing token expires after five minutes; the receiver then generates a new QR and updates the local browser UI. `POST /api/session/connect` associates it with the running receiver session. Restart invalidates it.

`POST /api/transfers` accepts `{protocol:1,operation:"copy"|"move",items:[...]}`. File items have `id`, `type:"file"`, `relativePath`, integer `size`, and SHA-256; directory items have `id`, `type:"directory"`, and `relativePath`. IDs and paths must be unique, and paths are slash-separated relative paths. Existing directories are reused. If a file at the destination has the same size and SHA-256, its create response disposition is `already_present`. Otherwise a file is `queued`, or `skipped` under the configured skip policy. The response includes a generated `transferId`, progress fields, and each item's disposition.

Upload only files whose disposition is `queued`, using `PUT /api/transfers/:transferId/files/:id`, `Content-Length`, and `X-PhoneHaul-SHA256`. Exactly one upload may be active. The receiver streams to a partial file, checks size and SHA-256, syncs and commits the file, then responds `{status:"committed",size,sha256,destination}`. A `skipped` item is never a commit and its MOVE source remains. `already_present` means the receiver verified the existing destination bytes against the sender's manifest hash; MOVE may safely remove that duplicate source after receiving this disposition. Android leaves source directories in place. Deletion failure does not invalidate the destination file.

`GET /api/transfers/:id` returns progress. `POST /api/transfers/:id/finish` ends a batch; `POST /api/transfers/:id/cancel` stops the current upload. A new batch may start on the same connected session after the previous batch ends. The local browser uses `GET /api/events` for Server-Sent Events.

There is no resume in v1. Failed and cancelled uploads leave their Android sources intact. Partial files are removed on upload failure; unexpected process termination may leave them for explicit cleanup through the local UI.
