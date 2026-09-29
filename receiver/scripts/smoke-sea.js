import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { localAddress } from '../src/security/pairing.js';

const receiverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = path.dirname(receiverDir);
const platformName = { win32: 'windows', darwin: 'macos' }[process.platform] ?? process.platform;
const executable = path.join(rootDir, 'dist', `phonehaul-${platformName}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`);
const temporary = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-sea-smoke-'));
const host = localAddress();
let child;

async function reservePort() {
  const server = net.createServer();
  server.listen(0, host);
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function getPage(url) {
  return new Promise((resolve, reject) => http.get(url, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
  }).on('error', reject));
}

try {
  const transferPort = await reservePort();
  await writeFile(path.join(temporary, 'settings.json'), JSON.stringify({ destination: path.join(temporary, 'received'), conflict: 'rename' }));
  child = spawn(executable, [], { env: { ...process.env, PHONEHAUL_TRANSFER_PORT: String(transferPort), PHONEHAUL_SETTINGS_FILE: path.join(temporary, 'settings.json'), PHONEHAUL_NO_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  let uiUrl;
  const deadline = Date.now() + 20_000;
  while (!uiUrl && Date.now() < deadline) {
    const match = output.match(/UI (http:\/\/127\.0\.0\.1:\d+\/)/);
    uiUrl = match?.[1];
    if (!uiUrl && child.exitCode !== null) throw new Error(`Packaged receiver exited early:\n${output}`);
    if (!uiUrl) await delay(50);
  }
  assert.ok(uiUrl, `Packaged receiver did not report its local UI URL:\n${output}`);
  const page = await getPage(uiUrl);
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>PhoneHaul Receiver<\/title>/);
  assert.match(page.body, /new EventSource\('\/api\/events'\)/);
  assert.match(output, /LAN transfers: enabled/);

  child.kill('SIGTERM');
  const [code] = await Promise.race([once(child, 'exit'), delay(8_000).then(() => { throw new Error('Packaged receiver did not shut down after SIGTERM'); })]);
  assert.equal(code, 0, output);
  console.log('SEA smoke test passed (startup, bundled UI, LAN listener, graceful shutdown).');
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  await rm(temporary, { recursive: true, force: true });
}
