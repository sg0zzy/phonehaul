# OVH deployment: phonehaul.cecosl.ovh

**Deployed 2026-10-27 with explicit owner authorization.** DNS already resolved
to the VPS and was not changed. This deployment activates the experimental
signaling/browser service and self-hosted STUN-only discovery; it does not
establish Android or genuine two-network transfer readiness.

The server inventory lives in the sibling `vps-maint` repository (the requested
`vps-main` directory did not exist). Its `PHONEHAUL.md` and
`deploy/phonehaul/` contain the actual operational record, installed unit/config
sources, certificate hook, firewall fragments, external STUN probe and rollback.
No secrets, keys or authentication tokens were copied into either repository.

## Verified infrastructure

| Component | Actual configuration |
| --- | --- |
| Public client | <https://phonehaul.cecosl.ovh/internet/> |
| Public API | HTTPS JSON polling on `/v1/`; **no WebSocket/WSS endpoint** |
| Health/config | <https://phonehaul.cecosl.ovh/internet/config> |
| Host | Debian 13, HAProxy 3.0.11, systemd 257; about 1.9 GiB RAM, no swap |
| DNS/IPv4 | Existing A `164.132.195.137`; no DNS change |
| IPv6 | No global VPS address observed; no AAAA/listener added; unverified |
| Signaling | `127.0.0.1:8788`, dedicated `phonehaul-signal.service` and user |
| Runtime | Verified official Node 24.21.0 Linux x64 at `/opt/phonehaul/node/bin/node` |
| STUN | Coturn 4.6.1-2, UDP `164.132.195.137:3478`; dedicated `phonehaul-stun.service` and user |
| TURN | Disabled: `stun-only`; no TURN URLs/secrets/allocations; default `coturn.service` masked |
| Shared HTTPS | Existing HAProxy TCP 443 with only PhoneHaul-specific certificate/Host/backend additions |
| Pboard | Preserved at `127.0.0.1:8787`; unit/backend/renewal hook unchanged |
| Certificate | New Let's Encrypt `phonehaul.cecosl.ovh` lineage; expires 2027-01-25 |
| Renewal | Existing standalone HTTP-01 timer; dedicated `30-phonehaul-signaling-cert.sh` |
| Logs | Independent persistent journal namespaces, each 64 MiB/seven-day caps |

There is no WebSocket Upgrade configuration to test for PhoneHaul. The existing
Pboard WSS `/ws` route remains separate and its Upgrade still returns 101.
Do not deploy the LAN receiver or expose its management/native-inbox endpoints.

## Deployed application and reproducible build

The active bundle is `/opt/phonehaul/current/phonehaul-signaling.mjs`, with
`current` pointing to the immutable directory:

```text
/opt/phonehaul/releases/20261027T161000Z-19f75c5b8a6f/
```

It contains the bundle, `deployment.json`, and `SHA256SUMS`. The bundle is
152,351 bytes with SHA-256:

```text
19f75c5b8a6f006d0d3b3bfd6f486dcce820de14f959f17c24da23e22ad184e5
```

Manifest inputs identify base commit `15700739878de2718a1f7b5e101ff5f93039c266`
plus the audited working changes. Build-input digest:
`98871eff5d8b79acf5ce8f2e9b2ebd4e8926b26bfc176c3c177fcd40c0a911f4`.
Exact build inputs/lockfiles are also archived with checksums in the root-only
server backup directory `/root/phonehaul-deployment-20261027/`.

Build locally with the existing pinned Node/tooling:

```sh
npm ci
npm ci --prefix receiver
npm run check
npm run build:signaling
```

The new repository-owned build script uses the existing esbuild and asset plugin.
It embeds the browser assets and bundles only the signaling entry point; the
output at `dist/build/phonehaul-signaling.mjs` needs Node, not npm dependencies or
runtime compilation. The bundle passed local assets/authenticated-session/STUN-only
smoke checks before upload. Exact source inputs were hashed before and after
build and the copied bytes verified remotely. No new dependency or lockfile change.

For future **authorized** updates, stage verified bytes in a new immutable
snapshot directory, record a new deployment/source manifest, save the prior
symlink target and configuration, atomically switch `current`, and restart only
`phonehaul-signal`. Never overwrite the old snapshot or compile on the VPS.
No standing automatic deployment is enabled; this was not a product release.

## Configuration and systemd

Actual `/etc/phonehaul/signaling.env`:

```ini
PHONEHAUL_SIGNAL_HOST=127.0.0.1
PHONEHAUL_SIGNAL_PORT=8788
PHONEHAUL_ALLOWED_ORIGINS=https://phonehaul.cecosl.ovh
PHONEHAUL_CONNECTIVITY_MODE=stun-only
PHONEHAUL_TRUST_LOOPBACK_PROXY=1
PHONEHAUL_STUN_URLS=stun:phonehaul.cecosl.ovh:3478
PHONEHAUL_INTERNET_MAX_FILE_BYTES=1073741824
PHONEHAUL_INVITATION_MS=900000
PHONEHAUL_RECOVERY_MS=600000
PHONEHAUL_MAX_SESSION_MS=86400000
PHONEHAUL_MAX_ROOMS=100
PHONEHAUL_REQUESTS_PER_MINUTE=180
PHONEHAUL_TURN_MAX_SESSIONS=0
```

No TURN URL/secret is set; STUN-only startup rejects TURN URLs. Desktop clients
can enter the HTTPS origin, or optionally use `PHONEHAUL_SIGNAL_URL` as their
sidecar/export default. Android can scan the invitation or enter the origin.
No public default was silently added to packaged clients.

Dedicated unprivileged users are `phonehaul-signal` and `phonehaul-stun`; config
files are root-owned, readable only by their respective service groups (0640).
Source and units are root-owned and not service-writable. Both units use
restart-on-failure, private temporary storage, strict system protection and
restricted home access. Signaling runs:

```ini
WorkingDirectory=/opt/phonehaul/current
EnvironmentFile=/etc/phonehaul/signaling.env
ExecStart=/opt/phonehaul/node/bin/node /opt/phonehaul/current/phonehaul-signaling.mjs
```

Its caps are 512 MiB, 64 tasks, 1024 descriptors; STUN uses 128 MiB, 32 tasks,
1024 descriptors and its own `/run/phonehaul-stun` runtime directory. Both are
enabled at boot. Initial idle usage was about 18 MiB signaling and 4 MiB STUN;
sustained capacity is unverified. Exact complete units are in `vps-maint`.

Journal namespace settings (`journald@phonehaul-signal.conf` and
`journald@phonehaul-stun.conf`) are:

```ini
[Journal]
Storage=persistent
SystemMaxUse=64M
MaxRetentionSec=7day
```

This leaves Pboard's journal policy untouched. Do not log tokens, invitation
locators, raw SDP or candidate addresses. HAProxy transaction logging is silenced
for PhoneHaul specifically; use health checks, counters and service lifecycle
logs instead of raw session requests.

## HAProxy and firewall

Existing frontend `https` gained the PhoneHaul certificate bundle and exact Host
route before its unknown-host rejection. Pboard/mate/Mario backend definitions
were retained. The new backend is:

```haproxy
backend phonehaul_signal
    mode http
    timeout connect 5s
    timeout queue 5s
    timeout server 30s
    stick-table type ip size 10k expire 1m store http_req_rate(1m),conn_cur
    http-request track-sc2 src
    http-request deny deny_status 429 if { sc_http_req_rate(2) gt 180 }
    http-request deny deny_status 429 if { sc_conn_cur(2) gt 16 }
    http-request set-header X-Real-IP %[src]
    http-request del-header X-Forwarded-For
    http-request set-log-level silent
    acl phonehaul_root path -i /
    acl phonehaul_path path_beg /v1/ /internet/
    http-request deny deny_status 404 unless phonehaul_root or phonehaul_path
    option httpchk GET /internet/config
    http-check expect status 200
    server phonehaul_local 127.0.0.1:8788 check maxconn 128 maxqueue 32
```

The existing frontend now also applies `http-request set-log-level silent if
host_phonehaul`. Its Host allow list includes PhoneHaul, and `use_backend
phonehaul_signal if host_phonehaul` selects only this backend. SNI chooses the
certificate; client TLS validation checks the hostname. No existing Pboard
routing or sticky counters were changed. See the
[HAProxy stick-table documentation](https://www.haproxy.com/documentation/haproxy-configuration-tutorials/proxying-essentials/custom-rules/stick-tables/)
for counter semantics. One public NAT shares a source budget; tune only after
measuring legitimate concurrency.

Only IPv4 UDP 3478 was added to UFW. A PhoneHaul-specific hashlimit rule in
`/etc/ufw/before.rules` drops traffic exceeding 60 packets/second per source,
with burst 120 and a bounded 4096-entry table, before established-flow acceptance.
It is not a distributed DDoS guarantee. No public TCP 8788, TCP 3478/5349 or TURN
allocation range was opened. The OVH control-panel firewall was not inspected or
changed; a successful external UDP test confirms the tested path works.

## STUN service and option choice

An authorized public STUN provider remains an alternative only after checking
its terms, limits, availability and metadata policy; no third-party provider
was assumed authorized. Self-hosted Coturn was chosen for this deployment to
keep discovery separate from external providers. STUN exchanges carry address
discovery, not file payload, and need no relay port range.

Actual `/etc/phonehaul/stun.conf`:

```ini
stun-only
listening-ip=164.132.195.137
listening-port=3478
no-tcp
no-tls
no-dtls
no-tcp-relay
no-cli
no-software-attribute
relay-threads=1
log-file=stdout
userdb=/run/phonehaul-stun/stun.sqlite
```

The dedicated service runs `/usr/bin/turnserver -c /etc/phonehaul/stun.conf
--pidfile=/run/phonehaul-stun/server.pid` in the foreground. The default package
unit is masked. The private disposable database avoids accessing another
service's credentials/state; no TURN users or credentials are configured.

Coturn 4.6.1 rejected the earlier proposed combination of `no-udp-relay` and
`no-tcp-relay`; this was corrected during initial activation. `stun-only`
suppresses TURN processing; `no-tcp-relay` remains an additional restriction.
The upstream [configuration reference](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)
and installed package help were consulted. Do not remove STUN-only or enable
`server-relay`, TURN users/secrets, TCP/TLS listeners or relay port ranges.

## TLS and renewal

The new lineage was issued through the existing standalone HTTP-01 workflow.
TCP 80 remains free for temporary Certbot challenges. The dedicated hook
`30-phonehaul-signaling-cert.sh` checks certificate expiry/hostname, matching
public keys, installs only the PhoneHaul bundle atomically, validates HAProxy
and reloads with rollback on failure. Private material stays on the VPS.

This command **was executed successfully** for PhoneHaul only:

```sh
ssh cecosl 'certbot renew --cert-name phonehaul.cecosl.ovh --dry-run --run-deploy-hooks --non-interactive --no-random-sleep-on-renew'
```

It contacts staging ACME and runs the real deployment hook. Existing certificate
hooks/lineages were not modified; Pboard's process was not restarted.

## Verification

Executed on the actual VPS or externally as appropriate:

```sh
ssh cecosl 'systemctl is-active phonehaul-signal phonehaul-stun pboard-signaling haproxy'
ssh cecosl 'haproxy -c -f /etc/haproxy/haproxy.cfg'
ssh cecosl 'ss -lntup'
ssh cecosl 'journalctl --namespace=phonehaul-signal -u phonehaul-signal --no-pager -n 20'
ssh cecosl 'journalctl --namespace=phonehaul-stun -u phonehaul-stun --no-pager -n 20'
curl --fail --silent --show-error https://phonehaul.cecosl.ovh/internet/config
curl --fail --silent --show-error https://pboard.cecosl.ovh/healthz
node integration-tests/internet-public.js
```

The public browser smoke requires installed Chromium/Playwright Firefox and
creates temporary public sessions. `PHONEHAUL_CHROMIUM` can select Chromium;
`PHONEHAUL_PUBLIC_TEST_ORIGIN` can select a separately authorized service.
The external UDP test in `vps-maint` is `python3 deploy/phonehaul/check-stun.py`.
It verifies Binding, ignored TURN Allocate and continued Binding availability,
without printing the mapped address. A timeout alone is not relay-policy proof;
the installed config and neighboring successful Binding tests are also checked.

Results:

- Trusted public TLS/config and public signaling work; native inbox route is 404.
- External IPv4 STUN Binding succeeds; TURN Allocate is ignored; no relay listener.
- Chromium/native desktop bridge and hosted Firefox copied 512 KiB both ways,
  with full phrase comparison, separate approval, hashes and native commit.
- Both gathered host/srflx candidates and selected host ↔ host UDP. **Both peers
  were on the same workstation; no real two-network traversal claim.**
- Independent PhoneHaul restarts leave the other unit and Pboard running.
- Pboard retains PID 636, restart count 0, health 200 and WebSocket 101; mate
  returns 302 and Mario's served content hash is unchanged.
- Certificate renewal dry-run/hook passed. No physical Android/device test or
  sustained load test was performed; IPv6 and network matrix remain open.

## Rollback

Root-only pre-change proxy/firewall snapshots and artifacts are in
`/root/phonehaul-deployment-20261027/`. For application rollback, select the saved
prior immutable PhoneHaul snapshot and restart only its unit; this initial
deployment has no earlier application snapshot.

For initial withdrawal, stop/disable only the PhoneHaul units; remove only its
Host/certificate/backend additions, validate/reload HAProxy and recheck Pboard,
mate and Mario. Restore the complete saved proxy only if it would not overwrite
subsequent unrelated changes. Remove only the PhoneHaul UDP allow/hashlimit rules,
validate/reload UFW and retain SSH access. Leave the default coturn unit masked;
do not activate an unconfigured relay. Retain artifacts and certificates for
recovery; do not delete shared TLS material or Pboard state. Rollback was prepared
but not executed. Room state cannot be recovered after a service restart.
