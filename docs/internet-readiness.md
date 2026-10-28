# STUN-only Internet readiness audit

Audit date: **2026-10-27**. Branch `feature/internet-p2p`, base HEAD
`15700739878de2718a1f7b5e101ff5f93039c266` plus the uncommitted audit changes.
Initial working tree was clean. The initial audit made no branch switch, version bump,
commit, tag, push, release or production change. The owner subsequently authorized
OVH deployment on the same date; the addendum below supersedes the initial
deployment assessment. No Pboard process/configuration, DNS, commit/tag/push or
product release change was made.
Pinned development standards commit
`90bf955cbeb0fdf0a711e255b182f864807b3784` was retrieved into a fresh temporary
checkout, Git identity checked, and all 21 inventory digests verified. Existing
release-compliance MUST gaps in the adoption record remain open; this audit does
not establish release compliance.

## Authorized deployment addendum — 2026-10-27

The owner subsequently asked to activate the service on OVH. Deployment and
infrastructure validation are now **READY WITH LIMITATIONS**, rather than blocked:
[actual deployment record](internet-deployment.md). Separate signaling on loopback
8788, STUN-only IPv4 UDP 3478, TLS/renewal, service users, journal namespaces,
rate/resource limits and external STUN Binding/negative TURN checks passed.
Pboard was preserved. No VPS IPv6 was configured.

The new bundled signaling entry was smoke-tested before deployment. Public HTTPS
polling/CORS, full verification phrases, independent approvals, two 512 KiB copies
with hashes and native desktop commit passed between local Chromium and hosted
Firefox. Both gathered srflx but selected host ↔ host UDP on the same workstation.
This **does not close any real two-network/physical Android matrix row**. The
minimum remaining experiment is physical Android ↔ desktop over different
Internet uplinks, using the now-live service and observing non-relay transport.

Service snapshot `20261027T161000Z-19f75c5b8a6f` contains bundle SHA-256
`19f75c5b8a6f006d0d3b3bfd6f486dcce820de14f959f17c24da23e22ad184e5`, source hashes
and dirty-worktree provenance. The server's `vps-maint/PHONEHAUL.md` records
configuration, operational evidence and rollback. No product version bump or
standing deployment automation was introduced.

## A. Readiness assessment

**Is the current branch ready for an Android-to-desktop file transfer across two
Internet networks using self-hosted signaling and STUN only?**

**Not yet as a verified production deployment.** The direct transport is
implemented and local browser/native receiving tests work, but the Android WebView/device path and genuine two-network NAT traversal have
not been qualified. VPS activation and targeted infrastructure checks are now complete. This branch and the deployed service are suitable for a controlled first
real-network experiment on supported foreground clients. STUN-only cannot promise connectivity
through every NAT/firewall. Lack of direct connectivity must fail without relay
or source deletion.

| Area | Status | Evidence and limits |
| --- | --- | --- |
| Signaling server | READY WITH LIMITATIONS | Bounded authenticated polling API, room lifecycle/isolation and public TLS/proxy checks; sustained load/drain qualification remains open |
| Android | NOT VERIFIED | Shared assets compile; unit/lint/ktlint pass; no physical Android/WebView transfer performed |
| Desktop | READY WITH LIMITATIONS | Linux browser → native receiver commit and browser outbound selection work; actual packaged GUI launch and Windows/macOS integration not exercised in this audit |
| WebRTC/STUN | READY WITH LIMITATIONS | ICE/DataChannels and STUN-only enforcement implemented; selected-pair diagnostics locally tested; External IPv4 STUN/UDP verified after deployment; genuine peer NAT traversal and IPv6 remain unverified |
| Authentication | READY WITH LIMITATIONS | Transcript binding and explicit approval tested; requires trusted client code and complete independent phrase comparison; no persistent account/device identity or independent cryptographic review |
| Transfer integrity | READY WITH LIMITATIONS | Incremental SHA-256/length checks, cancellation/native cleanup tests, two fresh 1 GiB browser copies; Android commit durability/process-death behavior unverified |
| Deployment | READY WITH LIMITATIONS | Activated after explicit authorization; public TLS/API/STUN, renewal and isolation checks passed; no sustained load or IPv6 qualification |
| Cross-network testing | NOT VERIFIED | Every genuine Internet/device matrix row below remains unperformed |

## Actual end-to-end architecture

Sources are linked to repository `main` for Pages compatibility; the precise
reviewed source is the branch/HEAD plus working changes stated above.

- [main.js](https://github.com/sg0zzy/phonehaul/blob/main/receiver/src/internet/main.js)
  starts a separate Node HTTP signaling process. `signaling.js` serves
  `/internet/` and `/v1/rooms`, `/v1/join`, per-room `/events`, `/signal`,
  `/approve`, `/ice` and DELETE. Public TLS belongs to the reverse proxy.
  **HTTPS JSON polling every two seconds; no WebSocket server or path.**
- [client.js](https://github.com/sg0zzy/phonehaul/blob/main/receiver/src/internet/web/client.js)
  is the single shared WebRTC implementation. The owner creates a reliable,
  ordered `phonehaul-v1` DataChannel; the guest accepts it. Owner offers and
  guest answers contain gathered candidates. `gathered()` waits for completion,
  at most 25 seconds, then forwards full SDP. There is **no trickle ICE**, no
  separate candidate message and no pre-remote-description candidate queue.
  End-of-gathering is represented by the complete SDP exchange. Browser ICE
  handles host/srflx/prflx candidates, address families and UDP NAT traversal.
- [InternetActivity.kt](https://github.com/sg0zzy/phonehaul/blob/main/android/app/src/main/java/it/stefanogozzi/phonehaul/InternetActivity.kt)
  loads packaged assets from `https://appassets.androidplatform.net/internet/`.
  Android's installed **WebView** implements WebRTC; there is no native WebRTC
  AAR. A restricted JS bridge writes bounded chunks to pending MediaStore
  Downloads. A platform document picker supplies outbound files. The shared QR
  scanner routes HTTPS `/internet/` invitations into this activity.
- [Tauri open_internet](https://github.com/sg0zzy/phonehaul/blob/main/desktop/src-tauri/src/main.rs)
  invokes the existing sidecar's `/api/internet/open`, which opens a **system
  browser**, not WebRTC inside Tauri or Rust. The loopback-served client writes
  through `/api/internet/inbox` into `InternetInbox` → `TransferReceiver`.
  Outbound Internet selection uses the browser file picker/drop area.
- [transfer.js](https://github.com/sg0zzy/phonehaul/blob/main/receiver/src/internet/transfer.js)
  carries file offers, approvals, chunks, credit, cancellation, hashes and final
  acknowledgments on the DataChannel. Signaling carries connection metadata
  only in the legitimate application flow. File bytes do not use the VPS or
  LAN transfer HTTP endpoint. Native Internet adapter batches are COPY-only.
- Browser-only receiving uses a service-worker streaming download bridge.
  Android and desktop talk directly at the WebRTC level; desktop **depends on
  a system browser**, Android on WebView. Neither has an independent native
  peer-connection stack. They do not need a third browser peer or shared subnet.

```mermaid
sequenceDiagram
    participant A as Android packaged WebView
    participant S as Public HTTPS signaling
    participant B as Desktop system browser
    participant N as Desktop loopback sidecar
    A->>S: Join invitation; poll events
    B->>S: Create room; poll events
    B->>S: Offer with gathered ICE candidates
    S->>A: Offer
    A->>S: Answer with gathered ICE candidates
    S->>B: Answer
    Note over A,B: STUN discovers mapped addresses; ICE tests direct paths
    A->>B: DTLS encrypted DataChannel
    Note over A,B: Compare all 24 words independently; approve both
    A->>B: COPY chunks, credit, SHA-256, result
    B->>N: Native inbox on loopback only
    Note over A,B: Reverse direction uses same DataChannel
```

## ICE, platform and transfer review

**Implemented:** compatible ICE configuration fetched per authenticated room;
STUN-only default; no TURN URLs accepted at startup in that mode; client rejects
non-STUN ICE servers and relay candidates in local/remote SDP; actual selected
local/remote candidates checked using `getStats()` before approval becomes ready
and every two seconds while connected. Candidate diagnostics contain types,
protocol, ICE state and setup time, not addresses, tokens or SDP. Stats may omit
the pair on some WebViews: the display says so; source/SDP policy still applies.
There is no application relay, storage upload or exposed-LAN fallback.

`makeConnection()` bounds DataChannel setup to 60 seconds per attempt, separate
from HTTP's 25-second timeout and gathering's 25-second deadline. Failure shows:

> Direct connection unavailable. Your networks may restrict peer-to-peer connections. Try another network or use PhoneHaul on the same LAN.

**Recovery is partial:** disconnected/failed connections interrupt the file and
show explicit reconnect. Reconnect creates a fresh peer connection in the same
room, retains the certificate and verified transcript, and restarts files at
zero. No automatic network-change ICE restart, partial resume or background
continuation is promised. Repeated owner offer setup is guarded; create/join
buttons are locked during a request and stale polling generations are ignored.
A late answer after a timed-out closed connection is ignored. A reconnect with
changed fingerprints is rejected. Polling loss does not carry or stop file
bytes on an already approved open DataChannel, but lost server state prevents
later recovery. Both peers must re-pair after reload/process death.

**Permissions/TLS:** Android minSdk 30, targetSdk 36; INTERNET permission exists,
cleartext is disabled, no permissive SSL-error override was found. Internet
selection uses SAF and pending writes use MediaStore, without requesting new
broad filesystem or camera/microphone permissions. Existing camera permission
is for QR scanning; no getUserMedia is used. Local assets alone get the native
bridge; remote top-level navigation is blocked. WebView's native WebRTC support,
certificate validation and SAF-to-WebView file behavior still require a device
check. The Tauri CSP remains restricted to IPC; the system browser owns WSS/HTTPS
and secure-context rules (this implementation actually uses HTTPS, not WSS).

**Streaming:** 16 KiB chunks, 256 KiB receive credit and sender backpressure,
64-message receive queue cap, incremental hashes and negotiated 1 GiB default
file limit (configurable up to 64 GiB; not a tested maximum). Both send directions
retain originals. Native desktop uses existing conflict validation, partial-file
handling and commit. Android verifies hash/length before publishing pending
Downloads, deletes on handled errors and activity destruction, but abrupt process
kill can leave pending data; no restart cleanup journal exists. Browser result
`download-handed-off` is verified stream handoff, not proof of a durable file.
Low-space and permission failures propagate as failed transfers, not success.

**Unverified:** actual mobile memory/backpressure, two-device peer disconnect
mid-write, Android process-kill cleanup, IPv6-selected pairs and transitions.
A stalled approved sender may leave Android's pending receive until cancellation
or lifecycle cleanup; Android has no independent native receive inactivity timer.
The sender does bound credit/result waits to 120 seconds. Desktop native inbox
has its own 120-second inactivity cleanup.

**LAN preservation:** no LAN endpoint, defaults, status vocabulary, conflict
policy, MOVE deletion logic or loopback guard was modified. Full receiver tests
and LAN smoke passed. Desktop startup still calls `localAddress()` requiring a
private IPv4 interface; Internet DataChannel routing does not require a shared
subnet, but a public/IPv6-only desktop cannot start the current sidecar normally.

## Signaling and authentication review

Implemented limits and checks in `Rooms` / `startSignaling`:

| Concern | Actual handling / residual trust |
| --- | --- |
| Session guessing/enumeration | 128-bit random room IDs, 12-digit random code, 256-bit per-role bearer tokens; rate-limited joining; no room-list endpoint. Codes are invitation locators and weaker than full-ID QR links |
| Invitation replay/replacement | 15-minute default expiry; exactly one guest; established room cannot rejoin; no guest replacement; DELETE removes room/code |
| Cross-session access | Token compared only within requested room using timing-safe comparison; tests reject foreign-room credentials |
| Authentication/approval | Server authenticates role tokens for poll/signal/ICE/approval; actual transfer approval is exchanged inside DTLS and enforced by each client. Server `/approve` is a lifecycle lease marker, not the security authority |
| SDP forwarding | Owner offer / guest answer role checks; bounded vocabulary; max 100,000 SDP characters; queue length 16; JSON max 110,000 bytes. No binary/file-upload route |
| Resource control | Default 100 rooms, 180 requests/min/IP, 10,000 IP buckets, periodic stale-room sweep, 24-hour absolute room lifetime, 256 sockets, request/header deadlines |
| Origin | Allowed public origins plus loopback and packaged Android; absent Origin permitted for native clients. Origin is a browser defense, not proof of identity; anonymous creation/join remains intentionally public |
| Proxy source | Explicit trusted-loopback option uses validated, overwritten X-Real-IP; otherwise all proxy clients share the socket-source budget. Proxy must prevent external bypass/spoofing |
| Disconnect/shutdown | Recovery grace, expiring credentials/room state in memory; SIGTERM closes HTTP, clears sweep. No durable room recovery or production drain/load test |
| Logs | App normally emits startup only. No default SDP/token logging. Proxy access logs and packet debugging require redaction/retention controls |

The API only forwards a bounded signaling vocabulary, but does not fully parse
SDP grammar. A malicious bearer-holder could encode small arbitrary data in SDP;
no public metadata relay can categorically prevent covert payloads. This is not
an application file-transfer relay or fallback. Keep proxy limits and inspect
abuse metrics; stricter SDP structure validation is optional hardening, not a
claim that untrusted SDP is intrinsically harmless. No forwarded SDP is executed
by Node. Availability attacks remain possible against any public anonymous
pairing service; no anti-abuse account or distributed mitigation was added.

`identity.js:verificationPhrase()` hashes a domain-separated, role-ordered
transcript of room ID and both SHA-256 certificate fingerprints, represented as
24 BIP39 words. The browser validates DTLS against the exchanged fingerprints.
An active signaler substituting certificates produces different phrases; with
trusted client implementations and an independent complete comparison, the
users detect that substitution. Approval cannot be supplied via signaling to
unlock the client's transfer gate. Certificates are ephemeral and pinned only
for the in-memory session; this is session endpoint verification, not a long-term
identity system. No independent formal cryptographic audit was performed.

**Trust assumptions:** both clients and their runtimes must be trusted; users
must actually compare all words over a channel independent of signaling. A
malicious server hosting the browser JavaScript can replace the verifier and
lie about the phrase. Use packaged Android/loopback desktop code or an independently
trusted client host when treating signaling as untrusted. A room code, QR code,
HTTPS or DTLS alone does not authenticate the intended person. WebRTC encrypts
file traffic end-to-end after establishing the DTLS endpoints; the user comparison
is what authenticates those endpoints under these assumptions.

## B. Findings and blockers

| Severity | Exact file/function | Evidence / consequence | Fix or next action | State |
| --- | --- | --- | --- | --- |
| High | `receiver/src/internet/signaling.js:startSignaling`, `web/client.js:makeConnection` | TURN could be admitted by URL/secret/quota configuration without an explicit mode; no selected-pair enforcement | Default `stun-only`, reject TURN configuration, relay SDP and selected relay types; hide relay test UI | FIXED; tests cover enforcement; historical TURN code retained behind `turn-enabled` |
| High | `signaling.js:startSignaling` rate bucket | All public clients share proxy loopback IP and exhaust the same budget | Explicit loopback proxy trust, validated X-Real-IP, proxy overwrite and separate counters | FIXED in app/test and deployed proxy; separate source counters/overwrite verified |
| Medium | `web/client.js:makeConnection`, `poll` | Gathering had timeout but established setup could wait indefinitely; a late answer could overwrite the failure diagnostic | 60-second connection deadline and clear direct-only failure; ignore answers to closed connections | FIXED; simulated browser failure test |
| Medium | `rooms.js:Rooms.sweep` | Polling peers could retain signaling state indefinitely | Configurable absolute room lifetime, default 24 hours | FIXED; expiration/isolation tests |
| Medium | `web/client.js:begin`, `poll`, `offer` | Concurrent creates or stale poll generations could orphan/overwrite sessions or process old events | Guard requests, ignore stale generations, restart current polling, serialize owner offer setup | FIXED; local reconnect verified; no exhaustive concurrent UI fault campaign |
| High operational | `main.js` and actual proxy/backend | Initial audit lacked VPS inventory and endpoint | Inventory completed; signaling/TLS/STUN activated with explicit owner authorization; public checks passed | RESOLVED for initial deployment; sustained load/IPv6 remain unverified |
| High validation | `InternetActivity.kt:onCreate`, `Inbox.call` | No real Android WebView/SAF/MediaStore ↔ desktop experiment | Install reviewed build on test device; QR/approval, both directions and independent disk hashes | OPEN; blocks production readiness claim |
| High validation | `web/client.js:makeConnection` on real networks | Local host candidates do not establish srflx/prflx NAT traversal, CGNAT or IPv6 behavior | Run full matrix and capture sanitized selected-pair diagnostics | OPEN; blocks production readiness claim |
| Medium conditional | `receiver/src/security/pairing.js:localAddress` called at sidecar startup | Throws with no private IPv4 address, even if Internet IPv6 is possible | For first test use desktop with private IPv4; design a separate Internet-only startup only if needed | OPEN; blocks public/IPv6-only desktop startup |
| Medium limitation | `InternetActivity.kt:Inbox` cleanup/lifecycle | Process death lacks explicit recovery cleanup; no native incoming idle timeout | Keep foreground, cancel interrupted receives, test abrupt kill; add durable cleanup/inactivity behavior before promising resilience | OPEN; not a blocker for a supervised first test |
| Medium maintenance | `desktop/package-lock.json` Vite dev tooling | `npm audit --prefix desktop` reports one high-severity vulnerable direct dependency | Review Vite advisory updates separately; do not expose dev server as signaling | OPEN; unrelated dependency update intentionally not bundled |

No missing native WebRTC implementation was invented or added. The browser-based
architecture is deliberate. No critical code blocker was found for a supervised
first test on supported devices with private-IPv4 desktop startup; the open
infrastructure/device validation steps remain necessary.

## C. Deployment plan

Follow the [reproducible OVH runbook](internet-deployment.md): verify existing
ports/proxy/certificates and Pboard health; reserve a free loopback listener;
use an isolated user/systemd unit and separate configuration/log identifiers;
add only the new hostname's TLS/Host backend route on existing 443; configure
self-hosted STUN-only Coturn on a verified free UDP port; validate direct ICE and
TURN Allocate rejection externally. There is no WSS path to configure.

Deployment is now active. Minimum remaining work is a real foreground Android-to-desktop test over mobile data and
home broadband with full phrase comparison, both COPY directions, external
SHA-256 comparison, and selected candidate types showing no relay. Do not call
this production-qualified until failure/network-change cases are also recorded.

## D. Validation

Commands below were executed locally on Linux with Node 24.21.0 selected from
`/home/ste2/.nvm/versions/node/v24.21.0/bin`. Logs are temporary local evidence,
not published artifacts. Gradle can reuse up-to-date tasks; successful checks
do not imply an installed device build. No macOS/Windows command was run.

| Command / check | Result |
| --- | --- |
| Pinned clone/checkout, rev-parse, `sha256sum -c standards.sha256` | PASS, 21 inventory entries |
| `npm ci`, `npm ci --prefix receiver`, `npm ci --prefix desktop` | PASS; root/receiver audits clean; desktop reports Vite finding above |
| `npm run format` | PASS, repository Prettier applied |
| `npm run check` | PASS before documentation additions: format/lint/docs, 10 standards tests, 109 receiver tests, LAN smoke. Final rerun recorded below after all documentation edits |
| `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test` in `desktop/src-tauri` | PASS; 5 Rust tests |
| `./gradlew :app:testDebugUnitTest :app:lintDebug :app:ktlintCheck` in `android` | PASS; packaged Internet assets generated; no APK/device claim |
| `npx playwright install firefox` | PASS; first browser run had missing Firefox binary (8 launch failures), then resolved |
| `npm run test:internet` after Firefox install | PASS, initial complete rerun 11 passed / 3 skipped (two unconfigured TURN cases and duplicated mixed-browser case); includes both engines, native commit and reconnect |
| `PHONEHAUL_LARGE_TEST_BYTES=1073741824 npm run test:internet -- --grep 'large browser'` | PASS, 2 tests; Chromium ~47.5s, Firefox ~50.7s; both hashes match. Chromium summed-process RSS growth 259,264,512 bytes; shared pages may be counted repeatedly |
| Focused no-connectivity/outage browser scenarios | Simulated: no usable ICE candidates with shortened deadline, and HTTP signaling returning 503 after approval. Final complete rerun: PASS, 15 passed / 3 skipped across Chromium and Firefox; includes both simulated scenarios |
| `npm audit --prefix desktop --json` | Existing Vite advisory finding; no dependency/lockfile changes |
| Public STUN, negative TURN Allocate, HAProxy validation, systemd unit verification on VPS | PASS during authorized activation; external IPv4 Binding succeeds, Allocate ignored, independent services healthy |
| Physical Android, packaged desktop GUI, real two-network/IPv6 tests | NOT RUN |

Final commands after code/documentation completion: `npm run check`,
`git diff --check`, and the browser suite. Final evidence is recorded at the end of this report.
The failure scenario initially exposed a late-answer diagnostic overwrite, which
was fixed. Its first Firefox attempt also needed isolated browser contexts to
avoid inactive-tab timer delays; both engines then passed.

Local browser tests establish DataChannel behavior, not Internet NAT traversal.
TURN tests remain intentionally skipped without test-only infrastructure; old
forced-TURN reports are historical and were not independently reproduced here.

## Manual network test matrix

**All rows NOT VERIFIED.** For every row record date, exact reviewed source/build,
Android model/OS/WebView version, desktop OS/browser version, network family and
coarse NAT context, signaling/STUN configuration, ICE states, selected local and
remote types/protocol, setup seconds, both-direction transfer outcomes, file
sizes/hashes, cancellations and cleanup. Redact tokens, invitation locators,
SDP and candidate addresses. Private network details need not enter public logs.

| Scenario | Expected behavior / required evidence |
| --- | --- |
| Android mobile data ↔ desktop home broadband | Direct connection if NAT permits; two independent approvals; both directions hash-match; host/srflx/prflx selected, no relay; 0-byte/small/1 GiB where device permits |
| Android Wi-Fi A ↔ desktop Wi-Fi B | Same; ensure physically different uplinks, not just two SSIDs behind one router |
| Both behind CGNAT | Success possible, not guaranteed; either direct selected pair with integrity or bounded clear direct-unavailable failure; never infer TURN is required solely from failure |
| IPv6-capable peers | Observe actual IPv6 selected pair privately in stats and record only redacted family/types; test IPv4 fallback separately; desktop must still have private IPv4 for sidecar startup |
| Wi-Fi → mobile during file | Detect interruption, preserve source, no false success; cancel/clean pending file, explicit reconnect within lease pins same identity; retry at zero and compare hash |
| UDP-restricted network | Direct may fail or engine may find another direct path; bounded error if unavailable; no relay candidate, no HTTP upload fallback, originals intact |
| Signaling interrupted during active transfer | Established direct copy can finish; visible signaling error; if connection also fails, recovery may require re-pairing; restarting service must not affect Pboard |
| Peer disconnect mid-transfer | No successful result for incomplete file; sender wait bounded; native temporary file cleanup or documented Android pending-file limitation; reconnect reuses identity and retries at zero |

Also verify expiry/replay, wrong phrase/rejection, unmatched approval, unauthorized
room access, proxy-spoofed headers, cancellation while awaiting acceptance,
receiver low space, browser download cancellation and service restart. Observe
STUN-only config and selected-pair types after every reconnect. Independently
retest LAN COPY/MOVE and loopback HTTP 403 on the installed clients.

## Final local evidence

- Full Node gate: PASS; formatting, ESLint, 11-page documentation links,
  10 standards tests, 109 receiver tests and LAN smoke.
- Complete browser suite: PASS; 15 passed, 3 skipped (unconfigured TURN twice,
  duplicated mixed-browser case once). Both simulated failure/outage scenarios pass.
- Additional large-file suite: PASS, two 1 GiB files with matching hashes.
- Rust and Android checks: PASS as detailed above.
- `git diff --check`: PASS.

Temporary evidence files: `/tmp/phonehaul-audit-gate.log`,
`/tmp/phonehaul-audit-browser-complete.log`, `/tmp/phonehaul-audit-large.log`,
`/tmp/phonehaul-audit-android.log`. They contain local test output only; do not
use their loopback/LAN sessions as evidence of production reachability.

Subsequent deployment evidence: `npm run build:signaling`, isolated bundle smoke,
full Node gate and `node integration-tests/internet-public.js` passed. External
Binding/negative Allocate, public TLS/config, scoped firewall rules, isolated unit
restarts, PhoneHaul-only certificate renewal dry-run, Pboard health/WS regression
and mate/Mario regression passed. Infrastructure details are in the deployment
record; physical-device and genuine Internet-pair qualification remain open.
