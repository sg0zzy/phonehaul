import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { relativePath, safeParent } from '../src/security/paths.js';
import { PairingSession, localAddress } from '../src/security/pairing.js';
import { validateManifest } from '../src/transfer/manifest.js';
import { TransferReceiver } from '../src/transfer/receiver.js';

const file = (id, relativePath, size, content = 'new') => ({
  id,
  type: 'file',
  relativePath,
  size,
  sha256: digest(content),
});
const manifest = (items) => ({ protocol: 1, operation: 'move', items });
const digest = (data) => createHash('sha256').update(data).digest('hex');

test('rejects traversal and absolute paths', () => {
  for (const value of [
    '../etc/passwd',
    'a/../b',
    '/root/file',
    'C:\\Windows\\a',
    'a//b',
    'a/./b',
    'a\\b',
  ])
    assert.throws(() => relativePath(value));
  assert.equal(relativePath('DCIM/Camera/video.mp4'), 'DCIM/Camera/video.mp4');
});

test('rejects symlink destination parent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-path-'));
  await symlink(os.tmpdir(), path.join(root, 'escape'));
  await assert.rejects(() => safeParent(root, 'escape/file'), /Unsafe/);
});

test('manifest validates unique paths, ids, and sizes', () => {
  assert.throws(() => validateManifest(manifest([file('a', '../bad', 1)])));
  assert.throws(() => validateManifest(manifest([file('a', 'x', 1), file('b', 'x', 2)])));
  assert.throws(() => validateManifest(manifest([file('a', 'x', -1)])));
  assert.equal(validateManifest(manifest([file('a', 'x', 1)])).totalBytes, 1);
});

test('unused pairing expires and connected pairing remains valid', () => {
  let now = 0;
  const session = new PairingSession(() => now);
  assert.equal(session.token.length, 43);
  now = 300_001;
  assert.equal(session.expired(), true);
  assert.equal(session.connect(session.token), false);
  now = 0;
  const connected = new PairingSession(() => now);
  assert.equal(connected.connect(connected.token), true);
  now = 600_000;
  assert.equal(connected.expired(), false);
  assert.equal(connected.valid(connected.token), true);
  assert.equal(connected.valid('wrong'), false);
});

test('prefers a physical LAN interface over virtual adapters', () => {
  const entry = (address) => ({ family: 'IPv4', internal: false, address });
  assert.equal(
    localAddress({
      docker0: [entry('172.17.0.1')],
      wlp3s0: [entry('192.168.1.20')],
      tailscale0: [entry('100.100.100.100')],
    }),
    '192.168.1.20',
  );
});

test('commits verified data and renames collisions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-transfer-'));
  await writeFile(path.join(root, 'video.mp4'), 'existing');
  const receiver = new TransferReceiver({ destination: root, conflict: 'rename' });
  const t = await receiver.create(manifest([file('a', 'video.mp4', 3)]));
  const stream = Readable.from([Buffer.from('new')]);
  stream.headers = { 'content-length': '3' };
  const result = await receiver.upload(t.transferId, 'a', stream, digest('new'));
  assert.equal(result.status, 'committed');
  assert.equal(await readFile(path.join(root, 'video (1).mp4'), 'utf8'), 'new');
  assert.deepEqual(
    (await readdir(root)).filter((x) => x.endsWith('.phonehaul-partial')),
    [],
  );
});

test('appends files and verifies streamed hashes before reporting a matching destination', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-incremental-'));
  const receiver = new TransferReceiver({ destination: root, conflict: 'rename' });
  const first = await receiver.create(
    manifest([{ id: 'a', type: 'file', relativePath: 'Screenshots/one.png', size: 3 }]),
  );
  const stream = Readable.from([Buffer.from('one')]);
  stream.headers = { 'content-length': '3' };
  assert.equal((await receiver.upload(first.transferId, 'a', stream)).sha256, digest('one'));
  assert.equal(
    (
      await receiver.addItem(first.transferId, {
        id: 'b',
        type: 'file',
        relativePath: 'Screenshots/two.png',
        size: 3,
      })
    ).status,
    'queued',
  );
  const second = Readable.from([Buffer.from('two')]);
  second.headers = { 'content-length': '3' };
  assert.equal((await receiver.upload(first.transferId, 'b', second)).status, 'committed');
  assert.equal(receiver.finish(first.transferId).completedItems, 2);
  assert.equal(await readFile(path.join(root, 'Screenshots', 'two.png'), 'utf8'), 'two');
  const retry = await receiver.create(
    manifest([{ id: 'retry', type: 'file', relativePath: 'Screenshots/one.png', size: 3 }]),
  );
  const duplicate = Readable.from([Buffer.from('one')]);
  duplicate.headers = { 'content-length': '3' };
  assert.equal(
    (await receiver.upload(retry.transferId, 'retry', duplicate)).status,
    'already_present',
  );
  assert.deepEqual(await readdir(path.join(root, 'Screenshots')), ['one.png', 'two.png']);
});

test('hash mismatch leaves source destination untouched and cleans partial', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-hash-'));
  const receiver = new TransferReceiver({ destination: root, conflict: 'rename' });
  const t = await receiver.create(manifest([file('a', 'x', 3, 'good')]));
  const stream = Readable.from([Buffer.from('bad')]);
  stream.headers = { 'content-length': '3' };
  await assert.rejects(
    () => receiver.upload(t.transferId, 'a', stream, digest('good')),
    /SHA-256 mismatch/,
  );
  assert.deepEqual(await readdir(root), []);
  assert.equal(receiver.summary().receivedBytes, 0);
});

test('size mismatch leaves no committed file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-size-'));
  const receiver = new TransferReceiver({ destination: root, conflict: 'rename' });
  const t = await receiver.create(manifest([file('a', 'x', 5, 'abc')]));
  const stream = Readable.from([Buffer.from('abc')]);
  stream.headers = { 'content-length': '5' };
  await assert.rejects(
    () => receiver.upload(t.transferId, 'a', stream, digest('abc')),
    /Size mismatch/,
  );
  assert.deepEqual(await readdir(root), []);
});

test('cancellation preserves already committed files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-cancel-'));
  const receiver = new TransferReceiver({ destination: root, conflict: 'rename' });
  const t = await receiver.create(
    manifest([file('a', 'done', 3, 'yes'), file('b', 'pending', 4, 'wait')]),
  );
  const stream = Readable.from([Buffer.from('yes')]);
  stream.headers = { 'content-length': '3' };
  await receiver.upload(t.transferId, 'a', stream, digest('yes'));
  const result = receiver.cancel(t.transferId);
  assert.equal(result.cancelled, true);
  assert.equal(result.completedItems, 1);
  assert.equal(await readFile(path.join(root, 'done'), 'utf8'), 'yes');
  assert.deepEqual(await readdir(root), ['done']);
});

test('cannot finish a manifest with unsent files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-unsent-'));
  const receiver = new TransferReceiver({ destination: root, conflict: 'rename' });
  const t = await receiver.create(manifest([file('a', 'pending', 1)]));
  assert.throws(() => receiver.finish(t.transferId), /unsent/);
});

test('skip never reports committed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-skip-'));
  await writeFile(path.join(root, 'x'), 'old');
  const receiver = new TransferReceiver({ destination: root, conflict: 'skip' });
  const t = await receiver.create(manifest([file('a', 'x', 3)]));
  assert.equal(t.items.find((item) => item.id === 'a').status, 'skipped');
  assert.equal(receiver.summary().completedItems, 0);
  assert.equal(await readFile(path.join(root, 'x'), 'utf8'), 'old');
});

test('streamed hash can prove an identical destination under skip policy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-stream-skip-'));
  await writeFile(path.join(root, 'x'), 'same');
  const receiver = new TransferReceiver({ destination: root, conflict: 'skip' });
  const t = await receiver.create(
    manifest([{ id: 'a', type: 'file', relativePath: 'x', size: 4 }]),
  );
  assert.equal(t.items[0].status, 'queued');
  const matching = Readable.from([Buffer.from('same')]);
  matching.headers = { 'content-length': '4' };
  assert.equal((await receiver.upload(t.transferId, 'a', matching)).status, 'already_present');
  const second = await receiver.addItem(t.transferId, {
    id: 'b',
    type: 'file',
    relativePath: 'y',
    size: 4,
  });
  assert.equal(second.status, 'queued');
  await writeFile(path.join(root, 'y'), 'old');
  const different = Readable.from([Buffer.from('new!')]);
  different.headers = { 'content-length': '4' };
  assert.equal((await receiver.upload(t.transferId, 'b', different)).status, 'skipped');
  assert.equal(await readFile(path.join(root, 'y'), 'utf8'), 'old');
});
