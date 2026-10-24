import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildInternetAssets } from './internet-assets.js';
import { internetConfig } from '../src/internet/config.js';

if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('Node.js 24 is required.');
const output = path.resolve(process.argv[2] ?? 'dist/internet-client');
for (const [url, asset] of Object.entries(await buildInternetAssets())) {
  const name = url === '/internet/' ? 'index.html' : url.split('/').at(-1);
  await mkdir(path.join(output, 'internet'), { recursive: true });
  await writeFile(path.join(output, 'internet', name), asset.body);
}
await writeFile(
  path.join(output, 'internet', 'config'),
  JSON.stringify({
    ...internetConfig(process.env),
    mode: 'browser',
    signalingUrl: process.env.PHONEHAUL_SIGNAL_URL ?? '',
  }),
);
console.log(`Internet client exported to ${output}/internet (not deployed)`);
