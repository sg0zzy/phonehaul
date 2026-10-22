import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable, PassThrough } from 'node:stream';
import { readdir } from 'node:fs/promises';
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

test('rejects sizes above the 64 GiB limit and non-integer lengths', async () => {
  const queue = new SendQueue();
  try {
    const max = 64 * 1024 ** 3;
    for (const length of [max + 1, 2 ** 53, -1, 'abc']) {
      const request = source('x');
      request.headers['content-length'] = length;
      await assert.rejects(queue.add('photo.jpg', request), /Invalid or excessive file size/);
    }
    assert.deepEqual(queue.items, [], 'a rejected size never enters the queue');
  } finally {
    await queue.close();
  }
});

test('refuses more bytes than the declared size and removes the staged file', async () => {
  const queue = new SendQueue();
  try {
    const request = source('abcdef');
    request.headers['content-length'] = 4;
    await assert.rejects(queue.add('photo.jpg', request), /File exceeds declared size/);
    assert.equal(queue.items[0].state, 'failed');
    assert.equal(queue.items[0].sha256, null);
    assert.deepEqual(await readdir(queue.directory), []);
  } finally {
    await queue.close();
  }
});

test('refuses to acknowledge a file whose bytes were not delivered', async () => {
  const queue = new SendQueue();
  try {
    const item = await queue.add('photo.jpg', source('abc'));
    assert.equal(queue.next().id, item.id);
    await assert.rejects(queue.finish(item.id, 'completed'), /File download is incomplete/);
    await assert.rejects(queue.finish(item.id, 'committed'), /Invalid send acknowledgement/);
    await assert.rejects(queue.finish('unknown-id', 'completed'), /Invalid send acknowledgement/);
    assert.equal(item.state, 'sending', 'a rejected acknowledgement does not change the state');
    await queue.finish(item.id, 'failed', 'Phone disconnected');
    assert.equal(item.state, 'failed');
    assert.equal(item.error, 'Phone disconnected');
  } finally {
    await queue.close();
  }
});

test('acknowledging an immediately completed download cannot race the flush callback', async () => {
  const queue = new SendQueue();
  try {
    const item = await queue.add('photo.jpg', source('alpha'));
    assert.equal(queue.next().id, item.id);
    const response = new PassThrough();
    response.writeHead = () => {};
    let confirmFlush = null;
    response.end = (callback) => {
      confirmFlush = callback;
    };
    const streaming = queue.stream(item.id, response);
    while (!confirmFlush) await new Promise((resolve) => setImmediate(resolve));
    // The phone received every byte and acknowledged at once while the server
    // still waits for flush confirmation: the acknowledgement must stick.
    await queue.finish(item.id, 'completed');
    assert.equal(item.state, 'completed');
    assert.equal(queue.active, null);
    confirmFlush();
    await streaming;
  } finally {
    await queue.close();
  }
});

test('refuses to stream an item that is not the active send', async () => {
  const queue = new SendQueue();
  try {
    const item = await queue.add('photo.jpg', source('abc'));
    const response = new PassThrough();
    response.writeHead = () => {};
    await assert.rejects(queue.stream('unknown-id', response), /Invalid send item/);
    await assert.rejects(queue.stream(item.id, response), /Invalid send item/);
    assert.equal(item.state, 'queued');
  } finally {
    await queue.close();
  }
});

test('waits for drain when the phone stops accepting bytes', async () => {
  const queue = new SendQueue();
  try {
    const item = await queue.add('photo.jpg', source('abcdef'));
    assert.equal(queue.next().id, item.id);
    const response = new PassThrough();
    response.writeHead = () => {};
    const chunks = [];
    let paused;
    const pausedSignal = new Promise((resolve) => {
      paused = resolve;
    });
    response.write = (chunk) => {
      chunks.push(chunk);
      if (chunks.length === 1) paused();
      return chunks.length > 1;
    };
    const streaming = queue.stream(item.id, response);
    await pausedSignal;
    assert.equal(item.progress, 0, 'bytes are not credited while the phone is paused');
    response.emit('drain');
    await streaming;
    assert.equal(item.progress, item.size);
    assert.equal(item.downloaded, true);
    assert.deepEqual(Buffer.concat(chunks).toString(), 'abcdef');
  } finally {
    await queue.close();
  }
});

test('an interrupted download fails the active item', async () => {
  const queue = new SendQueue();
  try {
    const item = await queue.add('photo.jpg', source('abcdef'));
    assert.equal(queue.next().id, item.id);
    const response = new PassThrough();
    response.writeHead = () => {};
    let paused;
    const pausedSignal = new Promise((resolve) => {
      paused = resolve;
    });
    response.write = () => {
      paused();
      return false;
    };
    const streaming = queue.stream(item.id, response);
    await pausedSignal;
    response.emit('close');
    await streaming;
    assert.equal(item.state, 'failed');
    assert.equal(item.error, 'Download interrupted');
    assert.equal(queue.active, null);
    assert.deepEqual(await readdir(queue.directory), []);
  } finally {
    await queue.close();
  }
});

test('cannot remove an item that is already sending', async () => {
  const queue = new SendQueue();
  try {
    const item = await queue.add('photo.jpg', source('abc'));
    queue.next();
    await assert.rejects(queue.remove(item.id), /Item cannot be removed/);
    await assert.rejects(queue.remove('unknown-id'), /Item cannot be removed/);
    assert.equal(item.state, 'sending');
  } finally {
    await queue.close();
  }
});

test('a folder reports the state of its members by precedence', async () => {
  async function groupState(states) {
    const queue = new SendQueue();
    try {
      const items = [];
      for (const index of states.keys())
        items.push(await queue.add(`f/${index}.txt`, source(String(index))));
      for (const [index, state] of states.entries()) {
        if (state === 'queued') continue;
        if (state === 'cancelled') {
          await queue.remove(items[index].id);
          continue;
        }
        assert.equal(queue.next().id, items[index].id);
        if (state === 'sending') continue;
        if (state === 'completed') await download(queue, items[index]);
        await queue.finish(items[index].id, state, state === 'completed' ? null : 'interrupted');
      }
      return queue.summary().find((entry) => entry.type === 'folder').state;
    } finally {
      await queue.close();
    }
  }
  assert.equal(await groupState(['sending', 'queued']), 'sending');
  assert.equal(await groupState(['failed', 'queued']), 'queued');
  assert.equal(await groupState(['failed', 'completed']), 'failed');
  assert.equal(await groupState(['cancelled', 'completed']), 'cancelled');
  assert.equal(await groupState(['completed', 'completed']), 'completed');
});
