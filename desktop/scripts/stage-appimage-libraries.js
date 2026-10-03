import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

if (process.platform !== 'linux') {
  process.exit(0);
}

const architecture = {
  x64: 'x86_64-linux-gnu',
  arm64: 'aarch64-linux-gnu',
  arm: 'arm-linux-gnueabihf',
}[process.arch];

if (!architecture) {
  throw new Error(`Unsupported Linux architecture for AppImage build: ${process.arch}`);
}

const root = path.resolve(import.meta.dirname, '../src-tauri');
const destination = path.join(root, 'bundle-support/libldap.so.2');
const candidates = [
  `/lib/${architecture}/libldap.so.2`,
  `/usr/lib/${architecture}/libldap.so.2`,
  '/lib/libldap.so.2',
  '/usr/lib/libldap.so.2',
];
const source = candidates.find((candidate) => {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
});

if (!source) {
  throw new Error(
    'Cannot find libldap.so.2, required by Debian’s GIO proxy module during AppImage bundling. ' +
      'Install the system runtime package that provides libldap.so.2, then retry.',
  );
}

fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.copyFileSync(fs.realpathSync(source), destination);
console.log(`Staged ${source} for Tauri AppImage dependency scanning.`);
