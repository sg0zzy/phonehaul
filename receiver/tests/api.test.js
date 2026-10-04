import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { startReceiver } from '../src/server/app.js';

function request(receiver, method, route, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port: receiver.port,
        path: route,
        method,
        rejectUnauthorized: false,
        headers: { Authorization: `Bearer ${receiver.session.token}`, ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (x) => chunks.push(x));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }),
        );
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

function uiRequest(uiUrl, route) {
  return new Promise((resolve, reject) => {
    http
      .get(new URL(route, uiUrl), (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
      })
      .on('error', reject);
  });
}

function pageRequest(uiUrl) {
  return new Promise((resolve, reject) =>
    http
      .get(uiUrl, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            type: response.headers['content-type'],
            body: Buffer.concat(chunks).toString(),
          }),
        );
      })
      .on('error', reject),
  );
}

function emptyRequest(uiUrl, route, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(route, uiUrl), { method }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

function localRequest(uiUrl, route, { method = 'GET', headers = {}, data } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(route, uiUrl), { method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('management UI rejects foreign Host and Origin without changing settings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-ui-origin-'));
  const settingsFile = path.join(root, 'settings.json');
  const destination = path.join(root, 'dest');
  await writeFile(settingsFile, JSON.stringify({ destination, conflict: 'rename' }));
  const receiver = await startReceiver({ host: '127.0.0.1', settingsFile });
  const changed = JSON.stringify({ destination: path.join(root, 'changed'), conflict: 'replace' });
  try {
    assert.equal(
      (await localRequest(receiver.uiUrl, '/api/ui', { headers: { Host: 'evil.example' } })).status,
      403,
    );
    assert.equal(
      (
        await localRequest(receiver.uiUrl, '/api/settings', {
          method: 'POST',
          headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
          data: changed,
        })
      ).status,
      403,
    );
    assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')), {
      destination,
      conflict: 'rename',
    });
    assert.equal(
      (
        await localRequest(receiver.uiUrl, '/api/settings', {
          method: 'POST',
          headers: { Origin: new URL(receiver.uiUrl).origin, 'Content-Type': 'application/json' },
          data: changed,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await localRequest(receiver.uiUrl, '/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          data: JSON.stringify({ destination, conflict: 'rename' }),
        })
      ).status,
      200,
    );
  } finally {
    await receiver.close();
  }
});

test('management UI is local, self-contained, and closes cleanly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-ui-'));
  const settingsFile = path.join(root, 'settings.json');
  const destination = path.join(root, 'dest');
  await writeFile(settingsFile, JSON.stringify({ destination, conflict: 'rename' }));
  const receiver = await startReceiver({
    host: '127.0.0.1',
    transferPort: 0,
    uiPort: 0,
    settingsFile,
  });
  try {
    assert.equal(new URL(receiver.uiUrl).hostname, '127.0.0.1');
    const response = await pageRequest(receiver.uiUrl);
    assert.equal(response.status, 200);
    assert.match(response.type, /text\/html/);
    assert.match(response.body, /<title>PhoneHaul Receiver<\/title>/);
    assert.match(response.body, /new EventSource\('\/api\/events'\)/);
    assert.match(response.body, /\$\('qr'\)\.hidden=s\.pairingComplete/);
    assert.doesNotMatch(response.body, /<script[^>]+src=/);
    const ui = await uiRequest(receiver.uiUrl, '/api/ui');
    assert.equal(ui.settings.destination, destination);
    assert.match(ui.qr, /^data:image\/png;base64,/);
    assert.equal(ui.pairingComplete, false);
    assert.equal(await emptyRequest(receiver.uiUrl, '/api/heartbeat'), 204);
  } finally {
    await receiver.close();
    await receiver.close();
  }
});

test('HTTPS API accepts a verified file and rejects bad session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-api-'));
  const settingsFile = path.join(root, 'settings.json');
  const destination = path.join(root, 'dest');
  await writeFile(settingsFile, JSON.stringify({ destination, conflict: 'rename' }));
  const receiver = await startReceiver({ host: '127.0.0.1', transferPort: 0, settingsFile });
  try {
    const bad = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: '127.0.0.1',
          port: receiver.port,
          path: '/api/session/connect',
          method: 'POST',
          rejectUnauthorized: false,
          headers: { Authorization: 'Bearer bad' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(bad, 401);
    const connected = await request(receiver, 'POST', '/api/session/connect');
    assert.equal(connected.status, 200);
    assert.deepEqual(connected.body.capabilities, ['send-to-phone', 'incremental-transfer']);
    const manifest = {
      protocol: 1,
      operation: 'copy',
      items: [
        {
          id: 'file1',
          type: 'file',
          relativePath: 'DCIM/test.txt',
          size: 5,
          sha256: createHash('sha256').update('hello').digest('hex'),
        },
      ],
    };
    const created = await request(receiver, 'POST', '/api/transfers', JSON.stringify(manifest), {
      'Content-Type': 'application/json',
    });
    assert.equal(created.status, 201);
    const id = created.body.transferId;
    const upload = await request(receiver, 'PUT', `/api/transfers/${id}/files/file1`, 'hello', {
      'Content-Length': 5,
      'X-PhoneHaul-SHA256': createHash('sha256').update('hello').digest('hex'),
    });
    assert.equal(upload.status, 200);
    assert.equal(upload.body.status, 'committed');
    assert.equal(await readFile(path.join(destination, 'DCIM', 'test.txt'), 'utf8'), 'hello');
    const appended = await request(
      receiver,
      'POST',
      `/api/transfers/${id}/items`,
      JSON.stringify({ id: 'file2', type: 'file', relativePath: 'Screenshots/shot.png', size: 4 }),
      { 'Content-Type': 'application/json' },
    );
    assert.deepEqual(appended, { status: 201, body: { id: 'file2', status: 'queued' } });
    const streamed = await request(receiver, 'PUT', `/api/transfers/${id}/files/file2`, 'shot', {
      'Content-Length': 4,
    });
    assert.equal(streamed.body.status, 'committed');
    assert.equal(streamed.body.sha256, createHash('sha256').update('shot').digest('hex'));
    assert.equal(await readFile(path.join(destination, 'Screenshots', 'shot.png'), 'utf8'), 'shot');
    assert.equal(
      (await request(receiver, 'POST', `/api/transfers/${id}/finish`)).body.completedItems,
      2,
    );
  } finally {
    await receiver.close();
  }
});

test('pairing updates the management event stream so the QR can disappear', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-pair-events-'));
  const receiver = await startReceiver({
    host: '127.0.0.1',
    transferPort: 0,
    settingsFile: path.join(root, 'settings.json'),
  });
  const response = await fetch(new URL('/api/events', receiver.uiUrl));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const nextEvent = async () => {
    while (true) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const line = event.split('\n').find((value) => value.startsWith('data: '));
        if (line) return JSON.parse(line.slice(6));
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw Error('Management event stream closed unexpectedly');
      buffer += decoder.decode(value, { stream: true });
    }
  };
  try {
    const initial = await nextEvent();
    assert.equal(initial.connected, false);
    assert.equal(initial.pairingComplete, false);
    const connected = await request(receiver, 'POST', '/api/session/connect', undefined, {
      'X-PhoneHaul-Capabilities': 'send-to-phone',
    });
    assert.equal(connected.status, 200);
    const state = await nextEvent();
    assert.equal(state.connected, true);
    assert.equal(state.pairingComplete, true);
    assert.equal(state.sendConnected, true);
  } finally {
    await reader.cancel();
    await receiver.close();
  }
});

test('expired QR is replaced in the local UI and old token is rejected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-qr-'));
  const settingsFile = path.join(root, 'settings.json');
  await writeFile(
    settingsFile,
    JSON.stringify({ destination: path.join(root, 'dest'), conflict: 'rename' }),
  );
  const receiver = await startReceiver({ host: '127.0.0.1', transferPort: 0, settingsFile });
  try {
    const original = receiver.session.token;
    const before = await uiRequest(receiver.uiUrl, '/api/ui');
    receiver.session.expiresAt = Date.now() - 1;
    const after = await uiRequest(receiver.uiUrl, '/api/ui');
    assert.notEqual(receiver.session.token, original);
    assert.notEqual(after.qr, before.qr);
    assert.equal(after.pairingVersion, before.pairingVersion + 1);
    const rejected = await request(receiver, 'POST', '/api/session/connect', undefined, {
      Authorization: `Bearer ${original}`,
    });
    assert.equal(rejected.status, 401);
    assert.equal(
      (
        await request(receiver, 'POST', '/api/session/connect', undefined, {
          'X-PhoneHaul-Capabilities': 'send-to-phone',
        })
      ).status,
      200,
    );
    const paired = await uiRequest(receiver.uiUrl, '/api/ui');
    assert.equal(paired.sendConnected, true);
    assert.equal(paired.pairingComplete, true);
  } finally {
    await receiver.close();
  }
});

test('computer to phone uses paired HTTPS session and preserves ordered relative paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-send-api-'));
  const settingsFile = path.join(root, 'settings.json');
  await writeFile(
    settingsFile,
    JSON.stringify({ destination: path.join(root, 'dest'), conflict: 'rename' }),
  );
  const receiver = await startReceiver({ host: '127.0.0.1', settingsFile });
  const local = (route, relative, data) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        new URL(route, receiver.uiUrl),
        {
          method: 'POST',
          headers: {
            'Content-Length': Buffer.byteLength(data),
            'X-PhoneHaul-Relative-Path': encodeURIComponent(relative),
          },
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
  const download = (id) =>
    new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: '127.0.0.1',
          port: receiver.port,
          path: `/api/send/${id}/content`,
          rejectUnauthorized: false,
          headers: { Authorization: `Bearer ${receiver.session.token}` },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
  try {
    const a = await local('/api/send/items', 'Project/docs/spec.txt', 'alpha');
    const b = await local('/api/send/items', 'Other/spec.txt', 'bravo');
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal((await request(receiver, 'GET', '/api/send/next')).status, 401);
    assert.equal(
      (
        await request(receiver, 'POST', '/api/session/connect', undefined, {
          'X-PhoneHaul-Capabilities': 'send-to-phone',
        })
      ).status,
      200,
    );
    const first = (await request(receiver, 'GET', '/api/send/next')).body;
    assert.equal(first.relativePath, 'Project/docs/spec.txt');
    assert.equal(first.sha256, createHash('sha256').update('alpha').digest('hex'));
    assert.equal((await request(receiver, 'GET', '/api/send/next')).body.item, null);
    assert.deepEqual(await download(first.id), { status: 200, body: 'alpha' });
    assert.equal(
      (
        await request(
          receiver,
          'POST',
          `/api/send/${first.id}/complete`,
          JSON.stringify({ state: 'completed' }),
        )
      ).status,
      200,
    );
    const second = (await request(receiver, 'GET', '/api/send/next')).body;
    assert.equal(second.relativePath, 'Other/spec.txt');
    assert.deepEqual(await download(second.id), { status: 200, body: 'bravo' });
    assert.equal(
      (
        await request(
          receiver,
          'POST',
          `/api/send/${second.id}/complete`,
          JSON.stringify({ state: 'completed' }),
        )
      ).status,
      200,
    );
    assert.deepEqual(
      receiver.sendQueue
        .summary()
        .filter((i) => i.type === 'file')
        .map((i) => i.state),
      ['completed', 'completed'],
    );
  } finally {
    await receiver.close();
  }
});
