# PhoneHaul version implementation

Policy authority is the immutable central revision in
[DEVELOPMENT_STANDARDS.md](DEVELOPMENT_STANDARDS.md), especially its
`VERSIONING.md`, `RELEASE.md` and `ANDROID.md`. This document describes the
repository-owned implementation, rather than a separate generic contract.

## Authority and platform mapping

Root `VERSION` is the only editable product version. JS readers are in
`scripts/shared/version.js`; Android derives versionName/versionCode in
`android/app/build.gradle.kts`; Tauri receives a build-time config override from
`desktop/scripts/tauri-build-versioned.js`. MSIX derivation and limitations are in
[versioning exceptions](docs/versioning-exceptions.md). Rust Cargo metadata is
crate metadata; it does not independently set the product version.

Legacy `X.Y.Z-dev` declarations remain readable for historical sources. This migration
normalizes the current development marker to `0.1.1-dev.0`, preserving the existing
core without a bump, commit, tag or official reservation. Explicit development
bumps also declare `X.Y.Z-dev.0`. New beta
reservations require that form. Local builds use `X.Y.Z-local.N`, independently
of official beta `dev.N`, including while the authority declares a stable version.
Local Android codes retain the existing test-only slot adapter; they consume no
official reservation and promise no upgrade into production.

## Operations and recovery

```sh
scripts/version.sh show
scripts/version.sh bump patch --dry-run
scripts/version.sh bump minor "Start next development cycle" --dry-run
scripts/version.sh set 0.2.0-dev.0 --dry-run
scripts/release.sh prepare 0.2.0 --dry-run
scripts/release.sh publish 0.2.0 --dry-run
```

Without `--dry-run`, an explicitly requested bump requires a clean tree/index,
validates adapters and the full npm gate, and creates a metadata-only local commit
through a private index. It never tags/pushes/builds/releases. Stable preparation
also checks complete official history and creates an annotated local tag. Push is
separate and atomic for branch/tag. No operation is authorized merely by reading
these examples; this migration creates no commit or tag.

A failed operation reports current HEAD and intended VERSION. Inspect
`git status`, `git log -1`, VERSION and the intended local tag before retrying.
Validation failures before edits leave source unchanged. Later failures leave an
explicit checkpoint: only VERSION may need reconciliation, or the version commit
may already exist. Do not blindly bump again, reset unrelated work, move an
existing remote tag or reclaim an abandoned reservation. Restore only owned edits
or resume stable preparation for an already committed matching version. Private
commit construction bypasses commit hooks; the repository gate is run explicitly
before it and unrelated concurrent edits cause refusal.

Official reservations use all remote tags/releases plus `release-reservations.json`.
Keep abandoned remote identities consumed. Ambiguous push/API outcomes require
querying actual state before retry. Published identical assets are verified as a
no-op; differing bytes fail. Drafts may be resumed only with matching artifacts;
source changes require a greater version. Human-reviewed notes use the previous
successfully published stable, never an abandoned stable tag or latest beta.

## Compatibility surface

Before 1.0, incompatible LAN protocol, persisted settings, transfer semantics and
CLI behavior require an explicit minor-version decision and migration notes.
Patch versions preserve those contracts. Received files are portable native files;
standards adoption must not alter user files, settings, package IDs or signer
identity. The Android code history and MSIX numeric mapping must be reviewed before
promising a platform update path, even if the product SemVer increases.

Local build/storage commands and counter recovery are in
[the developer guide](docs/development.md#versioning-and-builds); signing,
matrices, exceptions and remaining compliance gaps are in DEVELOPMENT_STANDARDS.md.
