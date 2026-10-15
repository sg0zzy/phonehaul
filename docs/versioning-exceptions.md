# Versioning exceptions

Platform packaging deviations from the canonical version rules in
[VERSIONING.md](https://github.com/sg0zzy/phonehaul/blob/main/VERSIONING.md).
Everything not listed here follows the contract; the derivations live in
`scripts/shared/version.js` and are validated in CI.

## MSIX: major 0 maps to 1

The MSIX `Identity Version` must be four numbers with a **nonzero first
part**, which a pre-1.0 core (`0.Y.Z`) cannot satisfy. `package-msix.js`
therefore derives `major.minor.patch.0` from the core with a major of `0`
mapped to `1` (core `0.1.1` → `1.1.1.0`). `MSIX_VERSION` overrides the derived
value. Consequence: the first 1.x core would collide with the mapped 0.x
version; if that ever matters, bump `MSIX_VERSION` explicitly for that release.

## Android: debug APKs are a separate channel

CI debug APKs (`PhoneHaul builds` workflow) are debug-signed with an ephemeral
per-runner key, so cross-run in-place upgrades are impossible anyway. They
build as `X.Y.Z-dev.1` of the current core instead of consuming the dev
counter. The Google Play channel is the signed release workflow
(`android-signed-release.yml`), which builds official `X.Y.Z` with the stable
versionCode slot.

## Android versionCode allocation

`versionCode = (major·100000 + minor·1000 + patch)·1000 + slot`, with dev slots
`1..998` (the `N` of `dev.N`) and stable slot `999`. The build **fails closed**
when a core exceeds `20.99.999` or a dev number exceeds `998`; advancing past
that requires changing the documented allocation in `scripts/shared/version.js`
(§8 of the contract). Codes stay below the 2,100,000,000 Play cap.

## CI dev numbers are not globally coordinated

Local dev builds increment a per-workstation counter
(`.build-state/dev-counter`). CI dev builds set `PHONEHAUL_DEV_N` explicitly
(the debug channel pins `1`). Two workstations can therefore produce the same
`X.Y.Z-dev.N` for the same core; the build id, commit, and source digest in
each artifact's `build-manifest.json` disambiguate them. Only the Play channel
requires globally increasing identifiers, and it gets them from stable
releases.
