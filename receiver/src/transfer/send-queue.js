import os from 'node:os';
import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, unlink, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { relativePath } from '../security/paths.js';

const MAX_FILE = 64 * 1024 ** 3;
export class SendQueue {
  constructor(onEvent = () => {}) {
    this.items = [];
    this.active = null;
    this.onEvent = onEvent;
    this.directory = null;
    this.directoryPromise = null;
  }
  summary() {
    const files = this.items.map(({ id, relativePath, name, type, size, state, progress, error }) => ({ id, relativePath, name, type, size, state, progress, error }));
    const folders = new Map();
    for (const file of files) {
      const slash = file.relativePath.indexOf('/');
      if (slash < 1) continue;
      const name = file.relativePath.slice(0, slash);
      if (!folders.has(name)) folders.set(name, []);
      folders.get(name).push(file);
    }
    const groups = [...folders].map(([name, members]) => ({
      id: null, relativePath: name + '/', name: name + '/', type: 'folder',
      size: members.reduce((sum, file) => sum + file.size, 0),
      progress: members.reduce((sum, file) => sum + file.progress, 0),
      state: members.some(file => file.state === 'sending') ? 'sending'
        : members.some(file => file.state === 'queued' || file.state === 'preparing') ? 'queued'
        : members.some(file => file.state === 'failed') ? 'failed'
        : members.some(file => file.state === 'cancelled') ? 'cancelled' : 'completed',
      fileCount: members.length, error: null
    }));
    return [...groups, ...files];
  }
  emit() { this.onEvent(this.summary()); }
  async add(relative, request) {
    const relativePathValue = relativePath(relative);
    const size = Number(request.headers['content-length']);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE) throw new Error('Invalid or excessive file size');
    const id = randomUUID();
    const item = { id, source: null, relativePath: relativePathValue, name: path.posix.basename(relativePathValue), type: 'file', size, sha256: null, state: 'preparing', progress: 0, downloaded: false, error: null };
    this.items.push(item); this.emit();
    let received = 0;
    const hash = createHash('sha256');
    try {
      this.directoryPromise ??= mkdtemp(path.join(os.tmpdir(), 'phonehaul-send-'));
      this.directory = await this.directoryPromise;
      item.source = path.join(this.directory, id);
      await pipeline(request, new Transform({ transform(chunk, _, next) {
        received += chunk.length;
        hash.update(chunk);
        next(received > size ? new Error('File exceeds declared size') : null, chunk);
      } }), createWriteStream(item.source, { flags: 'wx' }));
      if (received !== size) throw new Error('Incomplete file');
    } catch (error) { if(item.source)await unlink(item.source).catch(() => {}); item.state = 'failed'; item.error = error.message; this.emit(); throw error; }
    item.sha256 = hash.digest('hex'); item.state = 'queued'; this.emit();
    return item;
  }
  next(canSend = true) {
    if (!canSend || this.active) return null;
    const item = this.items.find(i => i.state === 'queued' || i.state === 'preparing');
    if (item?.state === 'preparing') return null;
    if (!item) return null;
    item.state = 'sending'; item.progress = 0; this.active = item; this.emit();
    return item;
  }
  async stream(id, response) {
    const item = this.active;
    if (!item || item.id !== id || item.state !== 'sending') throw new Error('Invalid send item');
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': item.size, 'Cache-Control': 'no-store' });
    this.activeResponse = response;
    response.once('close', () => { if (!response.writableFinished && this.active === item) this.failActive('Download interrupted'); });
    try {
      const stream = createReadStream(item.source);
      for await (const chunk of stream) {
        if (item.state !== 'sending' || response.destroyed) throw new Error('Download interrupted');
        if (!response.write(chunk)) await new Promise((resolve, reject) => {
          const cleanup = () => { response.off('drain', onDrain); response.off('close', onClose); };
          const onDrain = () => { cleanup(); resolve(); };
          const onClose = () => { cleanup(); reject(new Error('Download interrupted')); };
          response.once('drain', onDrain); response.once('close', onClose);
        });
        item.progress += chunk.length;
        this.emit();
      }
      await new Promise((resolve, reject) => {
        const onClose = () => reject(new Error('Download interrupted'));
        response.once('close', onClose);
        response.end(() => { response.off('close', onClose); resolve(); });
      });
      item.downloaded = true; this.activeResponse = null;
    } catch (error) { response.destroy(error); this.failActive(error.message); }
  }
  async finish(id, outcome, error = null) {
    const item = this.active;
    if (!item || item.id !== id || !['completed', 'failed', 'cancelled'].includes(outcome)) throw new Error('Invalid send acknowledgement');
    if (outcome === 'completed' && (!item.downloaded || item.progress !== item.size)) throw new Error('File download is incomplete');
    if (outcome !== 'completed') this.activeResponse?.destroy();
    item.state = outcome; item.error = error; this.active = null; this.activeResponse = null;
    await unlink(item.source).catch(() => {}); this.emit();
    return item;
  }
  failActive(message) {
    if (!this.active) return;
    const item = this.active; this.active = null;
    this.activeResponse?.destroy(); this.activeResponse = null;
    item.state = 'failed'; item.error = message; this.emit();
    unlink(item.source).catch(() => {});
  }
  async remove(id) {
    const item = this.items.find(i => i.id === id);
    if (!item || item.state !== 'queued') throw new Error('Item cannot be removed');
    item.state = 'cancelled';
    await unlink(item.source).catch(() => {}); this.emit();
  }
  async close() { if (this.directory) await rm(this.directory, { recursive: true, force: true }); }
}
