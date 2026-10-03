import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable, PassThrough } from 'node:stream';
import { SendQueue } from '../src/transfer/send-queue.js';

function source(text) {
  const request = Readable.from([Buffer.from(text)]);
  request.headers = { 'content-length': Buffer.byteLength(text) };
  return request;
}

async function download(queue, item) {
  const response = new PassThrough();
  response.writeHead = () => {};
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  await queue.stream(item.id, response);
  return Buffer.concat(chunks).toString();
}

test('queues files in order, including additions while one is sending', async () => {
  const queue = new SendQueue();
  try {
    const a = await queue.add('Project/docs/spec.txt', source('alpha'));
    const b = await queue.add('Project/image.png', source('bravo'));
    assert.equal(queue.next().id, a.id);
    const c = await queue.add('Other/spec.txt', source('charlie'));
    assert.equal(queue.next(), null);
    assert.equal(await download(queue, a), 'alpha');
    await queue.finish(a.id, 'completed');
    assert.equal(queue.next().id, b.id);
    queue.failActive('Phone disconnected');
    assert.equal(b.state, 'failed');
    assert.equal(queue.next().id, c.id);
    assert.equal(await download(queue, c), 'charlie');
    await queue.finish(c.id, 'completed');
    assert.deepEqual(
      queue
        .summary()
        .filter((i) => i.type === 'file')
        .map((i) => i.state),
      ['completed', 'failed', 'completed'],
    );
    assert.deepEqual(
      queue
        .summary()
        .filter((i) => i.type === 'file')
        .map((i) => i.relativePath),
      ['Project/docs/spec.txt', 'Project/image.png', 'Other/spec.txt'],
    );
    assert.deepEqual(
      queue
        .summary()
        .filter((i) => i.type === 'folder')
        .map((i) => [i.name, i.fileCount]),
      [
        ['Project/', 2],
        ['Other/', 1],
      ],
    );
  } finally {
    await queue.close();
  }
});

test('waits for a staged file before dispatching later entries', async () => {
  const queue = new SendQueue();
  const blocked = new Readable({ read() {} });
  blocked.headers = { 'content-length': 1 };
  try {
    const first = queue.add('first.txt', blocked);
    const second = await queue.add('second.txt', source('b'));
    assert.equal(queue.next(), null);
    blocked.push('a');
    blocked.push(null);
    const a = await first;
    assert.equal(queue.next().id, a.id);
    await download(queue, a);
    await queue.finish(a.id, 'completed');
    assert.equal(queue.next().id, second.id);
  } finally {
    await queue.close();
  }
});

test('preserves image bytes while staging and streaming to the phone', async () => {
  const queue = new SendQueue();
  const image = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80, 0x01,
  ]);
  const request = Readable.from([image.subarray(0, 5), image.subarray(5)]);
  request.headers = { 'content-length': image.length };
  try {
    const item = await queue.add('photo.png', request);
    assert.equal(item.sha256, createHash('sha256').update(image).digest('hex'));
    assert.equal(queue.next().id, item.id);
    const response = new PassThrough();
    response.writeHead = () => {};
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    await queue.stream(item.id, response);
    assert.deepEqual(Buffer.concat(chunks), image);
    await queue.finish(item.id, 'completed');
  } finally {
    await queue.close();
  }
});

test('rejects traversal, absolute paths, incorrect lengths, and removes queued items', async () => {
  const queue = new SendQueue();
  try {
    for (const invalid of ['../escape.txt', '/absolute.txt', 'C:/absolute.txt', 'a/../b.txt']) {
      await assert.rejects(queue.add(invalid, source('x')));
    }
    const bad = source('abc');
    bad.headers['content-length'] = 2;
    await assert.rejects(queue.add('bad.txt', bad));
    const item = await queue.add('okay.txt', source('okay'));
    await queue.remove(item.id);
    assert.equal(item.state, 'cancelled');
    assert.equal(queue.next(), null);
  } finally {
    await queue.close();
  }
});
