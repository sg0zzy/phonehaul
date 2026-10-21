# Versioning exceptions

Platform packaging deviations from the canonical version rules in
[VERSIONING.md](https://github.com/sg0zzy/phonehaul/blob/main/VERSIONING.md).
The pinned central policy is identified in [DEVELOPMENT_STANDARDS.md](https://github.com/sg0zzy/phonehaul/blob/main/DEVELOPMENT_STANDARDS.md); unresolved compliance gaps are recorded there. the derivations live in
`scripts/shared/version.js` and are validated in CI.

## MSIX: major 0 maps to 1

The MSIX `Identity Version` must be four numbers with a **nonzero first
part**, which a pre-1.0 core (`0.Y.Z`) cannot satisfy. `package-msix.js`
therefore derives `major.minor.patch.0` from the core with a major of `0`
mapped to `1` (core `0.1.1` → `1.1.1.0`). `MSIX_VERSION` overrides the derived
value. Consequence: the first 1.x core would collide with the mapped 0.x
version; if that ever matters, bump `MSIX_VERSION` explicitly for that release.

**Beta builds share the identity version:** `msixVersion()` derives from the
core only, so `0.1.1-dev.3` and `0.1.1` both map to `1.1.1.0` — MSIX identity
cannot carry `-dev.N`. Beta MSIX artifacts are informational; the prerelease
name and filename are the authoritative identity (see the adoption record).

## Android identity and encoded versionCode

The existing adapter is retained to preserve release compatibility:
`versionCode = (major·100000 + minor·1000 + patch)·1000 + slot`;
local/debug/beta slots are `1..998`, stable slot is `999`. Allowed core fields are
major `0..20`, minor `0..99`, patch `0..999`, with the Play cap 2,100,000,000.
Exhaustion or invalid input fails; codes never wrap. The same implementation exists
in Gradle and `scripts/shared/version.js`.

For this bounded domain, greater cores produce greater numeric ranges and stable
follows every beta slot in its core. Official beta allocation is coordinated;
local counters never reserve official slots. Keeping this encoded scheme still
requires a complete inventory of historical/submitted codes and proof of every
promised update edge. That evidence is currently missing: do not claim full
Android compliance or migrate the numeric allocation blindly.

Debug APKs use the production ID `it.stefanogozzi.phonehaul` with a test-only signer.
Use isolated test devices/emulators: signer differences or high local codes can
block official updates. Local builds display `X.Y.Z-local.N`; ordinary CI uses
`X.Y.Z-dev.1` without consuming production allocation. Official signed beta APKs
require a committed `-dev.0` declaration and final signer verification. Play
submission is manual, only for stable verified AABs.

The application ID was `org.phonehaul.app` before the package was registered in
the Play Console as `it.stefanogozzi.phonehaul`. A debug APK installed under the
old ID is a different package: it is not replaced by the registered build, both
can coexist on one device, and its stored preferences are not carried over.
Uninstall the old `org.phonehaul.app` package by hand before installing the
registered build.

## Shared identifier across Android and desktop

The Android application ID (`namespace`/`applicationId` in
`android/app/build.gradle.kts`, and the Kotlin package) and the Tauri desktop
`identifier` (`desktop/src-tauri/tauri.conf.json`) are both
`it.stefanogozzi.phonehaul`. They are separate platforms with separate
registries, so the shared value is a naming choice, not a shared identity: the
Android ID is the Google Play package name, the Tauri identifier is the desktop
bundle ID and the WebView data-directory name.

Changing either value is a breaking identity change for that platform. For
Android it additionally invalidates any Play listing, and a previously
published listing can no longer be updated from this source.
