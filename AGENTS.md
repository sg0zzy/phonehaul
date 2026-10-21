# AGENTS.md

Read [DEVELOPMENT_STANDARDS.md](DEVELOPMENT_STANDARDS.md) before relevant work.
Consult and verify the applicable central documents at its exact pinned commit;
central MUST/MUST NOT requirements take precedence over conflicting local
conventions. Use the recorded retrieval/digest procedure, never a moving branch.
If no verified policy source is available, report it and avoid policy-dependent
release/deletion work; independent safe inspection and tests may continue.

The sections below are PhoneHaul implementation and safety instructions.
Version operations and recovery: [VERSIONING.md](VERSIONING.md). Build commands:
[docs/development.md](docs/development.md). Build/distribution matrices, signing
profiles, exceptions and compliance evidence: DEVELOPMENT_STANDARDS.md.
Use repository-owned tools; do not add shared executable dependencies or rewrite
working components to match a technology preference. A bump requires an explicit
request; never infer permission to commit, tag, push, release or deploy from a
build request or configuration mode. Record unmet MUST requirements as gaps.

## Gate (before every commit)

Run the full gate and get it to pass:

```sh
npm run check          # = check:format && lint && check:docs && test:standards && test && smoke
```

- **format** — Prettier auto-fixes; `npm run format` applies it. Do not hand-format.
- **lint** — ESLint over `receiver/`, `desktop/`, `integration-tests/`, `scripts/`.
- **test** — receiver unit tests.
- **smoke** — `integration-tests/smoke.js` end-to-end.
- **check:docs** — `integration-tests/check-docs-links.js` validates the
  GitHub Pages site published from `docs/` (offline: relative links, anchors,
  index coverage, repo blob links against the working tree).

Rust (desktop) and Kotlin (android) gates run in CI; for local edits use:

- Rust: `cargo fmt --check` · `cargo clippy -- -D warnings` · `cargo test` (in `desktop/src-tauri`)
- Kotlin: `./gradlew :app:testDebugUnitTest :app:lintDebug :app:ktlintCheck` (in `android/`)

## Tooling conventions

- **Node version is 24** (`.nvmrc` pins `24.21.0`). Never bump or drop.
- **Always `npm ci`**, never `npm install`, for installs. Never hand-edit
  `package-lock.json`; regenerate with `npm install` only when intentionally
  changing a dependency.
- **Locked ports / defaults** live in code; keep `docs/development.md`,
  `docs/protocol.md`, and `README.md` in sync when a default changes.
- The desktop app **bundles** the receiver as a sidecar; do not introduce a
  second way to start the server. The sidecar uses a **random** LAN port
  (`PHONEHAUL_TRANSFER_PORT=0`).

## Secrets and sensitive files

- **Never commit keystores, signing certificates, or private keys.** Release
  signing uses CI secrets / GitHub repo variables.
- Settings files (`settings.json`) are per-machine; never commit them.
- `.gitignore` is authoritative — do not commit build artifacts
  (`dist/`, `target/`, app bundles) or local state.

## Testing

- **Unit tests**: `receiver/tests/*.test.js` (node:test, run with
  `npm test`, which passes `--experimental-test-module-mocks`).
- **Smoke / end-to-end**: `integration-tests/smoke.js` — run via
  `npm run smoke`.
- **Don't test** wiring, copies, forwarding, mock echoes, source text, or
  incidental defaults — those are tautologies. Test observable behavior:
  state transitions, boundaries, precedence, and error cases (401/403/404/400/507,
  PUT ack `{status,size,sha256,destination}`).
- Keep tests deterministic and isolated; the full suite must stay green.
- A new test is only required for an uncertain edge case or when a bug was
  found; otherwise verify with the smoke run.

## Documentation

- Keep `docs/` accurate to live code: `protocol.md`, `security.md`,
  `architecture.md`, `development.md`, and [README.md](README.md).
- `README.md` is **user-facing and short**; build/release/env detail belongs
  in `docs/development.md`.
- macOS-only and Windows-only build commands are **unverified on Linux** —
  label them as such. Do not claim they were run if they were not.
- Verify every command you document by running it (on the matching platform
  when possible). Verify every relative link resolves.
- **`docs/` is the GitHub Pages source** (Settings → Pages: branch `main`,
  folder `/docs`), served at `https://sg0zzy.github.io/phonehaul/`.
  `docs/index.html` is the site root and must link every published page.
  Nothing in `docs/` may link outside `docs/` (`../README.md` 404s on the
  site); link repo files as
  `https://github.com/sg0zzy/phonehaul/blob/main/<path>`. `npm run check:docs`
  enforces this. `docs/privacy.html` is the policy URL the Android app and
  Google Play Console point at — keep it published at that exact path.
- Update the Phase checkboxes in `docs/REFACTORING_andre.md` as work lands,
  when applicable; commit only when explicitly authorized.

## Protocol and security (do not break)

- The sidecar **UI binds `127.0.0.1` only**; the loopback guard returns
  **HTTP 403** for any non-loopback host/origin ("Invalid management
  host/origin"). Do not weaken it.
- Transfer item statuses: `queued, sending, committed, skipped,
already_present, failed`. Send-queue states:
  `preparing, queued, sending, completed, failed, cancelled`. Max file
  64 GiB.
- Error codes: `401` (bad/expired session), `403` (loopback guard), `404`,
  `400` (default; may include `available`), `507` (destination too small;
  includes `available` bytes).
- Incoming (phone→computer) files are validated against `manifest.js`;
  `conflict` ∈ `rename|skip|replace` (default `rename`).
- Settings: `{ destination, conflict }`; default destination
  `<Downloads>/PhoneHaul`.
