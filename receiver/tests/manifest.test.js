import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeManifest } from '../../protocol/manifest-v1.js';

const item = (overrides) => ({
  id: 'a',
  type: 'file',
  relativePath: 'a.bin',
  size: 3,
  ...overrides,
});
const manifest = (items) => ({ protocol: 1, operation: 'copy', items });

test('manifest normalization lowercases hashes and drops unusable metadata', async () => {
  const hash = 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789';
  const m = normalizeManifest(manifest([item({ sha256: hash, modified: 1.5, extra: 'dropped' })]));
  assert.deepEqual(m.items[0], {
    id: 'a',
    type: 'file',
    relativePath: 'a.bin',
    size: 3,
    sha256: hash.toLowerCase(),
    modified: null,
  });
  assert.equal(m.totalBytes, 3);
  assert.equal(m.operation, 'copy');
});

test('directory items carry no size or hash', async () => {
  const m = normalizeManifest(
    manifest([
      { id: 'd', type: 'directory', relativePath: 'sub', size: 10, sha256: 'z' },
      item({ id: 'b', relativePath: 'sub/b.bin' }),
    ]),
  );
  assert.deepEqual(m.items[0], { id: 'd', type: 'directory', relativePath: 'sub' });
  assert.equal(m.totalBytes, 3);
});

test('file size must be a safe non-negative integer', async () => {
  assert.equal(normalizeManifest(manifest([item({ size: 0 })])).totalBytes, 0);
  assert.equal(normalizeManifest(manifest([item({ size: 2 ** 53 - 1 })])).totalBytes, 2 ** 53 - 1);
  for (const size of [-1, 2 ** 53, 1.5, '3', null]) {
    assert.throws(() => normalizeManifest(manifest([item({ size })])), /Invalid file size/);
  }
  assert.throws(() => normalizeManifest(manifest([item({ sha256: 'zz' })])), /Invalid file size/);
});

test('accumulated size must stay within a safe integer', async () => {
  const big = Number.MAX_SAFE_INTEGER;
  assert.throws(
    () =>
      normalizeManifest(
        manifest([item({ id: 'a', size: big }), item({ id: 'b', relativePath: 'b.bin', size: 2 })]),
      ),
    /Transfer too large/,
  );
});

test('ids and destination paths must be unique', async () => {
  const long = 'a'.repeat(100);
  assert.equal(normalizeManifest(manifest([item({ id: long })])).items[0].id, long);
  assert.throws(() => normalizeManifest(manifest([item({ id: 'a'.repeat(101) })])), /Invalid item/);
  assert.throws(() => normalizeManifest(manifest([item({ id: 'a b' })])), /Invalid item/);
  assert.throws(
    () =>
      normalizeManifest(manifest([item({ id: 'a' }), item({ id: 'a', relativePath: 'b.bin' })])),
    /Invalid item/,
  );
  assert.throws(
    () =>
      normalizeManifest(manifest([item({ id: 'a' }), item({ id: 'b', relativePath: 'a.bin' })])),
    /Duplicate destination path/,
  );
});

test('manifest shape is enforced before items', async () => {
  assert.throws(() => normalizeManifest(null), /Invalid manifest/);
  assert.throws(
    () => normalizeManifest({ protocol: 2, operation: 'copy', items: [item({})] }),
    /Invalid manifest/,
  );
  assert.throws(() => normalizeManifest(manifest([])), /Invalid manifest/);
  assert.throws(
    () => normalizeManifest({ ...manifest([item({})]), operation: 'delete' }),
    /Invalid manifest/,
  );
  assert.throws(
    () =>
      normalizeManifest(manifest(Array.from({ length: 100_001 }, (_, i) => item({ id: `i${i}` })))),
    /Invalid manifest/,
  );
});
