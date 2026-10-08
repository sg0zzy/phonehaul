import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, lstat, mkdir, readdir, symlink, writeFile, rm } from 'node:fs/promises';
import { relativePath, safeDirectory } from '../src/security/paths.js';

test('rejects control characters in relative path segments', () => {
  for (const value of ['a/\x07b', 'a/b\x1f', 'a/\x7f', 'a\x00b', 'a/\x0b/b'])
    assert.throws(() => relativePath(value), /Invalid relative path/);
  assert.equal(relativePath('a/b'), 'a/b');
});

test('safeDirectory refuses symlinked and non-directory destinations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-safe-dir-'));
  try {
    await mkdir(path.join(root, 'real'));
    await symlink(path.join(root, 'real'), path.join(root, 'link'));
    await writeFile(path.join(root, 'file'), 'not a directory');
    await assert.rejects(() => safeDirectory(root, 'link'), /Unsafe destination directory/);
    await assert.rejects(() => safeDirectory(root, 'link/inner'), /Unsafe destination directory/);
    await assert.rejects(() => safeDirectory(root, 'file'), /Unsafe destination directory/);
    const target = await safeDirectory(root, 'nested/deep');
    assert.equal(target, path.join(root, 'nested', 'deep'));
    assert.ok((await lstat(target)).isDirectory());
    assert.deepEqual((await readdir(root)).sort(), ['file', 'link', 'nested', 'real']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
