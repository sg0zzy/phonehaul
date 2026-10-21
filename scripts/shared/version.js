#!/usr/bin/env node
/**
 * Canonical version parsing and platform adapters (VERSIONING.md contract).
 *
 * The repository-root `VERSION` file is the single source of truth for the
 * intended core version and development status: `X.Y.Z` (release state) or
 * `X.Y.Z-dev` (development state). The build system supplies the development
 * number `N` via `PHONEHAUL_DEV_N` and the release flag via
 * `PHONEHAUL_OFFICIAL=1`; neither is ever stored in the source tree
 * (DEVELOPMENT_STANDARDS.md ).
 *
 * Platform adapters derive packaging metadata from the canonical version:
 *   - display:    `X.Y.Z` (official) or `X.Y.Z-dev.N`
 *   - Android:    versionCode = (major*1e5 + minor*1e3 + patch)*1e3 + slot,
 *                 dev slots 1..998, stable slot 999 (DEVELOPMENT_STANDARDS.md )
 *   - MSIX:       four-part numeric `major.minor.patch.0`; a pre-1.0 core maps
 *                 to major 1 (MSIX Identity Version forbids a zero first part)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const versionFilePath = path.join(rootDir, 'VERSION');

/** Android versionCode bounds (DEVELOPMENT_STANDARDS.md recommended scheme). */
export const limits = {
  major: 20,
  minor: 99,
  patch: 999,
  devSlotMax: 998,
  stableSlot: 999,
  playCap: 2100000000,
};

const canonicalPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-dev(?:\.\d+)?)?$/;

/** Parse a canonical version string (`X.Y.Z` or `X.Y.Z-dev`); throws otherwise. */
export function parseCanonical(text) {
  const trimmed = String(text).trim();
  const match = canonicalPattern.exec(trimmed);
  if (!match)
    throw new Error(
      `invalid canonical version ${JSON.stringify(trimmed)}: expected X.Y.Z or X.Y.Z-dev (DEVELOPMENT_STANDARDS.md )`,
    );
  const [, major, minor, patch, dev] = match;
  return {
    core: `${major}.${minor}.${patch}`,
    dev: Boolean(dev),
    major: +major,
    minor: +minor,
    patch: +patch,
  };
}

/** Read and parse the repository VERSION file (`PHONEHAUL_VERSION_FILE`
 * overrides the path; used by validation probes and tests). */
export function readCanonical(file = process.env.PHONEHAUL_VERSION_FILE || versionFilePath) {
  return parseCanonical(readFileSync(file, 'utf8'));
}

/** Parse a development number `N`: positive integer, no leading zeroes. */
export function parseDevN(value) {
  const text = String(value ?? '1').trim();
  if (!/^[1-9]\d*$/.test(text))
    throw new Error(
      `invalid development number ${JSON.stringify(text)}: expected a positive integer without leading zeroes (DEVELOPMENT_STANDARDS.md )`,
    );
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw new Error('development number exceeds safe integer range');
  return n;
}

function requireOfficialStable(version) {
  if (version.dev)
    throw new Error(
      `official builds require a stable canonical version, but VERSION is ${version.core}-dev (DEVELOPMENT_STANDARDS.md )`,
    );
}

/** Human-readable build version: `X.Y.Z` or `X.Y.Z-dev.N`. */
export function displayVersion({ official = false, devN = 1 } = {}, version = readCanonical()) {
  if (official) {
    requireOfficialStable(version);
    return version.core;
  }
  return `${version.core}-${process.env.PHONEHAUL_CHANNEL === 'local' ? 'local' : 'dev'}.${parseDevN(devN)}`;
}

/** Android versionCode per the bounded scheme; fails closed on any regression. */
export function androidVersionCode({ official = false, devN = 1 } = {}, version = readCanonical()) {
  const { major, minor, patch } = version;
  if (major > limits.major || minor > limits.minor || patch > limits.patch)
    throw new Error(
      `core ${version.core} exceeds the Android versionCode allocation (major<=${limits.major}, minor<=${limits.minor}, patch<=${limits.patch}); bump the documented allocation before distributing (DEVELOPMENT_STANDARDS.md )`,
    );
  let slot;
  if (official) {
    requireOfficialStable(version);
    slot = limits.stableSlot;
  } else {
    const n = parseDevN(devN);
    if (n > limits.devSlotMax)
      throw new Error(
        `dev.${n} exceeds the Android dev slot range 1..${limits.devSlotMax}; advance the core or use a centrally managed allocator before distributing (DEVELOPMENT_STANDARDS.md )`,
      );
    slot = n;
  }
  const code = (major * 100000 + minor * 1000 + patch) * 1000 + slot;
  if (!Number.isSafeInteger(code) || code < 1 || code > limits.playCap)
    throw new Error(
      `versionCode ${code} exceeds the Google Play cap ${limits.playCap}; change the documented allocation before distributing`,
    );
  return code;
}

/** Four-part MSIX Identity Version derived from the core (see docs for the major-0 mapping). */
export function msixVersion(version = readCanonical()) {
  const major = version.major === 0 ? 1 : version.major;
  return `${major}.${version.minor}.${version.patch}.0`;
}

/** Effective build identity from the environment (PHONEHAUL_OFFICIAL, PHONEHAUL_DEV_N). */
export function buildIdentity(env = process.env) {
  const official = env.PHONEHAUL_OFFICIAL === '1';
  const devN = parseDevN(env.PHONEHAUL_DEV_N ?? '1');
  const version = readCanonical();
  return { version, official, devN, display: displayVersion({ official, devN }, version) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? 'display';
  try {
    const { version, official, devN, display } = buildIdentity();
    const outputs = {
      core: () => version.core,
      canonical: () => (version.dev ? `${version.core}-dev.0` : version.core),
      display: () => display,
      'android-code': () => androidVersionCode({ official, devN }, version),
      msix: () => msixVersion(version),
      json: () =>
        JSON.stringify(
          {
            core: version.core,
            dev: version.dev,
            devN,
            official,
            display,
            androidVersionCode: androidVersionCode({ official, devN }, version),
            msixVersion: msixVersion(version),
          },
          null,
          2,
        ),
    };
    const run = outputs[command];
    if (!run) {
      console.error(
        `unknown command ${JSON.stringify(command)}: expected ${Object.keys(outputs).join('|')}`,
      );
      process.exit(2);
    }
    console.log(run());
  } catch (error) {
    console.error(`PhoneHaul version: ${error.message}`);
    process.exit(1);
  }
}
