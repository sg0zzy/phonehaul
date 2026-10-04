import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

// Plain CJS access gives the real fs/promises API without loading the ESM
// module 'node:fs/promises' before the mock below is registered.
const require = createRequire(import.meta.url);
const realFs = require('fs').promises;

const content = 'exfat payload';
const shaValue = require('crypto').createHash('sha256').update(content).digest('hex');

let linkCalls = 0;

test('commits with rename when link fails with EPERM (exFAT-like)', async (t) => {
  const root = await realFs.mkdtemp(path.join(os.tmpdir(), 'phonehaul-exfat-'));
  t.after(async () => {
    await realFs.rm(root, { recursive: true, force: true });
  });

  const mock = t.mock.module('node:fs/promises', {
    exports: {
      ...realFs,
      link: () => {
        linkCalls++;
        throw Object.assign(new Error('operation not permitted, link'), {
          code: 'EPERM',
        });
      },
    },
  });

  const { TransferReceiver } = await import('../src/transfer/receiver.js');
  const receiver = new TransferReceiver({ destination: root, conflict: 'rename' });
  const transfer = await receiver.create({
    protocol: 1,
    operation: 'move',
    items: [
      {
        id: 'a',
        type: 'file',
        relativePath: 'x',
        size: content.length,
        sha256: shaValue,
      },
    ],
  });
  const stream = Readable.from([Buffer.from(content)]);
  stream.headers = { 'content-length': String(content.length) };
  const res = await receiver.upload(transfer.transferId, 'a', stream, shaValue);
  assert.deepEqual(res, {
    status: 'committed',
    size: content.length,
    sha256: shaValue,
    destination: path.join(root, 'x'),
  });
  assert.equal(await realFs.readFile(path.join(root, 'x'), 'utf8'), content);
  assert.deepEqual(await realFs.readdir(path.join(root)), ['x']);
  assert.equal(linkCalls, 1, 'link was attempted and fell back to rename');
  mock.restore();
});
