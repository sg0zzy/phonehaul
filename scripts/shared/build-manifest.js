#!/usr/bin/env node
/**
 * Emit `build-manifest.json` for one archived build (VERSIONING.md §4.7).
 *
 * Usage: node scripts/shared/build-manifest.js <output-dir> <product> <output-file>...
 *
 * Reads identity from the environment set by scripts/build.sh
 * (PHONEHAUL_BUILD_ID, PHONEHAUL_VERSION, PHONEHAUL_DIRTY,
 * PHONEHAUL_SOURCE_DIGEST, PHONEHAUL_PLATFORM, PHONEHAUL_ARCH,
 * PHONEHAUL_TOOLCHAIN, PHONEHAUL_LOCKFILES). Fails if the file already
 * exists: archived manifests are never overwritten (§4.6).
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const [outputDir, product, ...outputs] = process.argv.slice(2);
if (!outputDir || !product || outputs.length === 0) {
  console.error('usage: build-manifest.js <output-dir> <product> <output-file>...');
  process.exit(2);
}

async function sha256(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject);
  });
  return hash.digest('hex');
}

const dirty = process.env.PHONEHAUL_DIRTY === '1';
const lockfiles = (process.env.PHONEHAUL_LOCKFILES ?? '')
  .split(path.delimiter)
  .filter(Boolean)
  .map((file) => path.resolve(file));

const manifest = {
  product,
  version: process.env.PHONEHAUL_VERSION,
  buildId: process.env.PHONEHAUL_BUILD_ID,
  builtAt: new Date().toISOString(),
  commit: process.env.PHONEHAUL_COMMIT,
  dirty,
  sourceDigest: process.env.PHONEHAUL_SOURCE_DIGEST || undefined,
  lockfiles: Object.fromEntries(
    await Promise.all(
      lockfiles.map(async (file) => [
        path.relative(process.env.PHONEHAUL_ROOT ?? process.cwd(), file),
        await sha256(file),
      ]),
    ),
  ),
  outputs: await Promise.all(
    outputs.map(async (file) => ({
      file: path.basename(file),
      sha256: await sha256(file),
      size: (await stat(file)).size,
    })),
  ),
};

await mkdir(outputDir, { recursive: true });
const target = path.join(outputDir, 'build-manifest.json');
try {
  await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
} catch (error) {
  if (error.code === 'EEXIST') {
    console.error(`refusing to overwrite existing manifest: ${target}`);
    process.exit(1);
  }
  throw error;
}
console.log(`build-manifest.json: ${target}`);
