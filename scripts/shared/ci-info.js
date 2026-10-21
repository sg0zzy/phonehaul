// Collect verified job outputs with source/environment and transport hashes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildIdentity, androidVersionCode, msixVersion } from './version.js';
import { sourceIdentity, sourceScope } from './source-identity.js';
const [id, ...patterns] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(id)) throw new Error('invalid target ID');
const out = path.join('ci-output', id);
fs.mkdirSync(out, { recursive: true });
const hash = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const files = [...new Set(patterns.flatMap((p) => [...fs.globSync(p)]))].filter((f) =>
  fs.statSync(f).isFile(),
);
if (!files.length) throw new Error(`no outputs for ${id}`);
const outputs = [];
for (const file of files) {
  const name = path.basename(file);
  const dest = path.join(out, name);
  fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
  outputs.push({ file: name, size: fs.statSync(dest).size, sha256: hash(dest) });
}
const dirty = !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
const identity = buildIdentity();
if (process.env.PHONEHAUL_RELEASE === '1' && dirty)
  throw new Error('official source checkout became dirty');
const tools = { node: process.version };
const wrapper = 'android/gradle/wrapper/gradle-wrapper.properties';
if (fs.existsSync(wrapper))
  tools.gradle = fs.readFileSync(wrapper, 'utf8').match(/gradle-([0-9.]+)-/)?.[1];
const androidConfig = 'android/app/build.gradle.kts';
if (fs.existsSync(androidConfig))
  tools.androidSdk = fs.readFileSync(androidConfig, 'utf8').match(/compileSdk = ([0-9]+)/)?.[1];
const javaVersion = spawnSync('java', ['-version'], { encoding: 'utf8' });
tools.java = (javaVersion.stderr ?? '').match(/version "([^"]+)"/)?.[1] ?? 'not available';
for (const [name, command, args] of [
  ['cargo', 'cargo', ['--version']],
  ['rust', 'rustc', ['--version']],
]) {
  try {
    const r = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    tools[name] = r.trim();
  } catch {
    tools[name] = 'see target log / not applicable';
  }
}
const m = {
  schema: 'phonehaul.ci-info/1',
  target: id,
  state: 'succeeded',
  declaredVersion: fs.readFileSync('VERSION', 'utf8').trim(),
  version: identity.display,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty,
  sourceDigest: { value: sourceIdentity(), algorithm: 'sha256', scope: sourceScope },
  configurationDigest: hash('DEVELOPMENT_STANDARDS.md'),
  lockfiles: Object.fromEntries(
    [
      'package-lock.json',
      'receiver/package-lock.json',
      'desktop/package-lock.json',
      'desktop/src-tauri/Cargo.lock',
      'android/gradle/wrapper/gradle-wrapper.properties',
    ]
      .filter((f) => fs.existsSync(f))
      .map((f) => [f, hash(f)]),
  ),
  runId: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT,
  environment: { os: process.platform, arch: process.arch, tools },
  packageMapping: {
    androidVersionCode: id.startsWith('android')
      ? androidVersionCode(identity, identity.version)
      : undefined,
    msixVersion:
      id === 'desktop-windows'
        ? process.env.MSIX_VERSION || msixVersion(identity.version)
        : undefined,
  },
  optionalPackages:
    id === 'desktop-windows'
      ? [
          {
            id: 'msix',
            outcome: outputs.some((o) => o.file.endsWith('.msix')) ? 'succeeded' : 'skipped',
            reason: 'requires configured Partner Center identity',
          },
        ]
      : [],
  signing:
    id === 'android-signed'
      ? process.env.ANDROID_SIGNER_SHA256
      : 'unsigned/checksum-only or test-only debug',
  outputs,
};
fs.writeFileSync(path.join(out, 'build-info.json'), `${JSON.stringify(m, null, 2)}\n`, {
  flag: 'wx',
});
console.log(
  JSON.stringify({
    target: id,
    source: m.commit,
    head: process.env.PR_HEAD_SHA,
    base: process.env.PR_BASE_SHA,
    merge: process.env.GITHUB_SHA,
  }),
);
