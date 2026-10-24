// Native packaging replaces this module with embedded assets. Source-mode
// development builds them lazily using the repository's existing esbuild.
let pending;
export function loadInternetAssets() {
  pending ??= import('../../scripts/internet-assets.js').then((m) => m.buildInternetAssets());
  return pending;
}
