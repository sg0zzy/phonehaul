import path from 'node:path';
import { lstat, mkdir, realpath } from 'node:fs/promises';

import { relativePath } from '../../../protocol/relative-path.js';

export { relativePath };

export async function safeParent(root, relative) {
  const rootReal = await realpath(root);
  const parts = relativePath(relative).split('/');
  let parent = rootReal;
  for (const segment of parts.slice(0, -1)) {
    parent = path.join(parent, segment);
    try {
      await mkdir(parent);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Unsafe destination directory');
  }
  return { parent, name: parts.at(-1) };
}

export async function safeDirectory(root, relative) {
  const { parent, name } = await safeParent(root, relativePath(relative));
  const target = path.join(parent, name);
  try {
    await mkdir(target);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe destination directory');
  return target;
}
