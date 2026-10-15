#!/usr/bin/env node
/**
 * Desktop build adapter (VERSIONING.md §3, §8).
 *
 * Derives the product version from the canonical VERSION file plus the build
 * environment (PHONEHAUL_OFFICIAL, PHONEHAUL_DEV_N) and injects it into the
 * Tauri config via `--config`, so packaging metadata is never edited
 * independently in tauri.conf.json or Cargo.toml.
 *
 * Usage: node scripts/tauri-build-versioned.js build|dev [tauri args...]
 *
 * Official builds (PHONEHAUL_OFFICIAL=1) require a stable VERSION; dev builds
 * embed X.Y.Z-dev.N. The version is validated by scripts/shared/version.js.
 * Raw `tauri build`/`tauri dev` bypasses the adapter; use the npm scripts.
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildIdentity } from '../../scripts/shared/version.js';

const require = createRequire(import.meta.url);
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { display, official } = buildIdentity();
const tauriEntry = require.resolve('@tauri-apps/cli/tauri.js', { paths: [desktopDir] });
const args = process.argv.slice(2);
if (args[0] !== 'build' && args[0] !== 'dev') {
  console.error('usage: tauri-build-versioned.js build|dev [tauri args...]');
  process.exit(2);
}
console.log(
  `PhoneHaul desktop build version: ${display}${official ? ' (official)' : ' (development)'}`,
);
const result = spawnSync(
  process.execPath,
  [tauriEntry, ...args, '--config', JSON.stringify({ version: display })],
  { stdio: 'inherit', cwd: desktopDir },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
