import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, lstat, open, readdir, rename, statfs, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { safeDirectory, safeParent } from '../security/paths.js';
import { validateManifest } from './manifest.js';

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
async function matchesContent(file, item) {
  if (!item.sha256) return false;
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size !== item.size) return false;
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex') === item.sha256;
  } catch {
    return false;
  }
}
async function chooseTarget(parent, name, conflict) {
  let target = path.join(parent, name);
  if (!(await exists(target))) return { target };
  if (conflict === 'skip') return { skipped: true };
  if (conflict === 'replace') {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Cannot replace this destination');
    return { target, replace: true };
  }
  const parsed = path.parse(name);
  for (let n = 1; n < 100_000; n++) {
    target = path.join(parent, `${parsed.name} (${n})${parsed.ext}`);
    if (!(await exists(target))) return { target };
  }
  throw new Error('Too many filename conflicts');
}

export class TransferReceiver {
  constructor(settings, onEvent = () => {}) {
    this.settings = settings;
    this.onEvent = onEvent;
    this.transfer = null;
    this.activeRequest = null;
  }
  async create(input) {
    const manifest = validateManifest(input);
    // A new create request is an explicit request to start over. The previous
    // phone may have gone out of Wi-Fi range before it could cancel its batch.
    if (this.transfer && !this.transfer.finished) this.cancel(this.transfer.transferId);
    for (const item of manifest.items.filter((i) => i.type === 'directory'))
      await safeDirectory(this.settings.destination, item.relativePath);
    const resolved = [];
    for (const item of manifest.items) {
      if (item.type === 'directory') {
        resolved.push({ ...item, status: 'committed' });
        continue;
      }
      const { parent, name } = await safeParent(this.settings.destination, item.relativePath);
      const destination = path.join(parent, name);
      if (await matchesContent(destination, item))
        resolved.push({ ...item, status: 'already_present', destination });
      else if (item.sha256 && this.settings.conflict === 'skip' && (await exists(destination)))
        resolved.push({ ...item, status: 'skipped' });
      else resolved.push({ ...item, status: 'queued' });
    }
    const transferBytes = resolved
      .filter((item) => item.type === 'file' && item.status === 'queued')
      .reduce((total, item) => total + item.size, 0);
    const disk = await statfs(this.settings.destination, { bigint: true });
    const available = disk.bavail * disk.bsize;
    if (BigInt(transferBytes) > available) {
      const error = new Error('Not enough destination space');
      error.status = 507;
      error.available = available.toString();
      throw error;
    }
    this.transfer = {
      ...manifest,
      selectedBytes: manifest.totalBytes,
      totalBytes: transferBytes,
      fileCount: resolved.filter((i) => i.type === 'file').length,
      itemsById: new Map(resolved.map((i) => [i.id, i])),
      itemPaths: new Set(resolved.map((i) => i.relativePath)),
      receivedBytes: 0,
      completedItems: resolved.filter((i) => i.status === 'already_present').length,
      startedAt: Date.now(),
      finished: false,
      cancelled: false,
    };
    this.emit();
    return this.summary();
  }
  async addItem(transferId, input) {
    const t = this.transfer;
    if (!t || t.transferId !== transferId || t.finished || t.cancelled || this.activeRequest)
      throw new Error('Invalid transfer');
    if (t.items.length >= 100_000) throw new Error('Too many transfer items');
    const item = validateManifest({ protocol: 1, operation: t.operation, items: [input] }).items[0];
    if (item.type !== 'file' || t.itemsById.has(item.id) || t.itemPaths.has(item.relativePath))
      throw new Error('Duplicate or invalid transfer item');
    const { parent, name } = await safeParent(this.settings.destination, item.relativePath);
    const destination = path.join(parent, name);
    const status = (await matchesContent(destination, item))
      ? 'already_present'
      : item.sha256 && this.settings.conflict === 'skip' && (await exists(destination))
        ? 'skipped'
        : 'queued';
    if (status === 'queued') {
      const disk = await statfs(this.settings.destination, { bigint: true });
      if (BigInt(item.size) > disk.bavail * disk.bsize) {
        const error = new Error('Not enough destination space');
        error.status = 507;
        throw error;
      }
      t.totalBytes += item.size;
    }
    t.selectedBytes += item.size;
    if (status === 'already_present') t.completedItems++;
    const resolved = { ...item, status, ...(status === 'already_present' ? { destination } : {}) };
    t.items.push(item);
    t.fileCount++;
    t.itemsById.set(item.id, resolved);
    t.itemPaths.add(item.relativePath);
    this.emit();
    return { id: item.id, status };
  }
  summary(includeItems = true) {
    const t = this.transfer;
    if (!t) return null;
    return {
      transferId: t.transferId,
      operation: t.operation,
      totalBytes: t.totalBytes,
      selectedBytes: t.selectedBytes,
      receivedBytes: t.receivedBytes,
      totalItems: t.fileCount,
      completedItems: t.completedItems,
      currentItem: t.currentItem ?? null,
      startedAt: t.startedAt,
      finished: t.finished,
      cancelled: t.cancelled,
      ...(includeItems
        ? {
            items: [...t.itemsById.values()].map(({ id, relativePath, status, destination }) => ({
              id,
              relativePath,
              status,
              destination,
            })),
          }
        : {}),
    };
  }
  emit() {
    this.onEvent(this.summary(false));
  }
  async upload(transferId, fileId, request, sha256) {
    const t = this.transfer;
    if (!t || t.transferId !== transferId || t.finished || t.cancelled)
      throw new Error('Invalid transfer');
    const item = t.itemsById.get(fileId);
    if (!item || item.type !== 'file' || item.status !== 'queued' || this.activeRequest)
      throw new Error('Invalid file state');
    if (
      item.sha256 &&
      (!/^[a-f0-9]{64}$/i.test(sha256 ?? '') || sha256.toLowerCase() !== item.sha256)
    )
      throw new Error('SHA-256 does not match manifest');
    if (!item.sha256 && sha256 != null) throw new Error('Unexpected SHA-256 header');
    if (Number(request.headers['content-length']) !== item.size)
      throw new Error('Content-Length mismatch');
    const { parent, name } = await safeParent(this.settings.destination, item.relativePath);
    if (
      item.sha256 &&
      this.settings.conflict === 'skip' &&
      (await exists(path.join(parent, name)))
    ) {
      request.resume();
      item.status = 'skipped';
      this.emit();
      return { status: 'skipped' };
    }
    const partial = path.join(
      parent,
      `.${name}.${randomBytes(12).toString('hex')}.phonehaul-partial`,
    );
    let bytes = 0;
    const hash = createHash('sha256');
    this.activeRequest = request;
    t.currentItem = item.relativePath;
    item.status = 'sending';
    this.emit();
    const meter = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > item.size) return callback(new Error('Size mismatch'));
        hash.update(chunk);
        t.receivedBytes += chunk.length;
        callback(null, chunk);
      },
    });
    const progress = setInterval(() => this.emit(), 250);
    try {
      await pipeline(request, meter, createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
      if (bytes !== item.size) throw new Error('Size mismatch');
      const digest = hash.digest('hex');
      if (item.sha256 && digest !== item.sha256) throw new Error('SHA-256 mismatch');
      if (
        !item.sha256 &&
        (await matchesContent(path.join(parent, name), { ...item, sha256: digest }))
      ) {
        await unlink(partial);
        item.status = 'already_present';
        item.destination = path.join(parent, name);
        t.completedItems++;
        return {
          status: 'already_present',
          size: bytes,
          sha256: digest,
          destination: item.destination,
        };
      }
      const choice = await chooseTarget(parent, name, this.settings.conflict);
      if (choice.skipped) {
        await unlink(partial);
        item.status = 'skipped';
        return { status: 'skipped' };
      }
      // Windows requires a writable handle for FlushFileBuffers/fsync.
      const file = await open(partial, 'r+');
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      let committedTarget = choice.target;
      if (choice.replace) {
        await rename(partial, committedTarget);
      } else {
        let target = committedTarget;
        try {
          await link(partial, target);
          await unlink(partial);
        } catch (linkError) {
          if (
            linkError.code !== 'ENOTSUP' &&
            linkError.code !== 'EPERM' &&
            linkError.code !== 'EXDEV'
          ) {
            throw linkError;
          }
          // Filesystem does not support hard links (exFAT, FAT32): reserve
          // the target (open 'wx' fails with EEXIST if it exists, so re-run
          // chooseTarget), then commit with rename.
          for (let attempts = 0; attempts < 100; attempts++) {
            try {
              const reserved = await open(target, 'wx');
              await reserved.close();
              break;
            } catch (reserveError) {
              if (reserveError.code !== 'EEXIST') {
                throw reserveError;
              }
              if (attempts === 99) {
                throw new Error('Too many filename conflicts', {
                  cause: reserveError,
                });
              }
              const retry = await chooseTarget(parent, name, this.settings.conflict);
              if (retry.skipped) {
                await unlink(partial);
                item.status = 'skipped';
                this.emit();
                return { status: 'skipped' };
              }
              target = retry.target;
            }
          }
          await rename(partial, target);
          committedTarget = target;
        }
      }
      try {
        const dir = await open(parent, 'r');
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      } catch {
        /* directory sync is unavailable on some systems */
      }
      item.status = 'committed';
      item.destination = committedTarget;
      t.completedItems++;
      return { status: 'committed', size: bytes, sha256: digest, destination: committedTarget };
    } catch (error) {
      item.status = 'failed';
      t.receivedBytes -= bytes;
      await unlink(partial).catch(() => {});
      throw error;
    } finally {
      clearInterval(progress);
      t.currentItem = null;
      if (this.activeRequest === request) this.activeRequest = null;
      this.emit();
    }
  }
  finish(transferId) {
    const t = this.transfer;
    if (!t || t.transferId !== transferId || this.activeRequest)
      throw new Error('Invalid transfer');
    if ([...t.itemsById.values()].some((item) => item.type === 'file' && item.status === 'queued'))
      throw new Error('Transfer has unsent files');
    t.finished = true;
    this.emit();
    return this.summary();
  }
  cancel(transferId) {
    const t = this.transfer;
    if (!t || t.transferId !== transferId) throw new Error('Invalid transfer');
    t.cancelled = true;
    t.finished = true;
    this.activeRequest?.destroy(new Error('Cancelled'));
    this.activeRequest = null;
    this.emit();
    return this.summary();
  }
}

export async function findPartials(root) {
  const result = [];
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith('.phonehaul-partial')) result.push(file);
    }
  }
  await visit(root);
  return result;
}
