import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const realFs = require('fs').promises;

// Destination space is decided by statfs, so the guard is exercised with a
// reported free-space value instead of a filled disk. The mock has to be
// registered before the modules under test import node:fs/promises.
let available = 0n;
mock.module('node:fs/promises', {
  exports: { ...realFs, statfs: () => ({ bavail: available, bsize: 1n }) },
});

const { TransferReceiver } = await import('../src/transfer/receiver.js');
const { startReceiver } = await import('../src/server/app.js');

const digest = (data) => createHash('sha256').update(data).digest('hex');
const file = (id, relativePath, size, content = 'new') => ({
  id,
  type: 'file',
  relativePath,
  size,
  sha256: digest(content),
});
const manifest = (items) => ({ protocol: 1, operation: 'move', items });
const stream = (content) => {
  const request = Readable.from([Buffer.from(content)]);
  request.headers = { 'content-length': String(content.length) };
  return request;
};

function request(receiver, method, route, data) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port: receiver.port,
        path: route,
        method,
        rejectUnauthorized: false,
        headers: { Authorization: `Bearer ${receiver.session.token}` },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }),
        );
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

test('refuses a transfer bigger than the reported free space', async () => {
  const root = await realFs.mkdtemp(path.join(os.tmpdir(), 'phonehaul-space-'));
  try {
    available = 10n;
    const receiver = new TransferReceiver({ destination: root, conflict: 'rename' });
    await assert.rejects(
      () => receiver.create(manifest([file('a', 'x.bin', 11)])),
      (error) => {
        assert.equal(error.message, 'Not enough destination space');
        assert.equal(error.status, 507);
        assert.equal(error.available, '10');
        return true;
      },
    );
    assert.equal(receiver.transfer, null);
  } finally {
    await realFs.rm(root, { recursive: true, force: true });
  }
});

test('a transfer that exactly fits the free space is accepted', async () => {
  const root = await realFs.mkdtemp(path.join(os.tmpdir(), 'phonehaul-space-exact-'));
  try {
    available = 10n;
    const receiver = new TransferReceiver({ destination: root, conflict: 'rename' });
    const content = '0123456789';
    const t = await receiver.create(manifest([file('a', 'x.bin', 10, content)]));
    assert.equal(t.totalBytes, 10);
    const result = await receiver.upload(t.transferId, 'a', stream(content), digest(content));
    assert.equal(result.status, 'committed');
    assert.equal((await realFs.readFile(path.join(root, 'x.bin'))).toString(), content);
  } finally {
    await realFs.rm(root, { recursive: true, force: true });
  }
});

test('only queued file bytes count against the free space', async () => {
  const root = await realFs.mkdtemp(path.join(os.tmpdir(), 'phonehaul-space-skip-'));
  try {
    await realFs.writeFile(path.join(root, 'x'), 'same');
    await realFs.mkdir(path.join(root, 'sub'));
    await realFs.writeFile(path.join(root, 'sub', 'y'), 'diff');
    available = 1n;
    const receiver = new TransferReceiver({ destination: root, conflict: 'skip' });
    const t = await receiver.create(
      manifest([
        file('a', 'x', 4, 'same'),
        { id: 'b', type: 'directory', relativePath: 'sub' },
        file('c', 'sub/y', 4, 'same'),
      ]),
    );
    assert.equal(t.totalBytes, 0);
    assert.equal(t.items[0].status, 'already_present');
    assert.equal(t.items[2].status, 'skipped');
  } finally {
    await realFs.rm(root, { recursive: true, force: true });
  }
});

test('a late item that no longer fits is refused without moving the counters', async () => {
  const root = await realFs.mkdtemp(path.join(os.tmpdir(), 'phonehaul-space-item-'));
  try {
    available = 100n;
    const receiver = new TransferReceiver({ destination: root, conflict: 'rename' });
    const t = await receiver.create(manifest([file('a', 'x', 10, '0123456789')]));
    available = 5n;
    await assert.rejects(
      () => receiver.addItem(t.transferId, file('b', 'y', 6, '0123456')),
      (error) => {
        assert.equal(error.message, 'Not enough destination space');
        assert.equal(error.status, 507);
        assert.equal(error.available, undefined);
        return true;
      },
    );
    const summary = receiver.summary();
    assert.equal(summary.totalBytes, 10);
    assert.equal(summary.selectedBytes, 10);
    assert.equal(summary.items.length, 1);
  } finally {
    await realFs.rm(root, { recursive: true, force: true });
  }
});

test('the LAN API reports 507 with the available bytes, and without them for a late item', async () => {
  const root = await realFs.mkdtemp(path.join(os.tmpdir(), 'phonehaul-space-api-'));
  const settingsFile = path.join(root, 'settings.json');
  const destination = path.join(root, 'dest');
  try {
    await realFs.mkdir(destination);
    await realFs.writeFile(settingsFile, JSON.stringify({ destination, conflict: 'rename' }));
    available = 10n;
    const receiver = await startReceiver({ host: '127.0.0.1', transferPort: 0, settingsFile });
    try {
      assert.equal((await request(receiver, 'POST', '/api/session/connect')).status, 200);
      const refused = await request(
        receiver,
        'POST',
        '/api/transfers',
        JSON.stringify(manifest([file('a', 'x.bin', 11)])),
      );
      assert.equal(refused.status, 507);
      assert.deepEqual(refused.body, { error: 'Not enough destination space', available: '10' });

      const created = await request(
        receiver,
        'POST',
        '/api/transfers',
        JSON.stringify(manifest([file('b', 'y.bin', 1)])),
      );
      assert.equal(created.status, 201);
      available = 0n;
      const added = await request(
        receiver,
        'POST',
        `/api/transfers/${created.body.transferId}/items`,
        JSON.stringify({ id: 'c', type: 'file', relativePath: 'z.bin', size: 1 }),
      );
      assert.equal(added.status, 507);
      assert.deepEqual(added.body, { error: 'Not enough destination space' });
    } finally {
      await receiver.close();
    }
  } finally {
    await realFs.rm(root, { recursive: true, force: true });
  }
});
