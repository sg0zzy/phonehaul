import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

const receiverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = path.dirname(receiverDir);
const outfile = path.join(rootDir, 'dist', 'build', 'phonehaul.cjs');
await mkdir(path.dirname(outfile), { recursive: true });

await build({
  entryPoints: [path.join(receiverDir, 'src', 'server', 'main.js')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none'
});
console.log(`Bundled receiver: ${outfile}`);
