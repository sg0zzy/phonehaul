PhoneHaul review: findings and phased fix plan

## Implementation progress (2026-10-02)

This section is the restart point. Check an item only after the change and its relevant verification are complete. The review and proposed plan below remain as the original source of suggestions; its proposed approval and commit process does not itself describe work already done.

- [ ] Phase 0 — Publish the review report. The findings are present below; the proposed external document has not been published.
- [ ] Phase 1 — Hygiene and tooling baseline.
  - [x] Remove stray and generated tracked files; complete ignore rules.
  - [x] Add JS formatting, linting, and a root `check` command; format the code.
  - [ ] Keep the mechanical formatting change in its own commit and add its revision to `.git-blame-ignore-revs` when committing.
  - [x] Add Android ktlint and lint gates.
  - [x] Add Rust format, Clippy, and test gates to CI; normalize npm installs.
  - [x] Pin `.nvmrc` to Node 24.21.0 for repeatable packaged builds.
  - [ ] Verify each gate fails on an intentional violation and confirm the CI workflow runs remotely.
- [ ] Phase 2 — Security fixes.
  - [x] Reject foreign Host and Origin values on the management UI, with regression tests.
  - [x] End the managed receiver when the desktop wrapper closes its stdin.
  - [x] Redact Android pairing tokens and clarify TLS validation behavior.
  - [x] Add a shared HTTP client and sidecar startup timeout; restrict debug binary override.
  - [ ] Pin CI downloads/actions and configure GitHub environment protection for signing releases. The workflow now names `release`; repository settings still need protection.
- [ ] Phase 3 — Bugs and regression tests.
  - [x] Move the Android media deletion result into the ViewModel and handle Back during transfer.
  - [ ] Verify MOVE with a rotation during the system dialog on a device or emulator (none attached locally).
  - [x] Add certificate pinning and MOVE decision tests.
  - [ ] Investigate hard link failure on exFAT and fix if confirmed. Microsoft documents that exFAT and FAT32 do not support hard links, but a mounted upload repro and fallback test remain.
  - [x] Test the protocol vector and correct schema drift.
  - [x] Fix Rust UTF-8 streaming, with a split-byte regression test.
  - [x] Fix the AppImage ARM path and Android release version code.
- [ ] Phase 4 — Refactoring.
  - [ ] Simplify Android ViewModel state and extract transfer runner and shared helpers.
  - [ ] Split receiver route handlers and reuse `uiState()`.
  - [ ] Deduplicate Rust running state checks and build script platform mapping.
- [ ] Phase 5 — Documentation.
  - [ ] Update README and developer documentation.
  - [ ] Update protocol, security, and architecture docs; add durable contributor guidance.
  - [ ] Check documented commands and links.

Baseline on 2026-10-02: `npm --prefix receiver test` passed 33/33 using local Node 24.21.0. The new file was untracked when work began.

Work log (2026-10-02): Work is on local branch `refactor/andre-progress`, with uncommitted changes. `npm run check` passes with 36/36 receiver tests and the integration smoke test. Android `:app:assembleDebug :app:testDebugUnitTest :app:lintDebug :app:ktlintCheck` passes after generating `android/app/lint-baseline.xml`; Rust `cargo fmt --check`, `cargo clippy -- -D warnings`, and `cargo test` pass with two tests. The foreign-Host test failed with HTTP 200 before the guard and passes with HTTP 403 after it. The generated-schema and keystore ignore patterns were checked with `git check-ignore`. Root `npm ci` succeeds. CI has been edited but has not run remotely. No device or emulator was attached for the rotation test. Hard link support was checked against [Microsoft's file system comparison](https://learn.microsoft.com/en-us/windows/win32/fileio/filesystem-functionality-comparison), but no exFAT filesystem was mounted locally. No commits, pushes, PRs, or external report publication have been made.

Context
Stefano Gozzi built PhoneHaul (sg0zzy/phonehaul, 23 commits, about 5k lines) with AI help. It transfers files over the local network between an Android phone and a computer. It has three parts:

receiver/: a Node.js server. It runs an HTTPS listener on the LAN for the phone, plus a management web UI that only listens on 127.0.0.1.
android/: the Kotlin/Compose phone app.
desktop/: a Tauri 2 desktop app. It has its own frontend and runs the receiver as a background process (“sidecar”), talking to it over HTTP from Rust.
Andrea asked for a review in this order: refactoring, then best practices (testing, formatting, linting), then security, then documentation. The output is a written report for the author plus a phased fix plan, executed one phase at a time with approval between phases.

Evidence base:

I read the whole receiver myself.
Two reviewers read the Android app and the desktop/CI code in full. I spot-checked their key claims against the code.
In a scratchpad copy of the repo I ran the test suite, measured coverage, ran the smoke test, and probed the security hole described below.
Findings (the report content, condensed)
What is already good
The receiver tests pass: 33/33, with 93% line and 78% branch coverage (measured with node --test --experimental-test-coverage).
integration-tests/smoke.js passes end to end.
Android certificate pinning is correct. ReceiverClient.kt:25-36 hashes the server certificate and compares it with the fingerprint from the QR code during the TLS handshake. The token is sent only after that check passes.
Path-traversal defenses are solid on both sides: paths.js on the receiver and PhoneInbox.kt on Android, and both are tested.
Received files are written as partial files, checked against their hash, then committed.
The Tauri window’s content security policy (CSP) is set, and its permissions are minimal (core:default).
Workflow tokens are read-only (contents: read), and keystore passwords are passed safely in CI.
1. Refactoring
Receiver JavaScript is written like minified code. app.js, main.js, page.js and desktop/frontend/src/main.js pack many statements onto lines of 200+ characters. A formatter fixes most of this mechanically.
app.js puts both servers’ routing in two giant anonymous handlers. The state sent to the browser is built twice: by uiState() and again in the /api/ui route (app.js:32 and :99).
Android PhoneHaulViewModel.kt (346 lines) has five jobs: inbox polling, file selection, the media browser, the transfer, and controlling the background service. It holds about 21 independent mutable fields, which allows impossible combinations. TransferState is mostly decorative: VERIFY_FAILED and CANCELLED are never set.
Android has duplicated helpers:
the SHA-256 loop, three times (ReceiverClient.kt:85,143, PhoneInbox.kt:86);
“name (n).ext” renaming, three times (Selection.kt:31, the ViewModel at :196, PhoneInbox.kt:44).
Android dead code: SourceKind, MediaEntry.isScreenshot, UploadResult.size/sha256, clearError(), and the directory branches that can never run.
Rust main.rs:
the same lock-and-check-running block appears four times (:224,258,311,421);
a new reqwest::Client is created per call, with no timeouts;
an unused cfg and leftover features in Cargo.toml.
Splitting it into modules would help less than these.
Build scripts:
the platform-name mapping is written three times and the Linux-arch mapping four times;
dependencies are installed five different ways (npm install vs npm ci);
CI has commented-out matrix entries and if: conditions that are always true.
2. Best practices
No lint or format configuration exists in any stack: no ESLint, Prettier, ktlint/detekt, Android lint {}, clippy, .editorconfig or Dependabot.
CI coverage:
It runs receiver tests (Linux only) and Android unit tests.
It never runs cargo test, clippy or fmt. The Rust unit test at main.rs:158 never runs.
It never runs Android lint.
It never runs integration-tests/smoke.js.
Android tests are thin (3 small files). These have no tests: ReceiverClient (including pinning), the ViewModel’s MOVE delete decision, PhoneInbox.save, and Selection.
The protocol schema and test vector are referenced by nothing, and the schema has drifted: it requires sha256, while the code and protocol.md say it is optional.
Repository hygiene:
Stray empty files My and PhoneHaul (and earlier 1, 100, 500) came from a mis-quoted shell command.
android/receiver/package-lock.json is an empty lockfile, created by running npm install --prefix receiver from inside android/.
Generated files under desktop/src-tauri/gen/schemas are committed.
.gitignore misses resources/phonehaul-server.exe and *.jks / *.keystore (confirmed with git check-ignore).
Release builds:
Android versionCode = 1 is hard-coded while CI signs every v* tag.
Release builds don’t minify code.
.nvmrc = 24 floats, so the exact Node binary embedded in the shipped app changes from build to build.
Commit messages (“lic”, “try gha”, “fixed some gha”) don’t say what changed. This goes in the report only.
3. Security (ranked)
HIGH, confirmed: the loopback UI accepts cross-site requests and foreign Host headers.
CSRF (cross-site request forgery: a malicious web page makes the user’s own browser send a request to another site): a text/plain POST from Origin: https://evil.example to /api/settings returned 200. It changed the destination and set conflict to replace.
DNS rebinding (an attacker’s domain is made to resolve to 127.0.0.1, so their page can read local responses): /api/ui answers any Host header. Its response contains the QR code, which holds the pairing token and the certificate fingerprint.
Chained together: an attacker on the same Wi-Fi steals the token, points the destination at $HOME with replace, and pushes files that overwrite the user’s dotfiles.
Cause: body() parses JSON whatever the content type, and nothing checks Host or Origin (app.js:15,83-111).
MEDIUM: the Android phone accepts incoming files automatically while paired. There is no prompt and no count limit, and a .apk lands in Downloads as installable. This is a product decision; it goes in the report, not the fix plan.
MEDIUM: CI supply chain.
appimagetool and the AppImage type-2 runtime are downloaded from a moving continuous release with no checksum, and that runtime ships inside the AppImage.
Actions are pinned to floating tags, not commit SHAs.
The signing workflow can be run from any branch with no protected environment.
MEDIUM: the Tauri sidecar can be orphaned. If the desktop app crashes, the receiver keeps the LAN listener open until its next log line fails on the closed output pipe.
LOW issues:
The auto-generated toString() of Android’s Pairing data class includes the token.
The always-true HostnameVerifier has no comment explaining why that’s safe; Play’s scanner may flag it.
The SSL error message tells users to “check date/time”, which is misleading.
The PHONEHAUL_SERVER_BIN dev override is active in release builds.
The wrapper has no startup timeout for the sidecar.
4. Bugs found along the way
Android MOVE can hang on rotation. MainActivity passes ::confirmMediaDeletion into the ViewModel; its deferred result lives in an Activity field. If the screen rotates while the system delete dialog is open, the result goes to the new Activity and the old deferred never completes. The transfer then hangs with Cancel disabled, and the wake lock stays held for up to 6 hours. Plausible from reading the code (the manifest has no configChanges); not yet reproduced on a device.
Android has no BackHandler. System Back during a transfer finishes the Activity, on API 30 for example.
Likely: commits fail on exFAT/FAT32 drives. The receiver commits files with link() + unlink (receiver.js:136). These filesystems don’t support hard links, so every upload to an external drive would fail. Unverified.
Rust: main.rs:431 decodes each chunk with from_utf8_lossy separately, so a multi-byte character split across chunks gets garbled.
Build script: stage-appimage-libraries.js:12 produces a wrong ARM library path. No current build uses it.
5. Documentation
README structure: it opens with the License section above the title, has a second H1 glued on, and mixes the end-user story with the developer story.
README is wrong in places:
port 57322 and the firewall advice don’t apply to the desktop app, which uses a random port;
it says Node 22 in one place and 24 everywhere else;
it says “locked dependencies” while the scripts run npm install;
the AppImage runtime isn’t downloaded automatically;
it lists folder sending as future work, but it already works;
it doesn’t say which of the two AppImages users should download.
Undocumented: the environment variables PHONEHAUL_SERVER_BIN, PHONEHAUL_DESKTOP_MANAGED, PHONEHAUL_SETTINGS_FILE, PHONEHAUL_EXIT_ON_UI_CLOSE, and the local signing path.
docs/:
architecture.md calls the desktop shell future work;
security.md lacks the Tauri↔sidecar trust boundary and the incoming-files threat model;
protocol.md omits response bodies and error codes (401, 507, the PUT acknowledgement {status,size,sha256,destination}, and skipped from upload).
Execution order and why it differs from the review order
The report follows the requested order. The fixes run in a different order:

Format first. A formatting-only commit keeps every later diff readable.
Security next. Those fixes are small and independent.
Tests before refactoring. The Android ViewModel has no tests today, so refactoring it first would be blind.
Not in scope; listed in the report as decisions for the author:

consent or limits for incoming files on the phone;
the Play Store photo/video permission declaration;
R8 minification for release builds;
moving to Tauri’s built-in externalBin sidecar support;
Windows ARM64 builds;
splitting main.rs into modules. 506 lines with clear sections is acceptable. Pushback: low value.
Delivery:

One local branch per phase off main.
Commits carry no AI attribution (per your CLAUDE.md).
Pushing to sg0zzy/phonehaul or opening PRs only on your explicit go-ahead.
I stop after each phase.
Phase 0: Publish the review report
A Claude Doc containing the findings above in full, with file:line references and a “what’s good” section.
It is private until you share it.
Phase 1: Hygiene and tooling baseline
Tool definitions:

Prettier: rewrites JS/CSS/JSON formatting automatically.
ESLint: flags likely bugs in JS.
ktlint: a Kotlin formatter and checker.
Android lint: Google’s built-in static checks.
clippy: Rust’s built-in linter.
Changes:

Delete My, PhoneHaul, android/receiver/package-lock.json; stop tracking desktop/src-tauri/gen/.
.gitignore: add desktop/src-tauri/gen/, desktop/src-tauri/resources/phonehaul-server*, *.jks, *.keystore.
Root package.json dev dependencies: prettier, eslint, @eslint/js, globals. Add eslint.config.js (recommended rules only), .prettierrc and .editorconfig.
Formatting commit: a separate commit containing only prettier --write, so it can be ignored by git blame via .git-blame-ignore-revs.
Root script: npm run check = prettier --check + eslint + receiver tests + smoke test.
Android:
add a lint { abortOnError = true; baseline = file("lint-baseline.xml") } block; the baseline freezes existing warnings so only new ones fail;
add the org.jlleitschuh.gradle.ktlint plugin, with a separate ktlintFormat commit.
CI:
use npm ci everywhere;
add npm run check, cargo fmt --check, cargo clippy -- -D warnings and cargo test to the existing Linux desktop job;
add Android :app:lintDebug :app:ktlintCheck;
remove the commented-out matrix entries and the always-true if: conditions.
Proof:
Each gate is observed failing once before it is trusted: plant an unused variable, a mis-indented line, a clippy violation and a Kotlin style violation, check for a non-zero exit, then revert.
Then npm run check passes, ./gradlew :app:testDebugUnitTest :app:lintDebug :app:ktlintCheck passes, and cargo fmt --check && cargo clippy && cargo test passes in desktop/src-tauri.
Tests still 33/33.
Phase 2: Security fixes
Loopback guard (receiver/src/server/app.js, UI handler only). Two checks at the top:

Reject the request unless Host is 127.0.0.1:<uiPort> or localhost:<uiPort>. This kills DNS rebinding.
For non-GET methods, reject the request if an Origin header is present and isn’t the UI origin. This kills CSRF.
Browsers always send Origin on POST/DELETE. Tauri’s reqwest client sends neither a foreign Host nor an Origin, so it keeps working.

Rejected alternatives:
A shared-secret header: the browser page would need the secret, so it would leak into the HTML.
Requiring application/json: it doesn’t cover body-less POSTs.
Tests in api.test.js:

a foreign Host on GET /api/ui → 403;
a text/plain POST from a foreign Origin → 403, and the settings are unchanged (this is my scratchpad probe turned into a test; it is observed failing before the fix);
a same-origin POST → 200;
a POST with no Origin (the Rust client’s shape) → 200.
Sidecar lifetime (receiver/src/server/main.js managed mode + main.rs): the wrapper gives the sidecar a piped stdin, and the receiver exits on stdin end. Proof: an extension of managed.test.js that closes stdin and asserts the receiver exits.

Android:

override Pairing.toString() to redact the token;
comment why the hostname verifier is safe (the certificate pin is the check);
correct the SSL error message.
Rust:

put PHONEHAUL_SERVER_BIN behind cfg(debug_assertions) so it only works in debug builds;
add a startup timeout for the sidecar’s ready message;
use one shared reqwest::Client with timeouts.
CI:

pin third-party actions to commit SHAs;
pin the appimagetool and runtime downloads to a tagged release and verify them with sha256sum -c;
add environment: release to the signing job (you or the author creates the protected environment in GitHub settings).
Proof: the new tests pass and the old ones still pass. Re-run the scratchpad CSRF probe: the 200 becomes 403.

Phase 3: Bug fixes and the tests that guard refactors
Android delete-across-rotation:
Move the CompletableDeferred into the ViewModel.
The ViewModel emits a one-shot delete request through a Channel. The Activity collects it with repeatOnLifecycle(STARTED) and launches it with the existing deleteLauncher, whose callback now calls model.onDeleteResult(ok).
The Activity method reference is no longer passed into the ViewModel.
Add a BackHandler that maps system Back to vm.back() and is disabled while a transfer runs.
Proof: on an emulator, MOVE a photo, rotate while the system dialog is open, confirm, and see the transfer complete. If no emulator is available, I’ll say so.
Android tests:
Extract the trust manager into pinnedTrustManager(fingerprint) and test it with a fixed test certificate: a matching cert is accepted, any other cert and an empty chain are rejected.
Extract the MOVE delete decision into a pure function and test the statuses: committed+matching hash, already_present, skipped, failed.
exFAT:
First reproduce: create and mount an exFAT disk image in the scratchpad with hdiutil create -fs ExFAT, point a test destination at it, confirm the upload fails, then detach.
If confirmed, fix: when link() fails with ENOTSUP/EPERM/EXDEV, reserve the target with open(target,'wx') (fails if it exists, so retry chooseTarget), then rename(partial, target). Add a unit test that simulates the link failure.
Protocol vector: fix the schema (sha256 optional) and add one receiver test that feeds protocol/test-vectors/manifest-copy.json through validateManifest, so the artifact can’t drift silently again. No new dependency.
Smaller fixes:
Rust: decode UTF-8 by line, not by chunk, at main.rs:431;
fix the arm triplet in stage-appimage-libraries.js;
Android: derive versionCode from GITHUB_RUN_NUMBER or the tag, keeping 1 locally.
Phase 4: Refactoring
Android:
one UiState for the screen-level fields;
pull a TransferRunner out of the ViewModel;
one Hashing.kt (SHA-256 stream + hex) and one uniqueName() helper replacing the three copies;
delete the dead code listed above;
either use TransferState to drive the delete decision or delete its unused states.
Covered by the Phase 3 tests.
Receiver app.js:
split the two handlers into named route functions (handleLan, handleUi) with one route per small block;
/api/ui reuses uiState().
No framework is added.
Rust: a running_root() helper replacing the four copies; status built in one place, including the error field.
Scripts: one exported platform/arch naming helper used by package-sea.js, smoke-sea.js and stage-sidecar.js; the shell scripts use npm ci.
Proof: every test from Phases 1–3 is green, the smoke test passes, and the Android build and tests pass. Behavior is unchanged.
Phase 5: Documentation
README:
restructure as title → what it is → download and use → troubleshooting (with separate notes for the desktop app vs the standalone receiver) → link to docs/development.md;
move the build, release and environment-variable content into docs/development.md, with an env-var table;
fix every drift item listed in the Documentation findings.
docs/protocol.md: add the response bodies and error codes.
docs/security.md: add the loopback guard, the Tauri↔sidecar boundary and the incoming-files model.
docs/architecture.md: describe the desktop app as it exists today.
A short AGENTS.md with the durable rules for an AI-assisted author: run npm run check before committing, formatting is automatic, never commit keystores, and where tests live. The author builds with AI, so this encodes the lessons in the AI’s context.
Proof: every command in the docs is copy-pasted and run once on macOS (Linux/Windows-only commands are labelled as not verified here), and every link resolves.
Verification summary
Receiver: npm run check from the root. This covers format, lint, unit tests and the smoke test. Plus the CSRF/rebinding probe script before and after Phase 2.
Android: cd android && ./gradlew :app:testDebugUnitTest :app:lintDebug :app:ktlintCheck, plus the emulator rotation check in Phase 3.
Desktop: cd desktop/src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test; npm run desktop:dev launches the app; drop a file, then pair and transfer with the fake sender.
CI: push a phase branch only with your approval, and confirm the workflow runs green.
