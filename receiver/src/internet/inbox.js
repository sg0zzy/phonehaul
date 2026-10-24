import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { TransferReceiver } from '../transfer/receiver.js';
import { CHUNK_BYTES } from './transfer.js';

// The Internet adapter owns a separate COPY batch. Native commit and conflict
// behavior remain in the existing receiver; LAN scheduling is untouched.
export class InternetInbox {
  constructor(settings, maxFileBytes) {
    this.receiver = new TransferReceiver(settings);
    this.maxFileBytes = maxFileBytes;
    this.active = null;
  }
  async begin(file) {
    if (this.closed) throw Error('Internet receiver is closed');
    if (this.active || this.starting) throw Error('An Internet receive is already active');
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > this.maxFileBytes)
      throw Error('Internet file limit exceeded');
    const id = randomUUID();
    this.starting = true;
    let created;
    try {
      this.startPromise = this.receiver.create({
        protocol: 1,
        operation: 'copy',
        items: [{ id, type: 'file', relativePath: file.relativePath, size: file.size }],
      });
      created = await this.startPromise;
    } finally {
      this.starting = false;
    }
    const stream = new PassThrough({ highWaterMark: CHUNK_BYTES });
    stream.on('error', () => {});
    stream.headers = { 'content-length': String(file.size) };
    const result = this.receiver.upload(created.transferId, id, stream);
    result.catch(() => {});
    this.active = { id, transferId: created.transferId, stream, result, bytes: 0, size: file.size };
    this.armTimeout();
    return { id };
  }
  get(id) {
    if (!this.active || this.active.id !== id) throw Error('Invalid Internet receive');
    return this.active;
  }
  armTimeout() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.abort();
    }, 120_000);
    this.timer.unref();
  }
  async write(id, base64) {
    const item = this.get(id);
    if (
      typeof base64 !== 'string' ||
      base64.length > Math.ceil(CHUNK_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
    )
      throw Error('Invalid file chunk');
    const bytes = Buffer.from(base64, 'base64');
    if (item.bytes + bytes.length > item.size) throw Error('File exceeds declared size');
    await new Promise((resolve, reject) =>
      item.stream.write(bytes, (e) => (e ? reject(e) : resolve())),
    );
    item.bytes += bytes.length;
    this.armTimeout();
    return { status: 'written' };
  }
  async finish(id, sha256) {
    const item = this.get(id);
    if (!/^[a-f0-9]{64}$/.test(sha256) || item.bytes !== item.size)
      throw Error('Invalid final file verification');
    // Set the trailing expected hash before EOF permits the existing receiver
    // to verify it before committing its partial file.
    this.receiver.transfer.itemsById.get(id).sha256 = sha256;
    item.stream.end();
    try {
      const ack = await item.result;
      this.receiver.finish(item.transferId);
      return ack;
    } finally {
      clearTimeout(this.timer);
      this.active = null;
    }
  }
  async abort() {
    clearTimeout(this.timer);
    const item = this.active;
    this.active = null;
    if (item) {
      item.stream.destroy(Error('Internet receive cancelled'));
      this.receiver.cancel(item.transferId);
      await item.result.catch(() => {});
    }
  }
  async close() {
    this.closed = true;
    await this.startPromise?.catch(() => {});
    await this.abort();
  }
}
