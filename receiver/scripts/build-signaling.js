import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { internetAssetsPlugin } from './internet-assets.js';

const receiverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(receiverDir, '..', 'dist', 'build', 'phonehaul-signaling.mjs');
await mkdir(path.dirname(outfile), { recursive: true });
await build({
  entryPoints: [path.join(receiverDir, 'src', 'internet', 'main.js')],
  outfile,
  bundle: true,
  plugins: [internetAssetsPlugin],
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: false,
  legalComments: 'inline',
});
console.log(`Bundled signaling service: ${outfile}`);
