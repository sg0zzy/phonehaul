import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { relativePath } from '../../../protocol/relative-path.js';
import { normalizeManifest } from '../../../protocol/manifest-v1.js';

export const CHUNK_BYTES = 16 * 1024;
const WINDOW = 256 * 1024;

export class InternetTransfer {
  constructor(channel, { maxFileBytes, makeSink, onOffer, onState = () => {} }) {
    this.channel = channel;
    this.maxFileBytes = maxFileBytes;
    this.makeSink = makeSink;
    this.onOffer = onOffer;
    this.onState = onState;
    this.approved = false;
    this.incoming = null;
    this.outgoing = null;
    this.pending = new Map();
    this.chain = Promise.resolve();
  }
  control(message) {
    this.channel.send(JSON.stringify(message));
  }
  wait(key, timeout = 120_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(Error('Peer timed out. Retry from the beginning.'));
      }, timeout);
      this.pending.set(key, {
        resolve: (value) => {
          clearTimeout(timer);
          this.pending.delete(key);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.pending.delete(key);
          reject(error);
        },
      });
    });
  }
  settle(key, value, error) {
    const pending = this.pending.get(key);
    if (pending) {
      if (error) pending.reject(error);
      else pending.resolve(value);
    }
  }
  receive(data) {
    if (typeof data === 'string' && data.length <= 8192) {
      try {
        if (JSON.parse(data).type === 'cancel') {
          void this.abort(Error('Transfer cancelled by peer'));
          this.onState({ state: 'cancelled' });
          return;
        }
      } catch {
        /* malformed control messages are rejected by the serialized handler */
      }
    }
    // Do not accumulate unbounded asynchronous sink writes when a peer ignores
    // credit. Count queued bytes before entering the promise chain.
    const binary = data instanceof ArrayBuffer || ArrayBuffer.isView(data);
    this.queuedMessages = (this.queuedMessages ?? 0) + 1;
    if (this.queuedMessages > 64) {
      void this.abort(Error('Peer exceeded message queue'));
      this.channel.close();
      return;
    }
    if (binary) {
      this.queuedBytes = (this.queuedBytes ?? 0) + data.byteLength;
      if (data.byteLength > CHUNK_BYTES || this.queuedBytes > WINDOW) {
        void this.abort(Error('Peer exceeded receive window'));
        this.channel.close();
        return;
      }
    }
    this.chain = this.chain
      .then(() => this.handle(data))
      .catch(async (error) => {
        await this.cancel(error.message);
        this.onState({ state: 'failed', error: error.message });
      })
      .finally(() => {
        this.queuedMessages--;
        if (binary) this.queuedBytes -= data.byteLength;
      });
  }
  async handle(data) {
    if (!this.approved) throw Error('Peer approval required');
    if (typeof data !== 'string') {
      const item = this.incoming;
      if (!item?.sink || item.ended) throw Error('Unexpected file bytes');
      const chunk = new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength);
      if (item.bytes + chunk.length > item.size) throw Error('File exceeds declared size');
      await item.sink.write(chunk);
      item.hash.update(chunk);
      item.bytes += chunk.length;
      this.control({ type: 'credit', id: item.id, offset: item.bytes });
      this.onState({
        state: 'receiving',
        name: item.relativePath,
        bytes: item.bytes,
        size: item.size,
      });
      return;
    }
    if (data.length > 8192) throw Error('Control message too large');
    const m = JSON.parse(data);
    if (m.type === 'offer') {
      if (this.incoming || this.outgoing) {
        this.control({ type: 'reject', id: m.id, error: 'Peer is busy. Retry shortly.' });
        return;
      }
      if (
        !/^[a-f0-9-]{36}$/.test(m.id) ||
        m.operation !== 'copy' ||
        !Number.isSafeInteger(m.size) ||
        m.size < 0 ||
        m.size > this.maxFileBytes
      )
        throw Error('Invalid or excessive Internet file size');
      relativePath(m.relativePath);
      const metadata = normalizeManifest({
        protocol: 1,
        operation: 'copy',
        items: [{ id: m.id, type: 'file', relativePath: m.relativePath, size: m.size }],
      }).items[0];
      const item = {
        ...metadata,
        bytes: 0,
        hash: sha256.create(),
      };
      this.incoming = item;
      if (!(await this.onOffer(m))) {
        this.incoming = null;
        this.control({ type: 'reject', id: m.id, error: 'File declined' });
        return;
      }
      if (this.incoming !== item) return;
      item.sink = await this.makeSink(m);
      if (this.incoming !== item) {
        await item.sink.abort();
        return;
      }
      this.control({ type: 'accept', id: m.id, window: WINDOW });
    } else if (m.type === 'accept') {
      if (!this.outgoing || m.id !== this.outgoing.id || m.window !== WINDOW)
        throw Error('Invalid transfer acceptance');
      this.settle(`accept:${m.id}`, m);
    } else if (m.type === 'reject') {
      this.settle(`accept:${m.id}`, null, Error(String(m.error ?? 'File declined')));
    } else if (m.type === 'credit') {
      const item = this.outgoing;
      if (
        !item ||
        item.id !== m.id ||
        !Number.isSafeInteger(m.offset) ||
        m.offset < item.ack ||
        m.offset > item.sent
      )
        throw Error('Invalid receive credit');
      item.ack = m.offset;
      this.settle(`credit:${m.id}`);
    } else if (m.type === 'end') {
      const item = this.incoming;
      if (!item?.sink || m.id !== item.id || item.bytes !== item.size)
        throw Error('Incomplete file');
      const digest = bytesToHex(item.hash.digest());
      if (m.sha256 !== digest) throw Error('File checksum mismatch');
      item.ended = true;
      const outcome = await item.sink.finish(digest);
      this.incoming = null;
      this.control({
        type: 'result',
        id: item.id,
        size: item.bytes,
        sha256: digest,
        status: outcome.status,
      });
      this.onState({
        state: outcome.status,
        name: item.relativePath,
        bytes: item.bytes,
        size: item.size,
      });
    } else if (m.type === 'result') {
      const item = this.outgoing;
      if (
        !item ||
        item.id !== m.id ||
        item.size !== m.size ||
        item.digest !== m.sha256 ||
        !['download-handed-off', 'committed', 'already_present', 'skipped'].includes(m.status)
      )
        throw Error('Invalid transfer acknowledgment');
      this.settle(`result:${m.id}`, m);
    } else if (m.type === 'cancel') {
      await this.abort(Error('Transfer cancelled by peer'));
      this.onState({ state: 'cancelled' });
    } else throw Error('Unknown transfer message');
  }
  async send(file, relative = file.name) {
    if (!this.approved) throw Error('Compare and approve the verification phrase first.');
    if (this.outgoing || this.incoming) throw Error('A transfer is already active.');
    relativePath(relative);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > this.maxFileBytes)
      throw Error(`Internet file limit is ${this.maxFileBytes} bytes.`);
    const item = { id: crypto.randomUUID(), sent: 0, ack: 0, size: file.size };
    this.outgoing = item;
    const hash = sha256.create();
    try {
      const accepted = this.wait(`accept:${item.id}`);
      this.control({
        type: 'offer',
        id: item.id,
        operation: 'copy',
        relativePath: relative,
        size: file.size,
      });
      await accepted;
      for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
        if (this.outgoing !== item) throw Error('Transfer cancelled');
        while (item.sent - item.ack >= WINDOW) {
          await this.wait(`credit:${item.id}`);
        }
        if (this.channel.bufferedAmount > WINDOW) {
          this.channel.bufferedAmountLowThreshold = WINDOW / 2;
          await new Promise((resolve, reject) => {
            const cleanup = () => {
              clearTimeout(timer);
              this.channel.removeEventListener('bufferedamountlow', done);
              this.channel.removeEventListener('close', closed);
            };
            const done = () => {
              cleanup();
              resolve();
            };
            const closed = () => {
              cleanup();
              reject(Error('Connection closed'));
            };
            const timer = setTimeout(closed, 60_000);
            this.channel.addEventListener('bufferedamountlow', done, { once: true });
            this.channel.addEventListener('close', closed, { once: true });
          });
        }
        const chunk = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
        if (this.outgoing !== item) throw Error('Transfer cancelled');
        hash.update(chunk);
        item.sent += chunk.length;
        this.channel.send(chunk);
        this.onState({ state: 'sending', name: relative, bytes: item.sent, size: item.size });
      }
      item.digest = bytesToHex(hash.digest());
      const completed = this.wait(`result:${item.id}`);
      this.control({ type: 'end', id: item.id, sha256: item.digest });
      const result = await completed;
      this.onState({ state: result.status, name: relative, bytes: item.size, size: item.size });
      return result;
    } catch (error) {
      if (this.channel.readyState === 'open') this.control({ type: 'cancel', id: item.id });
      throw error;
    } finally {
      if (this.outgoing === item) this.outgoing = null;
    }
  }
  async abort(error = Error('Transfer stopped')) {
    const incoming = this.incoming;
    this.incoming = null;
    this.outgoing = null;
    for (const p of [...this.pending.values()]) p.reject(error);
    if (incoming?.sink) await incoming.sink.abort();
  }
  async cancel(reason = 'Transfer cancelled') {
    if (this.channel.readyState === 'open') this.control({ type: 'cancel' });
    await this.abort(Error(reason));
    this.onState({ state: 'cancelled', error: reason });
  }
}
