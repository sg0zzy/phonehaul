import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { findPartials } from '../src/transfer/receiver.js';
import { startReceiver } from '../src/server/app.js';

function lanRequest(receiver, method, route, data) {
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
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }),
        );
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

function uiPost(uiUrl, route) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(route, uiUrl), { method: 'POST' }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

test('findPartials reports nested partial files and never a directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-partials-'));
  try {
    await writeFile(path.join(root, 'a.phonehaul-partial'), 'a');
    await writeFile(path.join(root, 'keep.txt'), 'keep');
    await mkdir(path.join(root, 'nested', 'deep'), { recursive: true });
    await writeFile(path.join(root, 'nested', 'deep', 'b.phonehaul-partial'), 'b');
    await mkdir(path.join(root, 'fake.phonehaul-partial'));
    await writeFile(path.join(root, 'fake.phonehaul-partial', 'c.phonehaul-partial'), 'c');
    assert.deepEqual((await findPartials(root)).sort(), [
      path.join(root, 'a.phonehaul-partial'),
      path.join(root, 'fake.phonehaul-partial', 'c.phonehaul-partial'),
      path.join(root, 'nested', 'deep', 'b.phonehaul-partial'),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('removing partials deletes only the partial files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-partials-remove-'));
  const settingsFile = path.join(root, 'settings.json');
  const destination = path.join(root, 'dest');
  try {
    await mkdir(destination);
    await writeFile(settingsFile, JSON.stringify({ destination, conflict: 'rename' }));
    await writeFile(path.join(destination, 'a.phonehaul-partial'), 'a');
    await mkdir(path.join(destination, 'sub'));
    await writeFile(path.join(destination, 'sub', 'b.phonehaul-partial'), 'b');
    await writeFile(path.join(destination, 'photo.jpg'), 'keep');
    const receiver = await startReceiver({
      host: '127.0.0.1',
      transferPort: 0,
      settingsFile,
      phoneOfflineWindowMs: 0,
    });
    try {
      const reported = await uiPost(receiver.uiUrl, '/api/partials/remove');
      assert.equal(reported.status, 200);
      assert.equal(reported.body.removed, 2);
      assert.deepEqual((await readdir(destination)).sort(), ['photo.jpg', 'sub']);
      assert.deepEqual(await readdir(path.join(destination, 'sub')), []);
    } finally {
      await receiver.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('partials are kept while a transfer is running and removable after it ends', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-partials-transfer-'));
  const settingsFile = path.join(root, 'settings.json');
  const destination = path.join(root, 'dest');
  try {
    await mkdir(destination);
    await writeFile(settingsFile, JSON.stringify({ destination, conflict: 'rename' }));
    await writeFile(path.join(destination, 'a.phonehaul-partial'), 'a');
    const receiver = await startReceiver({
      host: '127.0.0.1',
      transferPort: 0,
      settingsFile,
      phoneOfflineWindowMs: 0,
    });
    try {
      assert.equal((await lanRequest(receiver, 'POST', '/api/session/connect')).status, 200);
      const created = await lanRequest(
        receiver,
        'POST',
        '/api/transfers',
        JSON.stringify({
          protocol: 1,
          operation: 'move',
          items: [{ id: 'a', type: 'file', relativePath: 'photo.jpg', size: 3 }],
        }),
      );
      assert.equal(created.status, 201);
      const blocked = await uiPost(receiver.uiUrl, '/api/partials/remove');
      assert.equal(blocked.status, 400);
      assert.match(blocked.body.error, /Cannot remove partial files during transfer/);
      assert.deepEqual(await readdir(destination), ['a.phonehaul-partial']);
      assert.equal(
        (await lanRequest(receiver, 'POST', `/api/transfers/${created.body.transferId}/cancel`))
          .status,
        200,
      );
      const removed = await uiPost(receiver.uiUrl, '/api/partials/remove');
      assert.equal(removed.status, 200);
      assert.equal(removed.body.removed, 1);
      assert.deepEqual(await readdir(destination), []);
    } finally {
      await receiver.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
