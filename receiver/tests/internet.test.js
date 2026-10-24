import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Rooms, turnCredentials } from '../src/internet/rooms.js';
import { internetConfig } from '../src/internet/config.js';
import { certificateFingerprint, verificationPhrase } from '../src/internet/identity.js';
import { InternetTransfer } from '../src/internet/transfer.js';
import { InternetInbox } from '../src/internet/inbox.js';
import { startSignaling } from '../src/internet/signaling.js';

test('Internet invitations expire independently of established sessions and recovery', () => {
  let now = 0;
  const rooms = new Rooms(
    { ...internetConfig(), invitationMs: 100, recoveryMs: 200 },
    { now: () => now },
  );
  const expired = rooms.create();
  now = 101;
  assert.throws(() => rooms.join(expired.code), /unavailable/);
  const owner = rooms.create();
  const guest = rooms.join(owner.code);
  assert.throws(() => rooms.join(owner.code), /already waiting/);
  assert.throws(() => rooms.authenticate(owner.id, 'wrong'), /Invalid session/);
  rooms.approve(owner.id, owner.token);
  rooms.approve(owner.id, guest.token);
  now = 500;
  assert.deepEqual(rooms.poll(owner.id, owner.token, true), [{ type: 'joined' }]);
  rooms.poll(owner.id, guest.token, true);
  rooms.poll(owner.id, guest.token, false);
  now = 699;
  rooms.poll(owner.id, owner.token, true);
  now = 700;
  assert.throws(() => rooms.authenticate(owner.id, owner.token), /expired/);
});

test('TURN credentials are scoped, expiring HMAC credentials and contain no shared secret', () => {
  const ice = turnCredentials(
    { urls: ['turn:relay.example:3478'], secret: 'server-only', lifetimeSeconds: 60 },
    'room',
    100_000,
  );
  assert.equal(ice[0].username, '160:room');
  assert.equal(
    ice[0].credential,
    createHmac('sha1', 'server-only').update('160:room').digest('base64'),
  );
  assert.deepEqual(turnCredentials({}, 'room'), []);
});

test('verification binds both certificate fingerprints, role order, and room', () => {
  const fingerprint = 'AA:'.repeat(31) + 'AA';
  assert.equal(
    certificateFingerprint(`v=0\r\na=fingerprint:sha-256 ${fingerprint}\r\n`),
    'a'.repeat(64),
  );
  assert.throws(() => certificateFingerprint('v=0'), /fingerprint/);
  const phrase = verificationPhrase('1'.repeat(32), 'a'.repeat(64), 'b'.repeat(64));
  assert.equal(phrase.split(' ').length, 24);
  assert.notEqual(phrase, verificationPhrase('2'.repeat(32), 'a'.repeat(64), 'b'.repeat(64)));
  assert.notEqual(phrase, verificationPhrase('1'.repeat(32), 'b'.repeat(64), 'a'.repeat(64)));
  assert.notEqual(phrase, verificationPhrase('1'.repeat(32), 'a'.repeat(64), 'c'.repeat(64)));
});

function peers({ limit = 1024 ** 2, corrupt = false, accept = true } = {}) {
  const saved = [];
  let aborted = false;
  const a = { readyState: 'open', bufferedAmount: 0, close() {} };
  const b = { readyState: 'open', bufferedAmount: 0, close() {} };
  const sender = new InternetTransfer(a, { maxFileBytes: limit });
  const receiver = new InternetTransfer(b, {
    maxFileBytes: limit,
    onOffer: async () => accept,
    makeSink: async () => ({
      async write(chunk) {
        await new Promise((r) => setImmediate(r));
        saved.push(Buffer.from(chunk));
      },
      async finish() {
        return { status: 'download-handed-off' };
      },
      async abort() {
        aborted = true;
        saved.length = 0;
      },
    }),
  });
  a.send = (data) => {
    if (typeof data !== 'string') {
      data = data.slice();
      if (corrupt) data[0] ^= 1;
    }
    queueMicrotask(() => receiver.receive(data));
  };
  b.send = (data) => queueMicrotask(() => sender.receive(data));
  sender.approved = true;
  receiver.approved = true;
  return { sender, receiver, saved, aborted: () => aborted };
}

test('Internet transfer streams across a bounded window and verifies acknowledgments', async () => {
  const pair = peers();
  const bytes = Buffer.alloc(700_000, 91);
  const result = await pair.sender.send(new File([bytes], 'large.bin'));
  assert.equal(result.status, 'download-handed-off');
  assert.deepEqual(Buffer.concat(pair.saved), bytes);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
});

test('Internet rejects oversized and declined files without sending file bytes', async () => {
  const pair = peers({ limit: 10, accept: false });
  await assert.rejects(pair.sender.send(new File([Buffer.alloc(11)], 'x')), /limit/);
  await assert.rejects(pair.sender.send(new File([Buffer.alloc(10)], 'x')), /declined/);
  assert.equal(pair.saved.length, 0);
});

test('corrupted Internet data never produces a successful result', async () => {
  const pair = peers({ corrupt: true });
  await assert.rejects(pair.sender.send(new File(['verified'], 'x')), /cancelled/);
  assert.equal(pair.aborted(), true);
  assert.equal(pair.saved.length, 0);
});

test('receiver rejects a peer exceeding its local limit and unapproved sends never start', async () => {
  const pair = peers({ limit: 10 });
  pair.sender.maxFileBytes = 20;
  await assert.rejects(pair.sender.send(new File([Buffer.alloc(11)], 'x')), /cancelled/);
  assert.equal(pair.saved.length, 0);
  pair.sender.approved = false;
  await assert.rejects(pair.sender.send(new File(['x'], 'x')), /approve/);
});

test('cancellation while an offer is waiting does not create a destination', async () => {
  const pair = peers();
  let answer, offered;
  const waiting = new Promise((resolve) => {
    offered = resolve;
  });
  let opened = false;
  pair.receiver.onOffer = () => {
    offered();
    return new Promise((resolve) => {
      answer = resolve;
    });
  };
  pair.receiver.makeSink = async () => {
    opened = true;
    throw Error('Unexpected destination');
  };
  const sent = pair.sender.send(new File(['abc'], 'x'));
  const failed = assert.rejects(sent, /cancelled/);
  await waiting;
  await pair.sender.cancel();
  answer(true);
  await failed;
  await pair.receiver.chain;
  assert.equal(opened, false);
});

test('Internet native sink validates trailing hash before atomic commit and cleans cancellation', async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-internet-inbox-'));
  const inbox = new InternetInbox({ destination, conflict: 'rename' }, 100);
  try {
    const { id } = await inbox.begin({ relativePath: 'a.txt', size: 3 });
    await inbox.write(id, Buffer.from('abc').toString('base64'));
    await assert.rejects(inbox.finish(id, '0'.repeat(64)), /SHA-256 mismatch/);
    assert.deepEqual(await readdir(destination), []);
    const valid = await inbox.begin({ relativePath: 'a.txt', size: 3 });
    await inbox.write(valid.id, Buffer.from('abc').toString('base64'));
    const ack = await inbox.finish(valid.id, createHash('sha256').update('abc').digest('hex'));
    assert.equal(ack.status, 'committed');
    assert.equal(await readFile(path.join(destination, 'a.txt'), 'utf8'), 'abc');
    await inbox.begin({ relativePath: 'cancelled.txt', size: 10 });
    await inbox.abort();
    assert.deepEqual(await readdir(destination), ['a.txt']);
    await assert.rejects(inbox.begin({ relativePath: '../escape', size: 1 }), /relative path/);
  } finally {
    await inbox.abort();
    await rm(destination, { recursive: true, force: true });
  }
});

test('signaling authenticates peers, rejects foreign origins, limits attempts and never serves file routes', async () => {
  const app = await startSignaling({
    port: 0,
    config: { ...internetConfig(), requestsPerMinute: 8 },
  });
  try {
    const create = await fetch(`${app.url}/v1/rooms`, { method: 'POST' });
    const owner = await create.json();
    assert.equal(create.status, 201);
    assert.equal((await fetch(`${app.url}/v1/rooms/${owner.id}/events`)).status, 401);
    assert.equal(
      (
        await fetch(`${app.url}/v1/rooms`, {
          method: 'POST',
          headers: { Origin: 'https://attacker.example' },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(`${app.url}/v1/upload`, { method: 'POST', body: 'file' })).status,
      404,
    );
    const guest = await fetch(`${app.url}/v1/join`, {
      method: 'POST',
      body: JSON.stringify({ code: owner.code }),
    }).then((r) => r.json());
    assert.equal(guest.id, owner.id);
    assert.equal(
      (
        await fetch(`${app.url}/v1/rooms/${owner.id}/signal`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${guest.token}` },
          body: JSON.stringify({ type: 'offer', sdp: 'v=0' }),
        })
      ).status,
      403,
    );
    for (let i = 0; i < 5; i++) await fetch(`${app.url}/v1/rooms/missing`);
    assert.equal((await fetch(`${app.url}/v1/rooms`, { method: 'POST' })).status, 429);
  } finally {
    await app.close();
  }
});

test('Internet configuration accepts explicit limits and rejects unsafe values', () => {
  assert.equal(internetConfig({ PHONEHAUL_INTERNET_MAX_FILE_BYTES: '123' }).maxFileBytes, 123);
  assert.throws(() => internetConfig({ PHONEHAUL_RECOVERY_MS: '-1' }), /Invalid/);
});

test('closing a native Internet inbox while preparation runs cleans its pending file', async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-internet-close-'));
  const inbox = new InternetInbox({ destination, conflict: 'rename' }, 100);
  try {
    const preparing = inbox.begin({ relativePath: 'pending.txt', size: 3 });
    await inbox.close();
    await preparing;
    assert.equal(inbox.active, null);
    assert.deepEqual(await readdir(destination), []);
    await assert.rejects(inbox.begin({ relativePath: 'later.txt', size: 3 }), /closed/);
  } finally {
    await inbox.close();
    await rm(destination, { recursive: true, force: true });
  }
});

test('relay admission respects configured capacity and retains already-issued grants', async () => {
  let now = 0;
  const app = await startSignaling({
    port: 0,
    now: () => now,
    turn: {
      urls: ['turn:relay.example:3478'],
      secret: 'test-only-secret',
      maxSessions: 1,
      lifetimeSeconds: 60,
    },
  });
  const create = () => fetch(`${app.url}/v1/rooms`, { method: 'POST' }).then((r) => r.json());
  const ice = (room) =>
    fetch(`${app.url}/v1/rooms/${room.id}/ice`, {
      headers: { Authorization: `Bearer ${room.token}` },
    }).then((r) => r.json());
  try {
    const a = await create(),
      b = await create();
    assert.equal((await ice(a)).relayAvailable, true);
    assert.equal((await ice(b)).relayAvailable, false);
    await fetch(`${app.url}/v1/rooms/${a.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${a.token}` },
    });
    assert.equal((await ice(b)).relayAvailable, false);
    now = 60_001;
    assert.equal((await ice(b)).relayAvailable, true);
  } finally {
    await app.close();
  }
});
