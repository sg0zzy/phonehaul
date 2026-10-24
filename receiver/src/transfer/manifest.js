import { randomUUID } from 'node:crypto';
import { normalizeManifest } from '../../../protocol/manifest-v1.js';

export function validateManifest(input) {
  const manifest = normalizeManifest(input);
  return {
    protocol: manifest.protocol,
    operation: manifest.operation,
    transferId: randomUUID(),
    items: manifest.items,
    totalBytes: manifest.totalBytes,
  };
}
