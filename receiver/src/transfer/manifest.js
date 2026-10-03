import { randomUUID } from 'node:crypto';
import { relativePath } from '../security/paths.js';

const MAX_ITEMS = 100_000;
export function validateManifest(input) {
  if (
    !input ||
    input.protocol !== 1 ||
    !['copy', 'move'].includes(input.operation) ||
    !Array.isArray(input.items) ||
    input.items.length === 0 ||
    input.items.length > MAX_ITEMS
  )
    throw new Error('Invalid manifest');
  const ids = new Set(),
    paths = new Set();
  let totalBytes = 0;
  const items = input.items.map((item) => {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(item.id) ||
      ids.has(item.id) ||
      !['file', 'directory'].includes(item.type)
    )
      throw new Error('Invalid item');
    const relativePathValue = relativePath(item.relativePath);
    if (paths.has(relativePathValue)) throw new Error('Duplicate destination path');
    ids.add(item.id);
    paths.add(relativePathValue);
    if (item.type === 'directory')
      return { id: item.id, type: 'directory', relativePath: relativePathValue };
    if (
      !Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      (item.sha256 != null &&
        (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256)))
    )
      throw new Error('Invalid file size or SHA-256');
    totalBytes += item.size;
    if (!Number.isSafeInteger(totalBytes)) throw new Error('Transfer too large');
    return {
      id: item.id,
      type: 'file',
      relativePath: relativePathValue,
      size: item.size,
      sha256: item.sha256?.toLowerCase() ?? null,
      modified: Number.isSafeInteger(item.modified) ? item.modified : null,
    };
  });
  return { protocol: 1, operation: input.operation, transferId: randomUUID(), items, totalBytes };
}
