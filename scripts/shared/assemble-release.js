import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validate, officialPattern } from './official.js';
const [version, input = 'release-assets', out = 'assets-release'] = process.argv.slice(2);
if (!officialPattern.test(version)) throw new Error('invalid release identity');
const commit = validate(version);
const required = [
  'receiver-x64',
  'receiver-arm64',
  'desktop-linux',
  'desktop-windows',
  'desktop-macos-arm64',
];
const optional = ['desktop-macos-intel', 'android-signed'];
const patterns = {
  'receiver-x64': [/^phonehaul-linux-x64$/, /^PhoneHaul-x86_64\.AppImage$/],
  'receiver-arm64': [/^phonehaul-linux-arm64$/, /^PhoneHaul-aarch64\.AppImage$/],
  'desktop-linux': [/\.AppImage$/],
  'desktop-windows': [/\.exe$/],
  'desktop-macos-arm64': [/\.dmg$/],
  'desktop-macos-intel': [/\.dmg$/],
  'android-signed': [/\.apk$/, /\.aab$/],
};
const hash = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const records = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('symlinked transport entry');
    const f = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(f);
    else if (entry.name === 'build-info.json')
      records.push({ dir, m: JSON.parse(fs.readFileSync(f)) });
  }
}
walk(input);
const selected = records.filter((r) => r.m.target !== 'android-debug');
for (const id of required)
  if (selected.filter((r) => r.m.target === id).length !== 1)
    throw new Error(`missing/duplicate mandatory target ${id}`);
fs.mkdirSync(out); // never overwrite previous assembled bytes
const outputs = [],
  targets = [];
for (const { dir, m } of selected) {
  if (
    ![...required, ...optional].includes(m.target) ||
    selected.filter((r) => r.m.target === m.target).length !== 1
  )
    throw new Error(`unknown/duplicate target ${m.target}`);
  if (
    m.schema !== 'phonehaul.ci-info/1' ||
    m.commit !== commit ||
    m.dirty ||
    m.version !== version ||
    m.state !== 'succeeded' ||
    !m.environment ||
    !m.configurationDigest ||
    !m.sourceDigest
  )
    throw new Error(`invalid provenance for ${m.target}`);
  for (const pattern of patterns[m.target])
    if (!m.outputs.some((o) => pattern.test(o.file)))
      throw new Error(`mandatory package missing from ${m.target}: ${pattern}`);
  if (m.target === 'android-signed' && !/^[a-f0-9]{64}$/i.test(m.signing ?? ''))
    throw new Error('missing verified Android signer');
  for (const o of m.outputs) {
    if (
      !patterns[m.target].some((p) => p.test(o.file)) &&
      !(m.target === 'desktop-windows' && o.file.endsWith('.msix'))
    )
      throw new Error('unexpected release package type');

    if (path.basename(o.file) !== o.file || !o.size || !/^[a-f0-9]{64}$/.test(o.sha256))
      throw new Error('invalid transport entry');
    const source = path.join(dir, o.file);
    if (
      fs.lstatSync(source).isSymbolicLink() ||
      fs.statSync(source).size !== o.size ||
      hash(source) !== o.sha256
    )
      throw new Error(`transport hash mismatch: ${o.file}`);
    const name = `phonehaul-${version}-${m.target}-${o.file}`;
    fs.copyFileSync(source, path.join(out, name), fs.constants.COPYFILE_EXCL);
    outputs.push({
      ...o,
      file: name,
      target: m.target,
      packageVersion: m.version,
      signing: m.signing,
    });
  }
  targets.push({ ...m, required: required.includes(m.target) });
}
const omissions = optional
  .filter((id) => !targets.some((t) => t.target === id))
  .map((id) => ({
    target: id,
    outcome: 'omitted',
    reason: 'optional target did not produce verified transport; inspect workflow result',
  }));
const manifest = {
  schema: 'phonehaul.release/1',
  version,
  commit,
  tag: `v${version}`,
  state: 'staged',
  standardsCommit: '90bf955cbeb0fdf0a711e255b182f864807b3784',
  targets,
  omissions,
  outputs,
};
fs.writeFileSync(path.join(out, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const sums = fs
  .readdirSync(out)
  .sort()
  .map((f) => `${hash(path.join(out, f))}  ${f}\n`)
  .join('');
fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), sums);
console.log(
  `Verified ${targets.length} targets; optional omissions: ${omissions.map((x) => x.target).join(', ') || 'none'}`,
);
