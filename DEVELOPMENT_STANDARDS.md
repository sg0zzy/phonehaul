# Development standards adoption

| Field                                  | Adopted value                                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Standards origin                       | <https://github.com/sg0zzy/dev-standards>                                                            |
| Edition                                | 1.0.0                                                                                                |
| Immutable commit                       | `90bf955cbeb0fdf0a711e255b182f864807b3784` (no upstream tags available)                              |
| Verified local snapshot                | Not vendored; immutable retrieval below                                                              |
| Snapshot inventory/digest verification | [standards.sha256](standards.sha256), SHA-256 for all policy documents/templates/examples            |
| Adoption date and developer approval   | 2026-10-17; repository owner's standards migration request; changes remain uncommitted               |
| Scope/status                           | Partial adoption: local/CI/beta/stable, Android and desktop; gaps below block full compliance claims |
| Configuration/native mapping           | Tables below; repository-owned scripts/workflows, no central executable dependency                   |
| Compliance evidence                    | Validation results below and local command logs; remote workflows not executed                       |

## Authority and retrieval

Precedence, highest first: explicit user instructions and non-overridable
security/platform requirements; this pinned central revision; documented project
exceptions permitted by central policy; local policies; historical implementation.
Central MUST/MUST NOT requirements are binding. SHOULD defaults permit justified
departures; documenting an unmet MUST does not make it compliant.

Applicable central documents are `README.md`, `ADOPTION.md`, `VERSIONING.md`,
`BUILD.md`, `RELEASE.md`, `ARTIFACTS.md`, `DISTRIBUTION.md`, `SECURITY.md`,
`ARCHITECTURE.md`, `ANDROID.md`, `CONFIGURATION.md` and `COMPLIANCE.md` at
[the pinned revision](https://github.com/sg0zzy/dev-standards/tree/90bf955cbeb0fdf0a711e255b182f864807b3784).
Upstream `AGENTS.md` was reviewed and governs the standards repository itself;
`templates/AGENTS.project.md` and `templates/DEVELOPMENT_STANDARDS.md` guide this
adoption. Examples were reviewed as informative material.

Retrieve into a fresh temporary directory, verify the immutable Git identity,
then check the inventory (run from PhoneHaul's root):

```sh
standards_inventory="$(pwd)/standards.sha256"
standards_checkout=$(mktemp -d)
git clone --quiet https://github.com/sg0zzy/dev-standards.git "$standards_checkout"
git -C "$standards_checkout" checkout --quiet 90bf955cbeb0fdf0a711e255b182f864807b3784
test "$(git -C "$standards_checkout" rev-parse HEAD)" = 90bf955cbeb0fdf0a711e255b182f864807b3784
(cd "$standards_checkout" && sha256sum -c "$standards_inventory")
```

Normal builds never
fetch the standards. If upstream is unavailable, use an already verified checkout;
if none exists, report the missing policy source and do not guess compliance or
perform policy-dependent release/deletion operations. Independent safe work may
continue. Never substitute a moving branch or remembered policy.

## Project mapping

| Policy concept                                | PhoneHaul implementation                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity                                      | PhoneHaul; `sg0zzy/phonehaul`                                                                                                                                                                                                                                                                                                       |
| Architecture / recovery                       | [docs/architecture.md](docs/architecture.md), [docs/security.md](docs/security.md)                                                                                                                                                                                                                                                  |
| Application version / mirrors / compatibility | Root `VERSION`; [VERSIONING.md](VERSIONING.md); JS/Gradle adapters derive package fields; Cargo package version identifies the Rust crate, not the distributed product                                                                                                                                                              |
| Bump / dry-run / recovery                     | `scripts/version.sh bump major\|minor\|patch [description] [--dry-run]`; `scripts/shared/version-operation.js`                                                                                                                                                                                                                      |
| Build prerequisites / checks                  | [docs/development.md](docs/development.md); `npm run check`, Rust and Kotlin gates in AGENTS.md                                                                                                                                                                                                                                     |
| Local source / storage                        | `scripts/build.sh dev TARGET`; `scripts/shared/source-identity.js`, `build-info.js`, `artifacts.js`; SHA-256 canonical input inventory, pre/post coherence check                                                                                                                                                                    |
| Counter scope / recovery                      | Per-core local counters and completion sequence in `.build-state/artifact-counters.json`, outside retention; `.initialized` sentinel prevents reuse after ledger loss; restore/reconcile explicitly, never reset it to unblock builds; root ignored `.phonehaul-local-counter-initialized` also detects loss of the state directory |
| Cleanup / protection                          | `scripts/cleanup-artifacts.sh --dry-run`, `--keep N`, `--protect ID`, `--unprotect ID --yes`, `--remove ID --yes`; default retain 10 successful unprotected builds, 0 removes all eligible builds                                                                                                                                   |
| Git exclusions                                | Root `.gitignore`: `/local_artifacts/`, `node_modules/`, `dist/`, `__pycache__/`, `target/`; no excluded file may remain tracked                                                                                                                                                                                                    |
| CI                                            | `receiver-build.yml` → `platform-builds.yml`; exact push SHA or PR proposed merge SHA; head/base recorded; temporary artifact retention 14 days                                                                                                                                                                                     |
| Official allocation / coordination            | `official.js` inventories all remote tags, GitHub releases and `release-reservations.json`; rejects unknown historical identities; beta/stable share `official-release-lifecycle`; atomic create-only tag push and final published high-water revalidation                                                                          |
| Release / recovery                            | `release.sh`, `beta-version.sh`, `assemble-release-assets.sh`, `publish-release.js`; exact annotated tag, manifest/hash aggregation, draft staging, protected human publication review; no visible-asset replacement                                                                                                                |
| Notes                                         | `release-notes.sh`: previous completed stable Release to exact tag, initial reachable history otherwise; divergent history fails for review; draft body must be curated before publication approval                                                                                                                                 |
| Config identity                               | SHA-256 of this adoption declaration in local and CI manifests; immutable standards commit in release manifest                                                                                                                                                                                                                      |
| Platform mappings                             | [docs/versioning-exceptions.md](docs/versioning-exceptions.md); target signing profiles below                                                                                                                                                                                                                                       |

## Build matrix and signing

All targets selected by a local invocation are mandatory for that invocation.
Local `receiver` collects the bundled CJS, `appimage` the standalone Linux
AppImage and SEA executable, `android` the universal debug APK, and `desktop-linux` the Tauri
AppImage. `all` selects receiver, Android and standalone AppImage. Raw npm/native
packaging commands are compilation primitives with transient outputs; use the
managed build command to retain final local deliverables. Windows/macOS packages use `desktop-windows` / `desktop-macos` on their matching hosts (unverified on Linux).

| Release/CI target     | Platform / architecture / package            | CI          | Beta / stable                                 | Signing profile                                                                                                                                                                                         |
| --------------------- | -------------------------------------------- | ----------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `receiver-x64`        | Linux x86_64 SEA + AppImage                  | mandatory   | mandatory                                     | unsigned, SHA-256 only                                                                                                                                                                                  |
| `receiver-arm64`      | Linux arm64 SEA + AppImage                   | mandatory   | mandatory                                     | unsigned, SHA-256 only                                                                                                                                                                                  |
| `desktop-linux`       | Linux x86_64 Tauri AppImage                  | mandatory   | mandatory                                     | unsigned, SHA-256 only                                                                                                                                                                                  |
| `desktop-windows`     | Windows x64 NSIS EXE                         | mandatory   | mandatory                                     | unsigned, SHA-256 only; no publisher certificate configured                                                                                                                                             |
| `desktop-macos-arm64` | macOS arm64 DMG                              | mandatory   | mandatory                                     | unsigned, not notarized; manual installation limitation                                                                                                                                                 |
| `desktop-macos-intel` | macOS x64 DMG                                | optional    | optional                                      | unsigned, not notarized                                                                                                                                                                                 |
| `android-debug`       | Android universal APK, API 30+               | mandatory   | build validation only, excluded from releases | ephemeral debug signer, test-only                                                                                                                                                                       |
| `android-signed`      | Android universal release APK + AAB, API 30+ | excluded    | optional                                      | `release` environment; existing credential secrets; expected APK certificate variable `ANDROID_SIGNER_SHA256` (64 hex digits, no colons); final APK and AAB signature/certificate verification required |
| MSIX                  | Windows x64 unsigned Store package           | conditional | conditional optional                          | only with both `MSIX_IDENTITY_NAME` and `MSIX_PUBLISHER`; Store signing needed for installation                                                                                                         |

Optional failures/omissions remain visible in workflow results and the release
manifest/body. Android is optional in the existing delivery design; missing or
invalid credentials fail its selected job, with no debug fallback. Browsers and
hosted web applications are out of scope. No supported package target is removed.

## Android and compatibility inventory

Application ID is `it.stefanogozzi.phonehaul`, minSdk 30, target/compile SDK 36.
This is the package name registered in the Google Play Console; Play rejects an
upload whose package name differs from the listing, so the Gradle
`namespace`/`applicationId` and the Kotlin package are kept equal to it.
Retain the existing encoded versionCode domain and bounds (see versioning
exceptions); changing it without Play/submission history would risk update
compatibility. Local builds consume no production reservations. Same-ID debug
packages use a different signer and may prevent official updates on that test
device. Use a separate emulator/device or preserve data through native file
backup before any intentionally destructive reinstall. Reinstalling is never
proof of upgrade compatibility.

Historical APK signer fingerprints, Play app-signing certificate, highest
allocated/submitted codes and device upgrade results are not available in the
repository. Intended same-signer beta→beta, beta→stable and stable→stable edges
need that evidence before being promised. GitHub↔Play and stable→older-beta
transitions are unsupported. Never infer Play's app-signing certificate from
its upload key, change the app ID, rotate/generate production keys, or migrate
codes automatically.

## Distribution and authorized automation

| Destination / platform / channel                  | Mode / artifacts                                                                                                             | Success and retry identity                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| GitHub / all declared targets / beta              | Human dispatch on trusted main; automatic staging; human-approved publication, prerelease, latest disabled                   | Visible complete release; immutable tag + manifest SHA-256; verify existing identical bytes on retry |
| GitHub / all declared targets / stable            | Explicit stable preparation and separately authorized tag push; automatic staging; human-approved publication, latest stable | Same identity/checks; no rebuild during delivery                                                     |
| Google Play / Android / stable                    | manual; verified release AAB from completed GitHub release                                                                   | Human Console receipt/processing/rollout state; ID + versionCode + AAB hash; reconcile before retry  |
| Google Play / Android / beta                      | disabled                                                                                                                     | no transmission                                                                                      |
| Microsoft Store / Windows x64 / stable            | manual; verified MSIX if configured                                                                                          | Partner Center receipt/acceptance; package identity/version + hash                                   |
| Microsoft Store / Windows / beta                  | disabled                                                                                                                     | no transmission                                                                                      |
| Website, Apple channels, other destinations / all | disabled                                                                                                                     | no transmission                                                                                      |

The `release` signing environment must restrict refs to reviewed main history
and release tags. `release-publication` must have required reviewers who inspect
the staged tag/source, notes, target outcomes and hashes before approval. The
publisher checks reviewer protection exists and fails closed if absent. Repository
rulesets should prohibit moving/deleting official tags. Read-only GitHub API inspection found `release` with no protection rules, no
`release-publication` environment, and no repository rulesets. These settings
remain unchanged; configure/review them before official use.

This migration authorizes only local infrastructure work. It authorizes no
commit/tag/push, workflow dispatch, release, signing credential change or external
deployment. Future explicit beta dispatch/stable tag push authorizes only the
workflow's declared GitHub operations, with its signing/publication approvals;
store delivery remains a separate human action. Configuration or credential
presence alone never grants agent authority.

## Departures and gaps

| Type             | Policy / decision / consequence                                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SHOULD departure | Verified retrieval instead of vendoring a snapshot; avoids policy copies but requires a previously verified checkout for offline policy work                                                                                       |
| SHOULD departure | Existing Node.js sidecar and plain JavaScript frontend retained alongside preferred Tauri/Rust and Kotlin/Compose; rewriting brings no adoption benefit. Native files/HTTPS meet LAN transfer needs; no RxDB/WebRTC service needed |
| SHOULD departure | Stable temporary artifact names support existing same-run download grouping; manifests record exact SHA/run/attempt                                                                                                                |
| SHOULD departure | Debug application ID unchanged to preserve installed identity; isolate test devices and do not claim production update support                                                                                                     |

| MUST gap — Android | Owner must configure the currently absent `ANDROID_SIGNER_SHA256` public-identity variable and inventory public signer/Play identities and every allocated/submitted code, prove encoded ordering and exercise device/data upgrades before claiming Android release compliance. No code/credential migration performed |
| MUST gap — historical reservations | Visible remote inventory contains only `v0.1.0`; deleted tags/tombstones and unpublished external allocations cannot be proven absent. Owner must reconcile historical records before first official use |
| MUST gap — environment controls | Read-only API audit found signing environment `release` unprotected, publication-review environment absent and no tag rulesets. Configure eligible refs/reviewers and immutable tag protection externally before official use; no settings were changed |
| Validation gap — remote | CI/release workflows, protected environments, tag rulesets, native Windows/macOS builds/install checks and store delivery have not run in this task. These require authorized execution on matching platforms |
| Validation gap — artifacts | Source coherence uses pre/post identity detection, not a private compilation snapshot; relevant custom ignored toolchain inputs must be added to the scope before use. SDK paths are hashed through local.properties; secret material is excluded |

Gaps belong to the repository owner; this change supplies the implementation and
local evidence, not remote or device success claims. Do not claim full compliance
while applicable MUST gaps remain.

## Acceptance evidence and revision updates

The development declaration was normalized from `0.1.1-dev` to `0.1.1-dev.0`
without changing its core, allocating a release identity or creating a commit.
Historical declarations remain readable; only the normalized form can seed a
new beta after the reviewed source is committed.

2026-10-17 inspection: no central stable tags; selected default-branch commit
`90bf955cbeb0fdf0a711e255b182f864807b3784`; reviewed all policies/templates/examples. The existing unfinished
adoption draft referenced an unverified different commit; it was replaced with
this resolvable pin and a new digest inventory. Application Git history and
release identities remain unchanged. Local validation is recorded below; all remote/device execution cases remain unexercised.

To update the pin: resolve a stable tag (or exact default-branch SHA), compare
obligations with this revision, assess code/signing/counter/retention/delivery
compatibility, update local implementation and digests, run affected acceptance
cases, record gaps/results and obtain review of the combined change. Do not
silently follow main or enable new destinations during a pin update.

## Local migration validation report

Evidence date: 2026-10-17; application base `516f923cf970b383cf3b837779fc682f1ad4a505`
plus this uncommitted migration; standards commit is pinned above. The internal
checklist was created before edits in `/tmp/phonehaul-migration-checklist.md`.
The pre-existing unfinished migration and staged removal of the unused
`scripts/shared/build-manifest.js` were preserved; no remaining callers reference
that superseded manifest generator.

| Area / applicable cases                                       | Result and limits                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Policy adoption P01/P03                                       | Exact Git commit and all 21 policy/example/template digests verified. Native mapping, precedence and offline behavior recorded. No policy copied into the project and no shared executable dependency added                                                                                                      |
| Architecture R02/R04/R09/R12                                  | Existing stack/permissions/protocol retained; isolated native backup/restore recovered nested, Unicode-named binary/text files with matching SHA-256. No device-private state recovery claim                                                                                                                     |
| Local L01/L03                                                 | Receiver builds produced distinct local.N counters, exclusive directories and preserved prior bytes without committing. Managed all-target build produced CJS, debug APK, standalone SEA and AppImage. Linux desktop AppImage also built/archived successfully. Manifests identify source/config and environment |
| Storage L04/L05/L08/L10/L11/L12 (isolated behavioral subsets) | Tests cover sequence over misleading dates, retention overrides including zero, protection, failed/active/unknown/malformed/duplicate-sequence records, symlink root/child/keep, nonmutating dry-run and ledger/state loss. Full simultaneous-collector/interruption fault campaign is not claimed               |
| Source L02 (identity subset)                                  | Tracked deletion, untracked inputs and ignored SDK config change source identity; input mutation detection is implemented before/after compilation. No claim of a complete interrupted/ABA-edit compilation campaign                                                                                             |
| Version U03/U05/V01/V03/A05 (local subsets/simulations)       | Dirty mutation refusal, metadata/index-preserving dry-runs (including legacy dev.12 transitions), SemVer examples, slot/core bounds and failed-remote-tag high-water tested. No version commit/tag was executed, including in fixtures; commit/recovery and live reservation cases remain unexercised            |
| Release B04/B07/S06/S09 (transport/history simulations)       | Missing mandatory targets, corrupt transport, unknown history and overwriting assembled output fail. Required package sets and optional omissions verified in fixtures. No live Release/API publication or full retry simulation claimed                                                                         |
| npm gate                                                      | `npm ci` in root/receiver/desktop; `npm run check` passes: format, lint (including scripts), 8-page docs links, 9 infrastructure tests, 91 receiver tests and end-to-end smoke                                                                                                                                   |
| Rust                                                          | `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test` pass; 5 tests                                                                                                                                                                                                                                   |
| Kotlin                                                        | `:app:testDebugUnitTest :app:lintDebug :app:ktlintCheck` pass; ktlint formatter applied to the Gradle edit                                                                                                                                                                                                       |
| Packaging                                                     | Standalone SEA smoke passes; managed receiver/Android/AppImage/Linux desktop builds pass. Windows/macOS/arm64 builds, interactive installation and production signing remain unverified on this Linux host                                                                                                       |
| Static checks                                                 | actionlint 1.7.12 including embedded ShellCheck, ShellCheck 0.10.0 with sourced common.sh, Bash syntax, Git whitespace, required ignore patterns and absence of excluded tracked files checked                                                                                                                   |
| Remote read-only audit                                        | Only visible official tag/release is v0.1.0 (existing Linux desktop asset); release environment lacks protection, publication environment/rulesets and public signer variable are absent. Historical/deleted reservations and unpublished Play state still need owner reconciliation                             |

Implemented: authority declaration/digest inventory, concise local version mapping,
agent precedence, metadata marker normalization, independent local counters,
conservative artifact management, source identity, CI transport manifests, trusted
beta selection, aggregate draft publication and manual store separation. Generic
versioning/release/retention policy duplication and stale section references were
removed; operational build/signing/package instructions were retained. The
original supported receiver, desktop, Android and conditional MSIX targets remain.

Recommended next steps (not performed): configure/review GitHub environment and tag
protection; inventory Android codes/certificates and external submission history;
review and commit this migration when authorized; execute CI and reviewed beta/stable
workflows on matching runners, then device upgrade and manual distribution checks.
No commit, tag, push, remote workflow, Release, external deployment or credential
change was performed. These gaps prevent a claim of full release compliance.

Final storage verification: two simultaneous managed receiver invocations completed
as `0.1.1-local.7` and `0.1.1-local.8` with distinct directories and completion
sequences. All files in eight successful managed archives matched their recorded
sizes/SHA-256; the pre-existing legacy archive remained untouched. An unsupported
Windows-on-Linux invocation returned failure, recorded `state: failed` and a
failed target outcome, and performed no retention. Its consumed local counter
was not reclaimed. Production APK/AAB signing was not executed. Final Git HEAD
and the existing v0.1.0 tag are unchanged; the pre-existing staged deletion remains.
