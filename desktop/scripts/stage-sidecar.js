import { copyFile, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  normalizedPlatform,
  executableExtension,
  seaExecutableName,
} from '../../scripts/shared/platform.js';
const root = path.resolve(import.meta.dirname, '../..');
const platform = normalizedPlatform();
const extension = executableExtension();
const source = path.join(root, 'dist', seaExecutableName());
const target = path.join(root, 'desktop/src-tauri/resources', `phonehaul-server${extension}`);
await mkdir(path.dirname(target), { recursive: true });
await copyFile(source, target);
if (process.platform !== 'win32') await chmod(target, 0o755);
console.log(`Staged ${platform} server sidecar: ${target}`);
