import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function buildInternetAssets() {
  const root = new URL('../src/internet/web/', import.meta.url);
  const client = await build({
    entryPoints: [fileURLToPath(new URL('client.js', root))],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: ['chrome110', 'firefox115'],
    write: false,
    legalComments: 'inline',
  });
  return {
    '/internet/': {
      type: 'text/html; charset=utf-8',
      body: await readFile(new URL('index.html', root), 'utf8'),
    },
    '/internet/client.js': {
      type: 'text/javascript; charset=utf-8',
      body: client.outputFiles[0].text,
    },
    '/internet/sw.js': {
      type: 'text/javascript; charset=utf-8',
      body: await readFile(new URL('sw.js', root), 'utf8'),
    },
  };
}

export const internetAssetsPlugin = {
  name: 'phonehaul-internet-assets',
  setup(builder) {
    builder.onLoad({ filter: /[/\\]src[/\\]internet[/\\]assets\.js$/ }, async () => ({
      contents: `export async function loadInternetAssets() { return ${JSON.stringify(await buildInternetAssets())}; }`,
      loader: 'js',
    }));
  },
};
