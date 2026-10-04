# AGENTS.md

Durable rules for AI-assisted and human contributors. Read this before editing.

## Gate (before every commit)

Run the full gate and get it to pass:

```sh
npm run check          # = check:format && lint && test && smoke
```

- **format** — Prettier auto-fixes; `npm run format` applies it. Do not hand-format.
- **lint** — ESLint over `receiver/`, `desktop/`, `integration-tests/`.
- **test** — receiver unit tests.
- **smoke** — `integration-tests/smoke.js` end-to-end.

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

- **Unit tests**: `receiver/src/**/*.test.js` (Jest).
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
- Update the Phase checkboxes in `docs/REFACTORING_andre.md` as work lands,
  then commit.

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
