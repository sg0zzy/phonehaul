// Official identity and complete remote inventory. No mutation except explicit beta reserve.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
export const officialPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-dev\.([1-9]\d*))?$/;
export function compare(a, b) {
  const parse = (s) => {
    const m =
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
        s,
      );
    if (!m) throw new Error(`invalid SemVer ${s}`);
    return m;
  };
  const x = parse(a),
    y = parse(b);
  for (let i = 1; i < 4; i++)
    if (BigInt(x[i]) !== BigInt(y[i])) return BigInt(x[i]) > BigInt(y[i]) ? 1 : -1;
  if (!x[4] || !y[4]) return x[4] === y[4] ? 0 : x[4] ? -1 : 1;
  const p = x[4].split('.'),
    q = y[4].split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === q[i]) continue;
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const pn = /^\d+$/.test(p[i]),
      qn = /^\d+$/.test(q[i]);
    if (pn && qn) return BigInt(p[i]) > BigInt(q[i]) ? 1 : -1;
    if (pn !== qn) return pn ? -1 : 1;
    return p[i] > q[i] ? 1 : -1;
  }
  return 0;
}
export function gh(...args) {
  return execFileSync('gh', args, { cwd: root, encoding: 'utf8' }).trim();
}
export const repository = process.env.GITHUB_REPOSITORY || 'sg0zzy/phonehaul';
export function inventory() {
  // ls-remote failure is fatal. Never allocate from stale/shallow local tags.
  const refs = git('ls-remote', '--tags', 'origin').split('\n').filter(Boolean);
  const tags = refs
    .filter((r) => !r.endsWith('^{}'))
    .map((r) => r.split('\t')[1].replace('refs/tags/', ''));
  const releaseLines = gh(
    'api',
    '--paginate',
    `repos/${repository}/releases?per_page=100`,
    '--jq',
    '.[] | @json',
  );
  const releases = releaseLines
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const ledger = JSON.parse(fs.readFileSync(path.join(root, 'release-reservations.json'), 'utf8'));
  const versions = [...tags, ...releases.map((r) => r.tag_name), ...ledger.abandonedTags].map(
    (tag) => {
      if (!tag.startsWith('v') || !officialPattern.test(tag.slice(1)))
        throw new Error(`unrecognized official history entry ${tag}; reconcile before releasing`);
      return tag.slice(1);
    },
  );
  return { versions: [...new Set(versions)].sort(compare), releases };
}
export function validate(version) {
  if (!officialPattern.test(version)) throw new Error('invalid official identity');
  const tag = `v${version}`;
  if (git('cat-file', '-t', `refs/tags/${tag}`) !== 'tag')
    throw new Error('official tag must be annotated');
  const sha = git('rev-parse', `${tag}^{commit}`);
  const declared = git('show', `${sha}:VERSION`).trim();
  const expected = version.includes('-dev.') ? `${version.split('-')[0]}-dev.0` : version;
  if (declared !== expected)
    throw new Error(`tag/source mismatch: expected ${expected}, got ${declared}`);
  if (git('rev-parse', 'HEAD') !== sha) throw new Error('checkout differs from official tag');
  return sha;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [op, version] = process.argv.slice(2);
  if (op === 'validate') console.log(validate(version));
  else if (op === 'candidate' || op === 'reserved' || op === 'publication') {
    if (!officialPattern.test(version)) throw new Error('invalid official candidate');
    const state = inventory();
    const previous = (
      op === 'publication'
        ? state.releases.filter((r) => !r.draft).map((r) => r.tag_name.slice(1))
        : state.versions
    )
      .filter((v) => v !== version)
      .sort(compare)
      .at(-1);
    if (previous && compare(version, previous) <= 0)
      throw new Error(`version ${version} does not exceed official high-water ${previous}`);
    if (op === 'candidate' && state.versions.includes(version))
      throw new Error(`version ${version} already reserved`);
    console.log(`official ${op} gate: ${version}, previous=${previous ?? 'none'}`);
  } else if (op === 'reserve-beta') {
    const sha = git('rev-parse', `${version || 'HEAD'}^{commit}`);
    const declaration = git('show', `${sha}:VERSION`).trim();
    if (!/^\d+\.\d+\.\d+-dev\.0$/.test(declaration))
      throw new Error('new beta requires committed X.Y.Z-dev.0; explicitly bump first');
    const core = declaration.slice(0, -6);
    const state = inventory();
    const n =
      Math.max(
        0,
        ...state.versions
          .filter((v) => v.startsWith(`${core}-dev.`))
          .map((v) => Number(v.split('-dev.')[1])),
      ) + 1;
    if (!Number.isSafeInteger(n) || n > 998)
      throw new Error('Android beta slot exhausted; select a higher core');
    const candidate = `${core}-dev.${n}`;
    if (state.versions.some((v) => compare(candidate, v) <= 0))
      throw new Error('beta falls below official high-water');
    if (process.env.PHONEHAUL_RESERVE_BETA !== '1') {
      console.log(candidate);
      process.exit(0);
    }
    git('tag', '-a', `v${candidate}`, '-m', `PhoneHaul ${candidate}`, sha);
    // A failed push may have succeeded remotely: retain the local tag and report.
    // Do not reclaim identity or silently retry when the outcome is ambiguous.
    git('push', 'origin', `refs/tags/v${candidate}`);
    if (inventory().versions.some((v) => compare(candidate, v) < 0))
      throw new Error(
        'newer reservation appeared during push; beta remains consumed and must not publish',
      );
    console.log(candidate);
  } else throw new Error('expected validate|candidate|publication|reserve-beta');
}
