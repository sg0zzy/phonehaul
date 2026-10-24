# Internet transfers (development implementation)

Internet mode adds bidirectional WebRTC DataChannels alongside the existing LAN
HTTPS protocol. It requires an HTTPS signaling service and configured STUN/TURN
for dependable cross-network connectivity. No public service is deployed or
configured by this branch. Local browser tests do not establish production NAT,
firewall, VPS-capacity, Android-device, or native Windows/macOS compatibility.

## Using the client

Open **Internet transfers** in Android or the desktop app, or open the hosted
`/internet/` website. Enter the signaling service's HTTPS origin. Create a
temporary session and share its code, QR, or invitation link; the other person
joins the same service. Compare all 24 verification words in order in person or
over a trusted call, then approve on both devices. A matching room code alone
does not authenticate the peer. Each incoming file requires acceptance.

Either peer can send copies after verification. Internet mode currently uses
COPY only, including native destinations. Existing native LAN MOVE remains
available through the original LAN flow. A browser download acknowledgment never
authorizes deleting an original. No file data is uploaded to signaling or stored
by a relay. TURN carries encrypted packets when direct connectivity is unavailable.

The Internet service defaults to 1 GiB per file. Both clients enforce the
negotiated minimum limit, on direct and relayed paths alike. The Android native
sink enforces that negotiated limit within the existing native 64 GiB domain.
Desktop/browser limits and service timers are configurable below; raising them is experimental,
not a promise of multi-gigabyte browser compatibility. LAN limits are unchanged.

Keep the Internet screen/page open and in the foreground. Closing it ends the
local connection; browser transfers do not continue in the background. Sessions
can reconnect within the recovery window while their in-memory credentials and
certificate remain available. Closing/reloading the client requires a new
pairing. Interrupted files restart at byte zero; there is no partial-file resume.

## Local development

Use the pinned Node.js 24.21.0 and existing repository tools:

```sh
npm ci
npm ci --prefix receiver
npm run internet:dev
```

Open `http://127.0.0.1:8787/internet/` in two browsers for a local test. HTTP is
accepted only on localhost clients; Internet clients require HTTPS. The development
service binds loopback and has no STUN/TURN defaults, so this command alone does
not make it reachable across networks. The receiver's loopback client uses the
same protocol and writes through its configured native destination.

Export the static browser client without deploying it:

```sh
npm run build:internet
```

Serve `dist/internet-client` as the website root, with `/internet/` below it. The
export contains a public `internet/config` JSON file; serve that path without an
HTML fallback. Configure the signaling origin through `PHONEHAUL_SIGNAL_URL`
when exporting, or enter it in the client. Source assets are bundled with the
existing esbuild, embedded in receiver/SEA builds, and generated into ignored
Android build assets. Android builds now also require receiver npm dependencies
and Node 24; `PHONEHAUL_NODE` can select the absolute Node executable.

## Configuration and infrastructure

Environment variables are read by `receiver/src/internet/main.js`. These defaults
are development settings, not a capacity recommendation for the existing VPS.

| Variable | Default / meaning |
| --- | --- |
| `PHONEHAUL_SIGNAL_HOST` | `127.0.0.1`; keep behind a trusted HTTPS reverse proxy |
| `PHONEHAUL_SIGNAL_PORT` | `8787` |
| `PHONEHAUL_SIGNAL_URL` | No preset public service; optional native-client/export default |
| `PHONEHAUL_ALLOWED_ORIGINS` | Comma-separated public client origins; loopback clients and the packaged Android origin are also allowed |
| `PHONEHAUL_INTERNET_MAX_FILE_BYTES` | `1073741824`; positive integer up to 64 GiB; does not alter LAN validation |
| `PHONEHAUL_INVITATION_MS` | `900000` (15 minutes) |
| `PHONEHAUL_RECOVERY_MS` | `600000` (10 minutes) after disconnection |
| `PHONEHAUL_MAX_ROOMS` | `100`, bounded in-memory rooms |
| `PHONEHAUL_REQUESTS_PER_MINUTE` | `180` per socket-source IP; includes signaling polls |
| `PHONEHAUL_STUN_URLS` | No default; comma-separated `stun:` URLs |
| `PHONEHAUL_TURN_URLS` | No default; comma-separated `turn:` / `turns:` URLs |
| `PHONEHAUL_TURN_SECRET` | Server-only coturn REST authentication secret; never put it in a client or URL |
| `PHONEHAUL_TURN_MAX_SESSIONS` | `0`: no relay admission until explicitly configured |
| `PHONEHAUL_TURN_CREDENTIAL_SECONDS` | `3600`; credential lifetime, positive integer up to 86400 |

Invitation expiry does not terminate an established session. Signaling polls
maintain a session lease; a missing peer is retained for the recovery interval
plus a 30-second detection grace. Explicitly disconnected peers use the recovery
interval directly. If signaling loses its room while an approved DataChannel is
still active, that connection continues; re-pairing is needed after it closes.

The service keeps bounded SDP/message queues and bearer credentials in memory,
with no database or file-upload route. Restarting it loses room recovery state.
Polling is HTTPS JSON, not WebSocket; this avoids an additional server dependency.
It never trusts `X-Forwarded-For`: behind a proxy, the socket-source rate budget
is shared. Set an appropriate aggregate budget and per-client limits at the
trusted reverse proxy before public use. Proxy logs must exclude authorization
headers and message bodies. Public HTML/asset requests also need proxy limits.

TURN admission is separate from coturn's actual packet/allocation enforcement.
Configure `user-quota`, `total-quota`, `max-bps`, and `bps-capacity` explicitly in
coturn after checking the hosting plan. A room may require allocations for both
endpoints. Issued credentials reserve signaling admission until their expiry,
even after a room closes; this conservatively bounds grants already issued.
The service issues expiring HMAC credentials and never ships the shared secret.
Do not run an unauthenticated relay or enable loopback/private-network relay
destinations in production. Configure relay ports, firewall rules, TLS, and
destination restrictions; TURN/TLS is not an HTTP reverse-proxy route.

For one file of size F through one relay, budget roughly F ingress plus F
egress, excluding overhead. No VPS bandwidth allowance, pricing, public-IP/port
availability, or production concurrency has been verified. Those facts must be
inventoried before production defaults or deployment. When relay admission is
full, direct connectivity can still work; otherwise the client reports failure
and preserves originals. There is no server-storage fallback.

GitHub Pages can serve static files but cannot run signaling or TURN. The
current client expects origin-root `/internet/`, so a dedicated app origin is
the simplest hosting arrangement. Publishing a client/service or changing the
adopted distribution matrix requires separate authorization.

## Authentication and trust

The browser computes SHA-256 over a versioned, role-ordered transcript containing
the room ID and both DTLS certificate fingerprints, then encodes the complete
256-bit digest as 24 BIP39 words. There is no truncated short-SAS exchange, custom
key agreement, or PAKE. DTLS supplies transport encryption; independent comparison
authenticates its endpoints. Substituting either certificate or the room changes
the phrase. Both peers must approve before file messages are accepted.

Recovery reuses the local ephemeral certificate and pins the verified transcript.
A changed identity is rejected rather than silently approved. The room code is
only a locator; per-role random 256-bit bearer credentials stay in memory and
authorization headers. Invitation fragments contain a locator/service origin,
not bearer credentials, and are removed from the page's history entry after
parsing. Never log credentials or raw SDP/candidates.

This protects against an independently malicious signaling service while the
endpoint client remains trusted. A host able to replace the browser JavaScript
can compromise it; separate static hosting from signaling if that distinction
matters. Peer and infrastructure IP addresses and timing/volume remain observable.
There is no anonymity guarantee.

Browser-created invitation links stay on the current client origin. Native-created
links use the service's hosted client; when using an independently trusted static
site, share the code and open that site directly instead. A signaling service
must not be treated as untrusted while also trusting it to supply browser code.

Incremental SHA-256 uses pinned `@noble/hashes`; phrase encoding uses pinned
`@scure/bip39`. Both are MIT-licensed, narrowly scoped packages; the browser
bundle includes their license comments. They add no accounts, network calls, or
telemetry. Review their upstream security/maintenance status when updating them.

## Filesystem and platform boundaries

The reliable ordered DataChannel uses 16 KiB chunks, a 256 KiB receiver-credit
window, bounded message queues, sender-buffer backpressure, and SHA-256 plus
byte-count verification. A file starts only after explicit acceptance. Integrity,
I/O, timeout, or cancellation failures abort the sink and retain the source.

Browser receiving uses a same-origin service worker and MessageChannel pull
bridge into a native download response. It does not build a whole-file Blob,
use arbitrary filesystem access, or require File System Access APIs. Worker
failure, download cancellation, low disk, or page closure can fail a transfer.
`download-handed-off` means verified bytes reached that bridge, not a durable
filesystem commit. Final browser download behavior remains under browser control.

The desktop uses a system browser for WebRTC and its existing loopback sidecar
for native writes. Webview bridging would require broader CSP/network access and
platform qualification; a native WebRTC stack adds a substantial dependency.
The chosen browser/sidecar bridge reuses `TransferReceiver` and avoids both costs.
Windows/macOS system-browser integration remains unverified on this Linux host.

Android packages the same client in a restricted platform WebView, with native
file selection and a bounded MediaStore sink. Only fixed local assets load with
the JavaScript bridge; remote top-level navigation is blocked. No WebRTC AAR or
additional Android library was added. Pending Downloads are published only after
size/hash verification and removed on handled failure or activity destruction.
Foreground Internet transfer/device testing remains necessary; background
continuation and app/process-restart recovery are not promised.

## Verification

```sh
npm run check
npx playwright install firefox
npm run test:internet
```

Browser tests default to `/usr/bin/chromium` on this Linux host; set
`PHONEHAUL_CHROMIUM` for another Chromium executable. Firefox uses Playwright's
downloaded browser. `PLAYWRIGHT_BROWSERS_PATH` can isolate downloaded binaries.
Matching browser installation/paths on Windows/macOS are unverified here.

The suite checks both directions, zero-byte files, native desktop commits,
Chromium/Firefox interoperability, and pinned-identity reconnection. Node tests
cover expiry, authorization, rate limits, size limits, corruption, native commit,
cancellation, and TURN credentials. Set `PHONEHAUL_TEST_TURN_URL` and a test-only
`PHONEHAUL_TEST_TURN_SECRET` to exercise forced relay and inspect selected relay
candidates; that test is skipped without explicit test infrastructure.

```sh
PHONEHAUL_LARGE_TEST_BYTES=1073741824 npm run test:internet -- --grep "large browser"
```

Linux validation on 2026-10-24: Chromium 156.0.8078.47 and Firefox 157.0 each completed a 1 GiB
streaming copy with matching SHA-256. Chromium aggregate browser-process RSS
grew by about 283 MiB during that run; summed RSS includes shared pages and is
not a unique-physical-memory measurement. Firefox process memory was not measured.
Local forced coturn and mixed-browser tests passed. These results do not prove
all-device memory safety, production NAT traversal, TURN/TLS reachability, or
transfer continuation after browser/Android process termination.
