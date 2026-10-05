import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { copyFile, chmod, mkdtemp, readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { seaExecutableName } from '../../scripts/shared/platform.js';

const require = createRequire(import.meta.url);
const { inject } = require('postject');
const receiverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = path.dirname(receiverDir);
const distDir = path.join(rootDir, 'dist');
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) throw new Error('PhoneHaul SEA packaging requires Node.js 22 or newer.');

const platform = process.platform;
const outputName = seaExecutableName();
const outputPath = path.join(distDir, outputName);
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-sea-'));
const bundlePath = path.join(tempDir, 'phonehaul.cjs');
const configPath = path.join(tempDir, 'sea-config.json');
const blobPath = path.join(tempDir, 'sea-prep.blob');
const stagedPath = path.join(distDir, `.${outputName}-${process.pid}`);

try {
  await build({
    entryPoints: [path.join(receiverDir, 'src', 'server', 'main.js')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: `node${nodeMajor}`,
    sourcemap: false,
    legalComments: 'none',
  });
  await writeFile(
    configPath,
    JSON.stringify({
      main: bundlePath,
      output: blobPath,
      useSnapshot: false,
      useCodeCache: false,
    }),
  );
  execFileSync(process.execPath, ['--experimental-sea-config', configPath], { stdio: 'inherit' });
  await mkdir(distDir, { recursive: true });
  await copyFile(process.execPath, stagedPath);
  if (platform === 'darwin')
    execFileSync('codesign', ['--remove-signature', stagedPath], { stdio: 'inherit' });
  await inject(stagedPath, 'NODE_SEA_BLOB', await readFile(blobPath), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    machoSegmentName: 'NODE_SEA',
  });
  // Injection changes the Mach-O binary; macOS requires a fresh signature to run it.
  if (platform === 'darwin')
    execFileSync('codesign', ['--force', '--sign', '-', stagedPath], { stdio: 'inherit' });
  if (platform !== 'win32') await chmod(stagedPath, 0o755);
  // Rename instead of writing in place: an executing packaged binary is ETXTBSY.
  await rename(stagedPath, outputPath);
  console.log(`Standalone receiver created: ${outputPath}`);
} finally {
  await rm(stagedPath, { force: true });
  await rm(tempDir, { recursive: true, force: true });
}
