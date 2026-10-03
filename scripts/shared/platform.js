/**
 * Shared platform/arch naming used by the build scripts.
 *
 * Keeps the `process.platform` -> artifact-name mapping and the executable
 * extension in one place so packaging scripts don't drift.
 */

const PLATFORM_NAMES = {
  win32: 'windows',
  darwin: 'macos',
};

/**
 * Map a Node `process.platform` value to the name used in PhoneHaul build
 * artifacts (`win32` -> `windows`, `darwin` -> `macos`, otherwise unchanged).
 */
export function normalizedPlatform(platform = process.platform) {
  return PLATFORM_NAMES[platform] ?? platform;
}

/**
 * Executable file extension for a build artifact (`.exe` on Windows, empty
 * string on every other platform).
 */
export function executableExtension(platform = process.platform) {
  return platform === 'win32' ? '.exe' : '';
}

/**
 * Standalone SEA executable name, e.g. `phonehaul-windows-x64.exe`.
 */
export function seaExecutableName() {
  return `phonehaul-${normalizedPlatform()}-${process.arch}${executableExtension()}`;
}
