// Canonical source/config input identity. No source archive or secret values.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync as fsExists, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const sourceScope =
  'git tracked + nonignored untracked + android/local.properties + configured AppImage tool hashes and MSIX options; excludes credentials, outputs, caches; symlinks rejected';
export function sourceIdentity() {
  const files = new Set(
    execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
    })
      .toString()
      .split('\0')
      .filter(Boolean),
  );
  files.add('android/local.properties');
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    // Signing material is never copied or hashed. Build tools use it by external reference.
    if (
      /(^|\/)(node_modules|target|dist|local_artifacts|\.build-state)\//.test(file) ||
      /\.(jks|keystore|p12|pem|key)$/.test(file) ||
      /(^|\/)settings\.json$/.test(file)
    )
      continue;
    hash.update(`${file}\0`);
    let st;
    try {
      st = lstatSync(path.join(root, file));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      hash.update('missing\0');
      continue;
    }
    if (st.isSymbolicLink())
      throw new Error(
        `source symlink requires explicit input mapping: ${file} -> ${readlinkSync(path.join(root, file))}`,
      );
    if (!st.isFile()) throw new Error(`unsupported source input (including submodules): ${file}`);
    hash.update(`${st.mode & 0o777}\0`);
    hash.update(
      createHash('sha256')
        .update(readFileSync(path.join(root, file)))
        .digest(),
    );
  }
  // Relevant external tool/config identities, without leaking their private paths.
  for (const key of [
    'MSIX_VERSION',
    'MSIX_IDENTITY_NAME',
    'MSIX_PUBLISHER',
    'APPIMAGE_EXTRACT_AND_RUN',
  ])
    hash.update(`${key}\0${process.env[key] ?? ''}\0`);
  for (const key of ['APPIMAGETOOL', 'APPIMAGE_RUNTIME']) {
    const file = process.env[key];
    if (file && fsExists(file))
      hash.update(`${key}\0`).update(createHash('sha256').update(readFileSync(file)).digest());
  }
  return hash.digest('hex');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(sourceIdentity());
