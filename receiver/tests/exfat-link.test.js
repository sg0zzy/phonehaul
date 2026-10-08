import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

// Plain CJS access gives the real fs/promises API without loading the ESM
// module 'node:fs/promises' before the mock below is registered.
const require = createRequire(import.meta.url);
const realFs = require('fs').promises;
const digest = (data) => require('crypto').createHash('sha256').update(data).digest('hex');

const content = 'exfat payload';

let linkCode = 'EPERM';
let linkCalls = 0;
let reserveAttempts = 0;
// 'real' reserves normally, 'eexist' always reports a conflict, 'race' lets
// another process create the file and then reports the conflict.
let reserveMode = 'real';

mock.module('node:fs/promises', {
  exports: {
    ...realFs,
    link: () => {
      linkCalls++;
      throw Object.assign(new Error(`link is not permitted (${linkCode})`), { code: linkCode });
    },
    open: (target, flags) => {
      if (flags !== 'wx') return realFs.open(target, flags);
      reserveAttempts++;
      if (reserveMode === 'real') return realFs.open(target, flags);
      if (reserveMode === 'race')
        return realFs.writeFile(target, 'created by another process').then(() => {
          throw Object.assign(new Error('file exists, open failed'), { code: 'EEXIST' });
        });
      throw Object.assign(new Error('file exists, open failed'), { code: 'EEXIST' });
    },
  },
});

const { TransferReceiver } = await import('../src/transfer/receiver.js');

async function run(t, conflict, setup = () => {}) {
  const root = await realFs.mkdtemp(path.join(os.tmpdir(), 'phonehaul-exfat-'));
  t.after(async () => {
    await realFs.rm(root, { recursive: true, force: true });
  });
  linkCode = 'EPERM';
  linkCalls = 0;
  reserveAttempts = 0;
  reserveMode = 'real';
  setup();
  const receiver = new TransferReceiver({ destination: root, conflict });
  const transfer = await receiver.create({
    protocol: 1,
    operation: 'move',
    items: [
      { id: 'a', type: 'file', relativePath: 'x', size: content.length, sha256: digest(content) },
    ],
  });
  const stream = Readable.from([Buffer.from(content)]);
  stream.headers = { 'content-length': String(content.length) };
  const outcome = { receiver, transfer, root };
  try {
    outcome.result = await receiver.upload(transfer.transferId, 'a', stream, digest(content));
  } catch (error) {
    outcome.error = error;
  }
  return outcome;
}

test('commits with rename when link fails with EPERM (exFAT-like)', async (t) => {
  const { receiver, root, result } = await run(t, 'rename');
  assert.deepEqual(result, {
    status: 'committed',
    size: content.length,
    sha256: digest(content),
    destination: path.join(root, 'x'),
  });
  assert.equal(await realFs.readFile(path.join(root, 'x'), 'utf8'), content);
  assert.deepEqual(await realFs.readdir(path.join(root)), ['x']);
  assert.equal(linkCalls, 1, 'link was attempted and fell back to rename');
  assert.equal(reserveAttempts, 1);
  assert.equal(receiver.summary().items[0].status, 'committed');
});

test('ENOTSUP and EXDEV also fall back to rename', async (t) => {
  for (const code of ['ENOTSUP', 'EXDEV']) {
    const { root, result } = await run(t, 'rename', () => {
      linkCode = code;
    });
    assert.equal(result.status, 'committed', code);
    assert.equal(await realFs.readFile(path.join(root, 'x'), 'utf8'), content, code);
    assert.equal(linkCalls, 1, code);
  }
});

test('a link failure that is not an unsupported-filesystem code propagates', async (t) => {
  const { receiver, root, error } = await run(t, 'rename', () => {
    linkCode = 'EACCES';
  });
  assert.equal(error.code, 'EACCES');
  assert.equal(receiver.summary().items[0].status, 'failed');
  assert.deepEqual(await realFs.readdir(root), [], 'the partial is removed on failure');
});

test('the rename fallback gives up at the conflict limit', async (t) => {
  const { receiver, root, error } = await run(t, 'rename', () => {
    reserveMode = 'eexist';
  });
  assert.match(error.message, /Too many filename conflicts/);
  assert.equal(reserveAttempts, 100, 'the loop stops at the 100th conflict attempt');
  assert.equal(receiver.summary().items[0].status, 'failed');
  assert.deepEqual(await realFs.readdir(root), []);
});

test('a file that appears during the reserve loop is not overwritten under skip', async (t) => {
  const { receiver, root, result } = await run(t, 'skip', () => {
    reserveMode = 'race';
  });
  assert.deepEqual(result, { status: 'skipped' });
  assert.equal(receiver.summary().items[0].status, 'skipped');
  assert.equal(await realFs.readFile(path.join(root, 'x'), 'utf8'), 'created by another process');
  assert.deepEqual(await realFs.readdir(root), ['x']);
});
