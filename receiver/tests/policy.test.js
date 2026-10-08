import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { symlink, mkdir, readFile, readdir, writeFile, mkdtemp, rm, lstat } from 'node:fs/promises';
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
const manifest = (items) => ({ protocol: 1, operation: 'move', items });
const stream = (content) => {
  const request = Readable.from([Buffer.from(content)]);
  request.headers = { 'content-length': String(content.length) };
  return request;
};
const partials = async (root) =>
  (await readdir(root)).filter((name) => name.endsWith('.phonehaul-partial'));

test('replace overwrites the existing file and reports the original name', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-replace-'));
  try {
    await writeFile(path.join(root, 'photo.jpg'), 'old');
    const receiver = new TransferReceiver({ destination: root, conflict: 'replace' });
    const t = await receiver.create(manifest([file('a', 'photo.jpg', 3, 'new')]));
    const result = await receiver.upload(t.transferId, 'a', stream('new'), digest('new'));
    assert.equal(result.status, 'committed');
    assert.equal(result.destination, path.join(root, 'photo.jpg'));
    assert.equal(result.size, 3);
    assert.equal(result.sha256, digest('new'));
    assert.equal(await readFile(path.join(root, 'photo.jpg'), 'utf8'), 'new');
    assert.deepEqual(await partials(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('replace refuses a symlinked destination and leaves the linked file alone', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-replace-symlink-'));
  try {
    await mkdir(path.join(root, 'outside'));
    await writeFile(path.join(root, 'outside', 'secret'), 'keep');
    await symlink(path.join(root, 'outside', 'secret'), path.join(root, 'link'));
    const receiver = new TransferReceiver({ destination: root, conflict: 'replace' });
    const t = await receiver.create(manifest([file('a', 'link', 3, 'new')]));
    await assert.rejects(
      () => receiver.upload(t.transferId, 'a', stream('new'), digest('new')),
      /Cannot replace this destination/,
    );
    assert.equal(receiver.summary().items[0].status, 'failed');
    assert.ok((await lstat(path.join(root, 'link'))).isSymbolicLink());
    assert.equal(await readFile(path.join(root, 'link'), 'utf8'), 'keep');
    assert.deepEqual(await partials(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('replace refuses a destination that is a directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-replace-dir-'));
  try {
    await mkdir(path.join(root, 'folder'));
    const receiver = new TransferReceiver({ destination: root, conflict: 'replace' });
    const t = await receiver.create(manifest([file('a', 'folder', 3, 'new')]));
    await assert.rejects(
      () => receiver.upload(t.transferId, 'a', stream('new'), digest('new')),
      /Cannot replace this destination/,
    );
    assert.deepEqual(await readdir(root), ['folder']);
    assert.deepEqual(await partials(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skip keeps an existing file when the manifest declares no hash', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-skip-nohash-'));
  try {
    await writeFile(path.join(root, 'x'), 'old');
    const receiver = new TransferReceiver({ destination: root, conflict: 'skip' });
    const t = await receiver.create({
      protocol: 1,
      operation: 'move',
      items: [{ id: 'a', type: 'file', relativePath: 'x', size: 3 }],
    });
    const result = await receiver.upload(t.transferId, 'a', stream('new'));
    assert.deepEqual(result, { status: 'skipped' });
    assert.equal(await readFile(path.join(root, 'x'), 'utf8'), 'old');
    assert.deepEqual(await partials(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
