import { test, expect, firefox } from '@playwright/test';
import { mkdtemp, readFile, open, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { internetConfig } from '../receiver/src/internet/config.js';
import { startSignaling } from '../receiver/src/internet/signaling.js';
import { startReceiver } from '../receiver/src/server/app.js';

let app, native, root;
test.beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-internet-browser-'));
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    path.join(root, 'settings.json'),
    JSON.stringify({ destination: path.join(root, 'received'), conflict: 'rename' }),
  );
  native = await startReceiver({
    host: '127.0.0.1',
    settingsFile: path.join(root, 'settings.json'),
  });
  app = await startSignaling({
    port: 0,
    config: internetConfig({
      PHONEHAUL_CONNECTIVITY_MODE: process.env.PHONEHAUL_TEST_TURN_URL
        ? 'turn-enabled'
        : 'stun-only',
    }),
    allowedOrigins: [new URL(native.uiUrl).origin],
    turn: {
      urls: process.env.PHONEHAUL_TEST_TURN_URL ? [process.env.PHONEHAUL_TEST_TURN_URL] : [],
      secret: process.env.PHONEHAUL_TEST_TURN_SECRET,
      maxSessions: 8,
    },
  });
});
test.afterAll(async () => {
  await app?.close();
  await native?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

async function pair(
  browser,
  nativeDestination = false,
  guestBrowser = browser,
  relay = false,
  ownerOrigin = app.url,
) {
  const ownerContext = await browser.newContext({ acceptDownloads: true });
  const guestContext = await guestBrowser.newContext({ acceptDownloads: true });
  const owner = await ownerContext.newPage(),
    guest = await guestContext.newPage();
  for (const page of [owner, guest])
    await page.addInitScript(() => {
      const Original = window.RTCPeerConnection;
      window.__phonehaulConnections = [];
      window.RTCPeerConnection = class extends Original {
        constructor(...args) {
          super(...args);
          window.__phonehaulConnections.push(this);
        }
      };
    });
  await owner.goto(`${ownerOrigin}/internet/`);
  await owner.locator('#service').fill(app.url);
  if (relay) await owner.locator('#relay').check();
  await owner.locator('#create').click();
  await expect(owner.locator('#session-code')).not.toBeEmpty();
  const code = await owner.locator('#session-code').textContent();
  await guest.goto(`${nativeDestination ? native.uiUrl.replace(/\/$/, '') : app.url}/internet/`);
  await guest.locator('#service').fill(app.url);
  if (relay) await guest.locator('#relay').check();
  await guest.locator('#code').fill(code);
  await guest.locator('#join').click();
  try {
    await expect(owner.locator('#verification')).toBeVisible({ timeout: 40_000 });
    await expect(guest.locator('#verification')).toBeVisible({ timeout: 40_000 });
  } catch (e) {
    for (const page of [owner, guest])
      console.log(
        'Connection diagnostics:',
        await page.locator('#status').textContent(),
        await page.locator('#error').textContent(),
        await page.evaluate(() =>
          window.__phonehaulConnections.map((c) => ({
            connection: c.connectionState,
            ice: c.iceConnectionState,
            gathering: c.iceGatheringState,
          })),
        ),
      );
    throw e;
  }
  expect(await owner.locator('#phrase').textContent()).toBe(
    await guest.locator('#phrase').textContent(),
  );
  await owner.locator('#approve').click();
  await expect(owner.locator('#files')).toBeHidden();
  await guest.locator('#approve').click();
  await expect(owner.locator('#files')).toBeVisible();
  await expect(guest.locator('#files')).toBeVisible();
  if (!relay) {
    for (const page of [owner, guest]) {
      await expect(page.locator('#diagnostics')).toContainText(/host|srflx|prflx/);
      await expect(page.locator('#diagnostics')).not.toContainText('relay');
      await expect(page.locator('#relay-option')).toBeHidden();
    }
  }
  return {
    owner,
    guest,
    close: async () => {
      await ownerContext.close();
      await guestContext.close();
    },
  };
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

test('separate client hosting retains the trusted origin in invitations', async ({ browser }) => {
  const clientHost = await startSignaling({ port: 0 });
  let peers;
  try {
    peers = await pair(browser, false, browser, false, clientHost.url);
    const invitation = new URL(await peers.owner.locator('#share').getAttribute('href'));
    expect(invitation.origin).toBe(clientHost.url);
    expect(new URLSearchParams(invitation.hash.slice(1)).get('service')).toBe(app.url);
  } finally {
    await peers?.close();
    await clientHost.close();
  }
});

test('Chromium and Firefox interoperate over a verified DataChannel', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Mixed-engine case runs once');
  const other = await firefox.launch({ executablePath: firefox.executablePath(), args: [] });
  const peers = await pair(browser, false, other);
  try {
    await peers.owner.locator('#picker').setInputFiles({
      name: 'mixed.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('cross browser'),
    });
    await expect(peers.guest.locator('#incoming')).toBeVisible();
    const download = peers.guest.waitForEvent('download');
    await peers.guest.locator('#accept').click();
    expect(await readFile(await (await download).path(), 'utf8')).toBe('cross browser');
  } finally {
    await peers.close();
    await other.close();
  }
});

test('forced TURN carries file data through relay candidates', async ({ browser }) => {
  test.skip(
    !process.env.PHONEHAUL_TEST_TURN_URL,
    'Requires an explicitly configured test TURN service',
  );
  const peers = await pair(browser, false, browser, true);
  try {
    await peers.owner.locator('#picker').setInputFiles({
      name: 'relay.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('relayed copy'),
    });
    await expect(peers.guest.locator('#incoming')).toBeVisible();
    const download = peers.guest.waitForEvent('download');
    await peers.guest.locator('#accept').click();
    expect(await readFile(await (await download).path(), 'utf8')).toBe('relayed copy');
    for (const page of [peers.owner, peers.guest]) {
      const candidateType = await page.evaluate(async () => {
        const stats = await window.__phonehaulConnections.at(-1).getStats();
        const transport = [...stats.values()].find(
          (s) => s.type === 'transport' && s.selectedCandidatePairId,
        );
        const selected = stats.get(transport.selectedCandidatePairId);
        return stats.get(selected.localCandidateId).candidateType;
      });
      expect(candidateType).toBe('relay');
    }
  } finally {
    await peers.close();
  }
});

test('two browsers pair with independent approval and exchange verified streaming downloads in both directions', async ({
  browser,
}) => {
  const peers = await pair(browser);
  try {
    for (const [sender, receiver, text] of [
      [peers.owner, peers.guest, 'from owner'],
      [peers.guest, peers.owner, 'from guest'],
      [peers.owner, peers.guest, ''],
    ]) {
      await sender
        .locator('#picker')
        .setInputFiles({ name: 'copy.txt', mimeType: 'text/plain', buffer: Buffer.from(text) });
      await expect(receiver.locator('#incoming')).toBeVisible();
      const downloaded = receiver.waitForEvent('download');
      await receiver.locator('#accept').click();
      const download = await downloaded;
      const downloadedPath = await download.path();
      expect(await download.failure()).toBeNull();
      expect(await readFile(downloadedPath, 'utf8')).toBe(text);
      await expect(sender.locator('#progress-text')).toContainText('download-handed-off');
    }
  } finally {
    await peers.close();
  }
});

test('approved peers reconnect with pinned identity and retry a file from the beginning', async ({
  browser,
}) => {
  const peers = await pair(browser);
  try {
    await peers.owner.evaluate(() => window.__phonehaulConnections.at(-1).close());
    await expect(peers.owner.locator('#retry')).toBeVisible();
    await peers.owner.locator('#retry').click();
    await expect(peers.owner.locator('#files')).toBeVisible({ timeout: 40_000 });
    await expect(peers.guest.locator('#files')).toBeVisible({ timeout: 40_000 });
    await expect(peers.owner.locator('#verification')).toBeHidden();
    await peers.owner.locator('#picker').setInputFiles({
      name: 'retry.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('new complete copy'),
    });
    await expect(peers.guest.locator('#incoming')).toBeVisible();
    const download = peers.guest.waitForEvent('download');
    await peers.guest.locator('#accept').click();
    expect(await readFile(await (await download).path(), 'utf8')).toBe('new complete copy');
  } finally {
    await peers.close();
  }
});

test('browser sends a verified copy to the native receiver destination', async ({ browser }) => {
  const peers = await pair(browser, true);
  try {
    await peers.owner.locator('#picker').setInputFiles({
      name: 'native-copy.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('native commit'),
    });
    await expect(peers.guest.locator('#incoming')).toBeVisible();
    await peers.guest.locator('#accept').click();
    await expect(peers.owner.locator('#progress-text')).toContainText('committed');
    expect(await readFile(path.join(root, 'received', 'native-copy.txt'), 'utf8')).toBe(
      'native commit',
    );
  } finally {
    await peers.close();
  }
});

test('large browser transfer streams without whole-file buffering', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(15 * 60_000);
  const size = Number(process.env.PHONEHAUL_LARGE_TEST_BYTES ?? 2 * 1024 ** 2);
  const source = path.join(root, 'large.bin');
  const file = await open(source, 'w');
  await file.truncate(size);
  await file.close();
  const peers = await pair(browser);
  const cdp = browserName === 'chromium' ? await browser.newBrowserCDPSession() : null;
  let peak = 0;
  async function memory() {
    if (!cdp) return;
    const info = await cdp.send('SystemInfo.getProcessInfo');
    let rss = 0;
    for (const process of info.processInfo) {
      const text = await readFile(`/proc/${process.id}/status`, 'utf8').catch(() => '');
      rss += Number(/^VmRSS:\s+(\d+)/m.exec(text)?.[1] ?? 0) * 1024;
    }
    peak = Math.max(peak, rss);
    return rss;
  }
  const baseline = (await memory()) ?? 0;
  const sampler = setInterval(() => {
    memory().catch(() => {});
  }, 500);
  try {
    await peers.owner.locator('#picker').setInputFiles(source);
    await expect(peers.guest.locator('#incoming')).toBeVisible();
    const downloaded = peers.guest.waitForEvent('download', { timeout: 60_000 });
    await peers.guest.locator('#accept').click();
    const download = await downloaded;
    const downloadedPath = await download.path();
    expect(await download.failure()).toBeNull();
    expect(await digest(downloadedPath)).toBe(await digest(source));
    await memory();
    if (cdp) {
      console.log(
        `Streaming ${size} bytes: browser process RSS baseline=${baseline}, peak=${peak}, growth=${peak - baseline}`,
      );
      expect(peak - baseline).toBeLessThan(512 * 1024 ** 2);
    }
    await expect(peers.owner.locator('#progress-text')).toContainText('download-handed-off');
  } finally {
    clearInterval(sampler);
    await cdp?.detach();
    await peers.close();
  }
});

test('signaling outage leaves an approved direct DataChannel usable', async ({ browser }) => {
  const peers = await pair(browser);
  try {
    for (const page of [peers.owner, peers.guest])
      await page.route('**/v1/**', (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: '{"error":"Test outage"}',
        }),
      );
    await expect(peers.owner.locator('#error')).toContainText('Test outage');
    await peers.owner.locator('#picker').setInputFiles({
      name: 'outage.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('still direct'),
    });
    await expect(peers.guest.locator('#incoming')).toBeVisible();
    const downloaded = peers.guest.waitForEvent('download');
    await peers.guest.locator('#accept').click();
    expect(await readFile(await (await downloaded).path(), 'utf8')).toBe('still direct');
  } finally {
    await peers.close();
  }
});

test('a peer without connectivity reaches a bounded direct failure without relay fallback', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const guestContext = await browser.newContext();
  const owner = await context.newPage(),
    guest = await guestContext.newPage();
  try {
    await owner.addInitScript(() => {
      const schedule = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms, ...args) => schedule(fn, ms === 60_000 ? 3000 : ms, ...args);
      const Original = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Original {
        constructor(config) {
          super({ ...config, iceTransportPolicy: 'relay', iceServers: [] });
          window.__connectionCreated = true;
        }
      };
    });
    await owner.goto(`${app.url}/internet/`);
    await owner.locator('#create').click();
    await expect(owner.locator('#session-code')).not.toBeEmpty();
    await guest.goto(`${app.url}/internet/`);
    await guest.locator('#code').fill(await owner.locator('#session-code').textContent());
    await guest.locator('#join').click();
    await expect(owner.locator('#status')).toContainText('Establishing', { timeout: 15_000 });
    // Exercise the connection deadline with a shortened timer and no usable candidates.
    await expect.poll(() => owner.evaluate(() => window.__connectionCreated)).toBe(true);
    await expect(owner.locator('#error')).toContainText('Direct connection unavailable');
    await expect(owner.locator('#files')).toBeHidden();
    await expect(owner.locator('#relay-option')).toBeHidden();
  } finally {
    await context.close();
    await guestContext.close();
  }
});
