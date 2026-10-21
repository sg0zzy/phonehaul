// Explicit version operations; this program is never called by a build.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCanonical, androidVersionCode, readCanonical } from './version.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const raw = process.argv.slice(2),
  dry = raw.includes('--dry-run');
const args = raw.filter((a) => a !== '--dry-run');
const [op, selection, description] = args;
if (!['bump', 'set', 'prepare'].includes(op)) throw new Error('expected bump|set|prepare');
const before = fs.readFileSync(path.join(root, 'VERSION'), 'utf8');
const v = readCanonical();
let after;
if (op === 'bump') {
  const parts = [v.major, v.minor, v.patch];
  const i = ['major', 'minor', 'patch'].indexOf(selection);
  if (i < 0) throw new Error('expected major|minor|patch');
  parts[i]++;
  for (let j = i + 1; j < 3; j++) parts[j] = 0;
  after = `${parts.join('.')}-dev.0`;
} else {
  after = selection;
  if (op === 'set' && !/^\d+\.\d+\.\d+-dev\.0$/.test(after))
    throw new Error('set selects X.Y.Z-dev.0; use release prepare to finalize stable');
  if (op === 'prepare' && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(after))
    throw new Error('stable target must be exact X.Y.Z');
}
const candidate = parseCanonical(after);
androidVersionCode({ official: op === 'prepare', devN: 1 }, candidate);
const greaterCore = [candidate.major, candidate.minor, candidate.patch].findIndex(
  (n, i) => n !== [v.major, v.minor, v.patch][i],
);
if (
  greaterCore < 0
    ? op !== 'prepare' || (!v.dev && before.trim() !== after)
    : [candidate.major, candidate.minor, candidate.patch][greaterCore] <
      [v.major, v.minor, v.patch][greaterCore]
)
  throw new Error('version would regress or repeat development state');
console.log(
  `VERSION: ${before.trim()} -> ${after}; validate platform adapter and npm run check; metadata-only commit${op === 'prepare' ? `; annotated tag v${after}` : ''}; no remote actions`,
);
console.log(
  `Commit description: ${description || `chore: ${op === 'prepare' ? 'release' : 'bump version to'} ${after}`}`,
);
if (dry) {
  console.log(
    'Dry-run: no files, index, counters or refs changed. Execution requires a clean tree and complete official history checks.',
  );
  process.exit(0);
}
if (git('status', '--porcelain'))
  throw new Error('working tree/index must be clean, including untracked files');
if (op === 'prepare')
  execFileSync('node', [path.join(root, 'scripts/shared/official.js'), 'candidate', after], {
    cwd: root,
    stdio: 'inherit',
  });
const head = git('rev-parse', 'HEAD');
execFileSync('npm', ['run', 'check'], { cwd: root, stdio: 'inherit' });
if (git('rev-parse', 'HEAD') !== head || git('status', '--porcelain'))
  throw new Error('validation changed HEAD/tree/index; no version edits made');
let commit = head;
try {
  if (before.trim() !== after) {
    fs.writeFileSync(path.join(root, 'VERSION'), `${after}\n`);
    // Build the commit using a private index. Real staged entries are untouched.
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phonehaul-version-'));
    const indexPath = path.resolve(root, git('rev-parse', '--git-path', 'index'));
    const indexLock = `${indexPath}.lock`;
    let ownsIndexLock = false;
    try {
      fs.closeSync(fs.openSync(indexLock, 'wx'));
      ownsIndexLock = true;
      const env = { ...process.env, GIT_INDEX_FILE: path.join(temp, 'index') };
      const run = (...a) => execFileSync('git', a, { cwd: root, env, encoding: 'utf8' }).trim();
      run('read-tree', head);
      run('add', '--', 'VERSION');
      const tree = run('write-tree');
      const diff = git('diff', '--name-only');
      if (
        git('rev-parse', 'HEAD') !== head ||
        git('diff', '--cached', '--name-only') ||
        diff !== 'VERSION' ||
        fs.readFileSync(path.join(root, 'VERSION'), 'utf8') !== `${after}\n`
      )
        throw new Error('concurrent source/index change; VERSION left as resumable checkpoint');
      commit = execFileSync('git', ['commit-tree', tree, '-p', head], {
        cwd: root,
        input: `${description || `chore: ${op === 'prepare' ? 'release' : 'bump version to'} ${after}`}\n`,
        encoding: 'utf8',
      }).trim();
      // Commit only the private metadata tree, then atomically reconcile the
      // corresponding index while cooperating Git writers remain locked out.
      fs.copyFileSync(env.GIT_INDEX_FILE, indexLock);
      git('update-ref', 'HEAD', commit, head);
      fs.renameSync(indexLock, indexPath);
      ownsIndexLock = false;
    } finally {
      if (ownsIndexLock) fs.rmSync(indexLock, { force: true });
      fs.rmSync(temp, { recursive: true });
    }
  }
  console.log(`Version commit: ${commit}`);
  if (op === 'prepare') {
    git('tag', '-a', `v${after}`, '-m', `PhoneHaul v${after}`, commit);
    console.log(`Created annotated local tag v${after}; no push performed.`);
  }
} catch (error) {
  console.error(
    `Preparation stopped. HEAD=${git('rev-parse', 'HEAD')}; intended version=${after}. Inspect VERSION/index and any local tag before retry; no destructive rollback performed.`,
  );
  throw error;
}
