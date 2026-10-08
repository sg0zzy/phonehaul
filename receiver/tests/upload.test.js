import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { TransferReceiver } from '../src/transfer/receiver.js';

const digest = (data) => createHash('sha256').update(data).digest('hex');
const file = (id, relativePath, size, content = 'new') => ({
  id,
  type: 'file',
  relativePath,
  size,
  sha256: digest(content),
});
const manifest = (items) => ({ protocol: 1, operation: 'copy', items });
const stream = (content, declaredLength = content.length) => {
  const request = Readable.from([Buffer.from(content)]);
  request.headers = { 'content-length': String(declaredLength) };
  return request;
};
const partials = async (root) =>
  (await readdir(root)).filter((name) => name.endsWith('.phonehaul-partial'));

test('the PUT acknowledgement reports size, hash and destination', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-upload-ack-'));
  try {
    const receiver = new TransferReceiver({ destination: root, conflict: 'rename' });
    const t = await receiver.create(manifest([file('a', 'a.bin', 3, 'new')]));
    const result = await receiver.upload(t.transferId, 'a', stream('new'), digest('new'));
    assert.deepEqual(result, {
      status: 'committed',
      size: 3,
      sha256: digest('new'),
      destination: path.join(root, 'a.bin'),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('upload refuses a transfer that is finished or cancelled', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-upload-closed-'));
  try {
    const receiver = new TransferReceiver({ destination: root, conflict: 'rename' });
    const t = await receiver.create(manifest([file('a', 'a.bin', 3, 'new')]));
    await assert.rejects(
      () => receiver.upload('not-a-transfer', 'a', stream('new'), digest('new')),
      /Invalid transfer/,
    );
    await receiver.upload(t.transferId, 'a', stream('new'), digest('new'));
    await receiver.finish(t.transferId);
    await assert.rejects(
      () => receiver.upload(t.transferId, 'a', stream('new'), digest('new')),
      /Invalid transfer/,
    );
    assert.throws(() => receiver.cancel('other-transfer'), /Invalid transfer/);
    receiver.cancel(t.transferId);
    await assert.rejects(
      () => receiver.upload(t.transferId, 'a', stream('new'), digest('new')),
      /Invalid transfer/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('upload refuses a directory item and a file that is no longer queued', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-upload-state-'));
  try {
    const receiver = new TransferReceiver({ destination: root, conflict: 'rename' });
    const t = await receiver.create(
      manifest([
        { id: 'd', type: 'directory', relativePath: 'sub' },
        file('a', 'sub/a.bin', 3, 'new'),
      ]),
    );
    await assert.rejects(
      () => receiver.upload(t.transferId, 'd', stream('new'), digest('new')),
      /Invalid file state/,
    );
    await assert.rejects(
      () => receiver.upload(t.transferId, 'missing', stream('new'), digest('new')),
      /Invalid file state/,
    );
    const result = await receiver.upload(t.transferId, 'a', stream('new'), digest('new'));
    assert.equal(result.status, 'committed');
    await assert.rejects(
      () => receiver.upload(t.transferId, 'a', stream('new'), digest('new')),
      /Invalid file state/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a declared SHA-256 must match the header exactly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-upload-hash-'));
  try {
    const receiver = new TransferReceiver({ destination: root, conflict: 'rename' });
    const t = await receiver.create(manifest([file('a', 'a.bin', 3, 'new')]));
    await assert.rejects(
      () => receiver.upload(t.transferId, 'a', stream('new'), digest('other')),
      /SHA-256 does not match manifest/,
    );
    await assert.rejects(
      () => receiver.upload(t.transferId, 'a', stream('new'), 'zz'),
      /SHA-256 does not match manifest/,
    );
    await assert.rejects(
      () => receiver.upload(t.transferId, 'a', stream('new')),
      /SHA-256 does not match manifest/,
    );
    const noHash = await receiver.create({
      protocol: 1,
      operation: 'copy',
      items: [{ id: 'b', type: 'file', relativePath: 'b.bin', size: 3 }],
    });
    await assert.rejects(
      () => receiver.upload(noHash.transferId, 'b', stream('new'), digest('new')),
      /Unexpected SHA-256 header/,
    );
    await assert.rejects(
      () => receiver.upload(noHash.transferId, 'b', stream('new', 4)),
      /Content-Length mismatch/,
    );
    assert.equal(noHash.items[0].status, 'queued');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a stream longer than the declared size fails without leaving a partial', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-upload-size-'));
  try {
    const receiver = new TransferReceiver({ destination: root, conflict: 'rename' });
    const t = await receiver.create(manifest([file('a', 'a.bin', 3, 'new')]));
    await assert.rejects(
      () => receiver.upload(t.transferId, 'a', stream('newx', 3), digest('new')),
      /Size mismatch/,
    );
    assert.equal(receiver.summary().items[0].status, 'failed');
    assert.equal(receiver.summary().receivedBytes, 0);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('content that does not match the declared hash never reaches the destination', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-upload-mismatch-'));
  try {
    const receiver = new TransferReceiver({ destination: root, conflict: 'rename' });
    const t = await receiver.create(manifest([file('a', 'a.bin', 3, 'new')]));
    await assert.rejects(
      () => receiver.upload(t.transferId, 'a', stream('bad'), digest('new')),
      /SHA-256 mismatch/,
    );
    assert.equal(receiver.summary().items[0].status, 'failed');
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an in-flight upload blocks a second upload and finish', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-upload-busy-'));
  try {
    let notify;
    const sending = new Promise((resolve) => {
      notify = resolve;
    });
    const receiver = new TransferReceiver({ destination: root, conflict: 'rename' }, (event) => {
      if (event.currentItem) notify(event);
    });
    const t = await receiver.create(
      manifest([file('a', 'a.bin', 3, 'new'), file('b', 'b.bin', 3, 'new')]),
    );
    const hanging = new Readable({ read() {} });
    hanging.headers = { 'content-length': '3' };
    const inFlight = receiver.upload(t.transferId, 'a', hanging, digest('new'));
    assert.equal((await sending).currentItem, 'a.bin');
    assert.equal(receiver.summary().items[0].status, 'sending');
    await assert.rejects(
      () => receiver.upload(t.transferId, 'b', stream('new'), digest('new')),
      /Invalid file state/,
    );
    assert.throws(() => receiver.finish(t.transferId), /Invalid transfer/);
    receiver.cancel(t.transferId);
    await assert.rejects(inFlight, /Cancelled/);
    assert.equal(receiver.summary().items[0].status, 'failed');
    assert.equal(receiver.summary().currentItem, null);
    assert.deepEqual(await partials(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
