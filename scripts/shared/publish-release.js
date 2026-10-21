// Trusted aggregate publisher. No compilation, no store delivery, no asset replacement.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gh, inventory, compare, repository, validate } from './official.js';
const [version, dir = 'assets-release', notes = 'RELEASE_NOTES.md', mode = 'publish'] =
  process.argv.slice(2);
const commit = validate(version),
  tag = `v${version}`,
  beta = version.includes('-dev.');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'release-manifest.json')));
if (manifest.version !== version || manifest.commit !== commit)
  throw new Error('assembled manifest mismatch');
const hash = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const files = fs.readdirSync(dir).sort(),
  expected = Object.fromEntries(files.map((f) => [f, hash(path.join(dir, f))]));
let state = inventory(),
  release = state.releases.find((r) => r.tag_name === tag);
if (release && release.prerelease !== beta) throw new Error('existing release channel mismatch');
if (!release) {
  gh(
    'release',
    'create',
    tag,
    '--repo',
    repository,
    '--draft',
    ...(beta ? ['--prerelease'] : []),
    '--verify-tag',
    '--title',
    `PhoneHaul ${version}`,
    '--notes-file',
    notes,
  );
  release = JSON.parse(gh('api', `repos/${repository}/releases/tags/${tag}`));
}
if (release.draft) {
  const existing = new Set(release.assets.map((a) => a.name));
  const missing = files.filter((f) => !existing.has(f));
  if (missing.length)
    gh(
      'release',
      'upload',
      tag,
      '--repo',
      repository,
      '--',
      ...missing.map((f) => path.join(dir, f)),
    );
}
// Verify final remote bytes, including the manifest/checksum files. Timeout recovery
// queries existing release state; a visible release is never uploaded over.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phonehaul-release-'));
try {
  gh('release', 'download', tag, '--repo', repository, '--dir', temp);
  if (JSON.stringify(fs.readdirSync(temp).sort()) !== JSON.stringify(files))
    throw new Error('remote mandatory assets differ from verified set');
  for (const f of files)
    if (hash(path.join(temp, f)) !== expected[f])
      throw new Error(`remote asset differs: ${f}; incident/new-version handling required`);
} finally {
  fs.rmSync(temp, { recursive: true });
}
if (mode === 'stage') {
  console.log(
    `Staged ${tag}; review draft notes and manifest before approving release-publication.`,
  );
  process.exit(0);
}
state = inventory();
const newer = state.releases.filter(
  (r) => !r.draft && r.tag_name !== tag && compare(r.tag_name.slice(1), version) >= 0,
);
if (release.draft && newer.length)
  throw new Error('reservation superseded; retain draft and immutable tag');
if (!release.draft) {
  console.log('Already published with identical assets; no changes.');
  process.exit(0);
}
// Regenerate only to confirm the baseline; keep the human-reviewed draft body.
execFileSync('node', ['scripts/shared/release-notes.js', version, notes], { stdio: 'inherit' });
const baseline = fs
  .readFileSync(notes, 'utf8')
  .split('\n')
  .find((line) => line.startsWith('Baseline:'));
release = JSON.parse(gh('api', `repos/${repository}/releases/${release.id}`));
if (!release.body?.includes(baseline))
  throw new Error('stable baseline changed; regenerate/review draft notes before retry');
const body = release.body;
if (process.env.PHONEHAUL_NOTES_REVIEWED !== '1')
  throw new Error(
    'release notes need artifact-bound human review in release-publication environment',
  );
gh(
  'api',
  '--method',
  'PATCH',
  `repos/${repository}/releases/${release.id}`,
  '-F',
  'draft=false',
  '-F',
  `prerelease=${beta}`,
  '-f',
  `make_latest=${beta ? 'false' : 'true'}`,
  '-f',
  `body=${body}`,
);
const result = JSON.parse(gh('api', `repos/${repository}/releases/${release.id}`));
if (result.draft || result.prerelease !== beta)
  throw new Error('publication state did not match requested channel');
if (beta) {
  const latest = state.releases
    .filter((r) => !r.draft && !r.prerelease)
    .sort((a, b) => compare(a.tag_name.slice(1), b.tag_name.slice(1)))
    .at(-1);
  if (latest) {
    const actual = JSON.parse(gh('api', `repos/${repository}/releases/latest`));
    if (actual.tag_name !== latest.tag_name) throw new Error('beta altered latest stable');
  }
}
console.log(`Published ${tag}; external delivery remains manual/disabled.`);
