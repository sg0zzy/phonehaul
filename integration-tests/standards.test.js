import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { compare } from '../scripts/shared/official.js';
import { androidVersionCode, parseCanonical } from '../scripts/shared/version.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phonehaul-standards-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(new URL('../scripts', import.meta.url), path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.mkdirSync(path.join(dir, 'local_artifacts'));
  const run = (...args) =>
    spawnSync(process.execPath, ['scripts/shared/artifacts.js', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PHONEHAUL_ARTIFACTS_DIR: path.join(dir, 'local_artifacts') },
    });
  const build = (name, seq, extra = {}) => {
    const target = path.join(dir, 'local_artifacts', name);
    fs.mkdirSync(target);
    const m = {
      schema: 'phonehaul.build-info/2',
      manager: 'scripts/build.sh',
      buildId: name,
      state: 'succeeded',
      completionSeq: seq,
      completedAt: new Date().toISOString(),
      version: '0.1.1-local.1',
      commit: 'a'.repeat(40),
      sourceDigest: { value: 'a'.repeat(64) },
      outputs: [{ file: 'test.bin', size: 1, sha256: 'a'.repeat(64) }],
      ...extra,
    };
    fs.writeFileSync(path.join(target, 'build-info.json'), JSON.stringify(m));
    return target;
  };
  return { dir, run, build };
}

test('SemVer precedence uses numeric identifiers and ignores build metadata', () => {
  for (const [a, b] of [
    ['0.9.7', '0.10.0'],
    ['0.10.0', '1.0.0'],
    ['0.9.5-dev.2', '0.9.5-dev.10'],
    ['0.9.5-dev.10', '0.9.5'],
    ['0.9.5-dev.99', '0.9.6-dev.1'],
    ['0.9.5-dev.2', '0.9.5-local.1'],
  ])
    assert.equal(compare(a, b), -1);
  assert.equal(compare('0.9.5-dev.2+one', '0.9.5-dev.2+two'), 0);
});

test('Android code ordering is retained at slot/core boundaries and rejects overflow', () => {
  const code = (v, opts) => androidVersionCode(opts, parseCanonical(v));
  assert.ok(code('0.1.1-dev.0', { devN: 998 }) < code('0.1.1', { official: true }));
  assert.ok(code('0.1.1', { official: true }) < code('0.1.2-dev.0', { devN: 1 }));
  assert.ok(code('0.99.999', { official: true }) < code('1.0.0-dev.0', { devN: 1 }));
  assert.ok(code('20.99.999', { official: true }) <= 2100000000);
  for (const devN of [0, -1, 1.5, 999, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => code('0.1.1-dev.0', { devN }));
  assert.throws(() => code('21.0.0', { official: true }));
});

test('retention orders by completion sequence, protects any .keep, skips failed/unknown/ambiguous', (t) => {
  const { dir, run, build } = fixture(t);
  const old = build('old', 1, { completedAt: '2099-01-01T00:00:00Z' });
  const newest = build('new', 2, { completedAt: '2000-01-01T00:00:00Z' });
  const protectedDir = build('protected', 3);
  fs.mkdirSync(path.join(protectedDir, '.keep'));
  build('failed', 4, { state: 'failed' });
  build('active', 5, { state: 'in_progress' });
  build('ambiguous-a', 6);
  build('ambiguous-b', 6);
  build('malformed', 7, { outputs: [{ file: '../outside', size: 1, sha256: 'a'.repeat(64) }] });
  fs.mkdirSync(path.join(dir, 'local_artifacts', 'unknown'));
  assert.equal(run('clean', '1', '--dry-run').status, 0);
  assert.ok(fs.existsSync(old));
  const result = run('clean', '1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(newest));
  for (const name of [
    'protected',
    'failed',
    'active',
    'ambiguous-a',
    'ambiguous-b',
    'malformed',
    'unknown',
  ])
    assert.ok(fs.existsSync(path.join(dir, 'local_artifacts', name)));
  assert.equal(run('clean', '0').status, 0);
  assert.equal(fs.existsSync(newest), false);
  assert.ok(fs.existsSync(protectedDir));
});

test('storage rejects symlink roots/children, preserves symlink .keep targets and dry-run mutations', (t) => {
  const { dir, run, build } = fixture(t);
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'precious'), 'keep');
  fs.symlinkSync(outside, path.join(dir, 'local_artifacts', 'alias'));
  const own = build('own', 1);
  fs.symlinkSync(path.join(outside, 'precious'), path.join(own, '.keep'));
  assert.equal(run('protect', 'own').status, 0);
  assert.equal(fs.readFileSync(path.join(outside, 'precious'), 'utf8'), 'keep');
  assert.equal(run('remove', 'own', '--yes', '--dry-run').status, 0);
  assert.ok(fs.existsSync(own));
  assert.notEqual(run('unprotect', 'own').status, 0);
  assert.equal(run('clean', '0').status, 0);
  assert.ok(fs.existsSync(own));
  assert.notEqual(run('remove', 'alias', '--yes').status, 0);
  assert.ok(fs.existsSync(outside));
  fs.renameSync(path.join(dir, 'local_artifacts'), path.join(dir, 'original'));
  fs.symlinkSync(outside, path.join(dir, 'local_artifacts'));
  assert.notEqual(run('clean', '0').status, 0);
  assert.ok(fs.existsSync(path.join(outside, 'precious')));
});

test('local counters survive retention and refuse ledger loss/corruption', (t) => {
  const { dir, run } = fixture(t);
  assert.equal(run('counter', '0.1.1').stdout.trim(), '1');
  assert.equal(run('counter', '0.1.1').stdout.trim(), '2');
  assert.equal(run('counter', '0.2.0').stdout.trim(), '1');
  assert.equal(run('counter', '0.1.1').stdout.trim(), '3');
  const ledger = path.join(dir, '.build-state', 'artifact-counters.json');
  const contents = fs.readFileSync(ledger);
  fs.unlinkSync(ledger);
  assert.notEqual(run('counter', '0.1.1').status, 0);
  fs.writeFileSync(ledger, contents);
  assert.equal(run('counter', '0.1.1').stdout.trim(), '4');
  fs.writeFileSync(ledger, 'bad json');
  assert.notEqual(run('counter', '0.1.1').status, 0);
  fs.rmSync(path.join(dir, '.build-state'), { recursive: true });
  assert.notEqual(run('counter', '0.1.1').status, 0);
});

test('source identity includes untracked/ignored config and tracked deletions', (t) => {
  const { dir } = fixture(t);
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  fs.writeFileSync(
    path.join(dir, '.gitignore'),
    'local_artifacts/\n.build-state/\nandroid/local.properties\n',
  );
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one');
  execFileSync('git', ['add', 'tracked.txt', '.gitignore'], { cwd: dir });
  const digest = () =>
    execFileSync(process.execPath, ['scripts/shared/source-identity.js'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
  const a = digest();
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'two');
  const b = digest();
  assert.notEqual(a, b);
  fs.mkdirSync(path.join(dir, 'android'));
  fs.writeFileSync(path.join(dir, 'android/local.properties'), 'sdk.dir=/test');
  const c = digest();
  assert.notEqual(b, c);
  fs.unlinkSync(path.join(dir, 'tracked.txt'));
  assert.notEqual(c, digest());
});

test('bump and stable dry-runs preserve VERSION, index, refs and counter state', (t) => {
  const { dir } = fixture(t);
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'VERSION'), '0.5.4-dev.12\n');
  execFileSync('git', ['add', 'VERSION'], { cwd: dir });
  const index = fs.readFileSync(path.join(dir, '.git', 'index'));
  for (const [op, arg, expected] of [
    ['bump', 'patch', '0.5.5-dev.0'],
    ['bump', 'minor', '0.6.0-dev.0'],
    ['bump', 'major', '1.0.0-dev.0'],
    ['prepare', '0.5.5', '0.5.5'],
  ]) {
    const r = spawnSync(
      process.execPath,
      ['scripts/shared/version-operation.js', op, arg, '--dry-run'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(expected));
    assert.equal(fs.readFileSync(path.join(dir, 'VERSION'), 'utf8'), '0.5.4-dev.12\n');
    assert.deepEqual(fs.readFileSync(path.join(dir, '.git', 'index')), index);
  }
  assert.equal(fs.existsSync(path.join(dir, '.build-state')), false);
  const dirty = spawnSync(
    process.execPath,
    ['scripts/shared/version-operation.js', 'bump', 'patch'],
    { cwd: dir, encoding: 'utf8' },
  );
  assert.notEqual(dirty.status, 0);
  assert.equal(fs.existsSync(path.join(dir, '.git', 'refs', 'heads', 'master')), false);
});

// These transport/history tests simulate Git responses only; they create no
// application commits/tags and do not prove native package installation.
function fakeGit(t, dir, response) {
  const bin = path.join(dir, 'fake-bin');
  fs.mkdirSync(bin);
  const command = path.join(bin, 'git');
  fs.writeFileSync(command, `#!/usr/bin/env node\nconst a=process.argv.slice(2);\n${response}\n`);
  fs.chmodSync(command, 0o755);
  return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}

test('aggregate release gate requires every mandatory package and verifies transport hashes', (t) => {
  const { dir } = fixture(t);
  const env = fakeGit(
    t,
    dir,
    `if(a[0]==='cat-file')console.log('tag');else if(a[0]==='show')console.log('0.2.0');else if(a[0]==='rev-parse')console.log('${'a'.repeat(40)}');else process.exit(1);`,
  );
  const input = path.join(dir, 'input');
  fs.mkdirSync(input);
  const run = (out) =>
    spawnSync(process.execPath, ['scripts/shared/assemble-release.js', '0.2.0', 'input', out], {
      cwd: dir,
      env,
      encoding: 'utf8',
    });
  assert.notEqual(run('missing').status, 0);
  const targets = {
    'receiver-x64': ['phonehaul-linux-x64', 'PhoneHaul-x86_64.AppImage'],
    'receiver-arm64': ['phonehaul-linux-arm64', 'PhoneHaul-aarch64.AppImage'],
    'desktop-linux': ['PhoneHaul.AppImage'],
    'desktop-windows': ['PhoneHaul.exe'],
    'desktop-macos-arm64': ['PhoneHaul.dmg'],
  };
  const digest = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import {createHash} from 'node:crypto'; console.log(createHash('sha256').update('package').digest('hex'));",
    ],
    { encoding: 'utf8' },
  ).trim();
  for (const [target, files] of Object.entries(targets)) {
    const destination = path.join(input, target);
    fs.mkdirSync(destination);
    for (const file of files) fs.writeFileSync(path.join(destination, file), 'package');
    fs.writeFileSync(
      path.join(destination, 'build-info.json'),
      JSON.stringify({
        schema: 'phonehaul.ci-info/1',
        target,
        commit: 'a'.repeat(40),
        dirty: false,
        version: '0.2.0',
        state: 'succeeded',
        environment: { os: 'fixture' },
        configurationDigest: 'b'.repeat(64),
        sourceDigest: { value: 'c'.repeat(64) },
        outputs: files.map((file) => ({ file, size: 7, sha256: digest })),
      }),
    );
  }
  const valid = run('valid');
  assert.equal(valid.status, 0, valid.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'valid', 'release-manifest.json')));
  assert.equal(manifest.targets.length, 5);
  assert.equal(manifest.omissions.length, 2);
  assert.notEqual(run('valid').status, 0); // prior final bytes are not overwritten
  fs.writeFileSync(path.join(input, 'desktop-windows', 'PhoneHaul.exe'), 'corrupt');
  const corrupt = run('corrupt');
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /transport hash mismatch/);
});

test('official allocation considers failed remote tags and blocks unrecognized history', (t) => {
  const { dir } = fixture(t);
  const env = fakeGit(
    t,
    dir,
    `if(a[0]==='ls-remote')console.log('${'a'.repeat(40)}\\trefs/tags/'+(process.env.BAD_HISTORY?'vunknown':'v0.9.6-dev.1'));else process.exit(1);`,
  );
  const gh = path.join(dir, 'fake-bin', 'gh');
  fs.writeFileSync(gh, '#!/usr/bin/env node\nconsole.log("");\n');
  fs.chmodSync(gh, 0o755);
  fs.writeFileSync(path.join(dir, 'release-reservations.json'), '{"abandonedTags":[]}');
  const run = (v, extra = {}) =>
    spawnSync(process.execPath, ['scripts/shared/official.js', 'candidate', v], {
      cwd: dir,
      env: { ...env, ...extra },
      encoding: 'utf8',
    });
  assert.notEqual(run('0.9.5').status, 0);
  assert.equal(run('0.9.7').status, 0);
  assert.notEqual(run('0.9.6-dev.1').status, 0);
  assert.notEqual(run('0.9.7', { BAD_HISTORY: '1' }).status, 0);
});

test('share staging is host-gated, atomic, never overwrites and never fails the build', (t) => {
  const { dir } = fixture(t);
  const src = path.join(dir, 'src-build');
  fs.mkdirSync(path.join(src, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(src, 'app.bin'), 'payload');
  fs.writeFileSync(path.join(src, 'nested', 'inner.txt'), 'x');
  const publish = (env) =>
    spawnSync(
      'bash',
      ['-c', 'source scripts/common.sh && phonehaul_publish_to_share "$1"', '_', src],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } },
    );
  const share = path.join(dir, 'share');
  const host = { PHONEHAUL_HOSTNAME: 'someworkstation', PHONEHAUL_ARTIFACT_SHARE: share };
  const off = publish(host);
  assert.equal(off.status, 0);
  assert.ok(!fs.existsSync(share), 'a non-publish host must not create the share');
  // FQDN detection must reduce to the short hostname before matching.
  const on = publish({ ...host, PHONEHAUL_HOSTNAME: 'AI395.example' });
  assert.equal(on.status, 0);
  const dest = path.join(share, 'phonehaul', 'src-build');
  assert.equal(fs.readFileSync(path.join(dest, 'app.bin'), 'utf8'), 'payload');
  assert.equal(fs.readFileSync(path.join(dest, 'nested', 'inner.txt'), 'utf8'), 'x');
  assert.deepEqual(fs.readdirSync(path.join(share, 'phonehaul')), ['src-build']);
  // A second publication must keep the existing bytes and say so.
  fs.writeFileSync(path.join(dest, 'app.bin'), 'stale');
  const again = publish({ ...host, PHONEHAUL_HOSTNAME: 'AI395' });
  assert.equal(again.status, 0);
  assert.match(again.stderr, /already holds/);
  assert.equal(fs.readFileSync(path.join(dest, 'app.bin'), 'utf8'), 'stale');
  // An unusable share root must warn without failing the invocation.
  const blocked = path.join(dir, 'blocked');
  fs.writeFileSync(blocked, 'not a directory');
  const bad = publish({ PHONEHAUL_HOSTNAME: 'AI395', PHONEHAUL_ARTIFACT_SHARE: blocked });
  assert.equal(bad.status, 0);
  assert.match(bad.stderr, /share publication to .* failed/);
  assert.deepEqual(fs.readdirSync(path.join(share, 'phonehaul')), ['src-build']);
});
