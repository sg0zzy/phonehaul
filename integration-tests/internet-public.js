/* global window, document */
import { chromium, firefox } from '@playwright/test';
import { startReceiver } from '../receiver/src/server/app.js';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
// Explicit public-service smoke; creates temporary sessions and deletes them on success.
const service = new URL(process.env.PHONEHAUL_PUBLIC_TEST_ORIGIN ?? 'https://phonehaul.cecosl.ovh')
  .origin;
const root = await mkdtemp(`${tmpdir()}/phonehaul-public-`);
const destination = `${root}/received`;
await mkdir(destination);
await writeFile(`${root}/settings.json`, JSON.stringify({ destination, conflict: 'rename' }));
const native = await startReceiver({
  host: '127.0.0.1',
  transferPort: 0,
  settingsFile: `${root}/settings.json`,
});
let chrome, fox, owner, guest;
async function wait(page, selector, state = 'visible', timeout = 60000) {
  await page.locator(selector).waitFor({ state, timeout });
}
try {
  chrome = await chromium.launch({
    executablePath: process.env.PHONEHAUL_CHROMIUM ?? '/usr/bin/chromium',
    args: ['--no-sandbox'],
  });
  fox = await firefox.launch();
  owner = await (await chrome.newContext({ acceptDownloads: true })).newPage();
  guest = await (await fox.newContext({ acceptDownloads: true })).newPage();
  for (const page of [owner, guest])
    await page.addInitScript(() => {
      const Original = window.RTCPeerConnection;
      window.__pcs = [];
      window.RTCPeerConnection = class extends Original {
        constructor(...args) {
          super(...args);
          window.__pcs.push(this);
        }
      };
    });
  await owner.goto(`${native.uiUrl.replace(/\/$/, '')}/internet/`);
  await owner.locator('#service').fill(service);
  await owner.locator('#create').click();
  await wait(owner, '#invitation');
  const code = await owner.locator('#session-code').textContent();
  await guest.goto(`${service}/internet/`);
  await guest.locator('#code').fill(code);
  await guest.locator('#join').click();
  await Promise.all([wait(owner, '#verification'), wait(guest, '#verification')]);
  assert.equal(
    await owner.locator('#phrase').textContent(),
    await guest.locator('#phrase').textContent(),
  );
  await owner.locator('#approve').click();
  assert.equal(await owner.locator('#files').isVisible(), false);
  await guest.locator('#approve').click();
  await Promise.all([wait(owner, '#files'), wait(guest, '#files')]);
  const data = Buffer.alloc(512 * 1024, 73);
  const digest = createHash('sha256').update(data).digest('hex');
  await owner.locator('#picker').setInputFiles({
    name: 'public-forward.bin',
    mimeType: 'application/octet-stream',
    buffer: data,
  });
  await wait(guest, '#incoming');
  const downloaded = guest.waitForEvent('download');
  await guest.locator('#accept').click();
  const download = await downloaded;
  assert.equal(await download.failure(), null);
  assert.equal(
    createHash('sha256')
      .update(await readFile(await download.path()))
      .digest('hex'),
    digest,
  );
  await owner.waitForFunction(() =>
    document.querySelector('#progress-text').textContent.includes('download-handed-off'),
  );
  await guest.locator('#picker').setInputFiles({
    name: 'public-reverse.bin',
    mimeType: 'application/octet-stream',
    buffer: data,
  });
  await wait(owner, '#incoming');
  await owner.locator('#accept').click();
  await guest.waitForFunction(() =>
    document.querySelector('#progress-text').textContent.includes('committed'),
  );
  assert.equal(
    createHash('sha256')
      .update(await readFile(`${destination}/public-reverse.bin`))
      .digest('hex'),
    digest,
  );
  for (const [name, page] of [
    ['Chromium native bridge', owner],
    ['Firefox hosted client', guest],
  ]) {
    const result = await page.evaluate(async () => {
      const pc = window.__pcs.at(-1);
      const stats = await pc.getStats();
      const transport = [...stats.values()].find(
        (s) => s.type === 'transport' && s.selectedCandidatePairId,
      );
      const pair = transport
        ? stats.get(transport.selectedCandidatePairId)
        : [...stats.values()].find((s) => s.type === 'candidate-pair' && s.selected);
      const local = stats.get(pair?.localCandidateId),
        remote = stats.get(pair?.remoteCandidateId);
      return {
        ice: pc.iceConnectionState,
        local: local?.candidateType,
        remote: remote?.candidateType,
        protocol: local?.protocol,
        gatheredCandidateTypes: [
          ...new Set(
            [...pc.localDescription.sdp.matchAll(/ typ (host|srflx|prflx|relay)/g)].map(
              (m) => m[1],
            ),
          ),
        ],
      };
    });
    assert.notEqual(result.local, 'relay');
    assert.notEqual(result.remote, 'relay');
    assert.ok(result.gatheredCandidateTypes.includes('srflx'));
    console.log(name, JSON.stringify(result));
  }
  console.log(
    'PASS: public TLS/polling/CORS, complete phrase comparison, independent approvals, two 512 KiB copies with matching hashes, native commit, STUN srflx gathering; both peers are on the same workstation.',
  );
  await owner.locator('#leave').click();
} catch (error) {
  for (const page of [owner, guest])
    if (page)
      console.log(
        'Client state:',
        await page
          .locator('#status')
          .textContent()
          .catch(() => ''),
        await page
          .locator('#error')
          .textContent()
          .catch(() => ''),
      );
  throw error;
} finally {
  await chrome?.close();
  await fox?.close();
  await native.close();
  await rm(root, { recursive: true, force: true });
}
