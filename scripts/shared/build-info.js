// Atomic completion of a local build. The caller holds the storage lock.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { sourceScope } from './source-identity.js';
const [dir, product, platforms, ...files] = process.argv.slice(2);
const env = process.env;
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const target = path.join(dir, 'build-info.json');
const initial = JSON.parse(fs.readFileSync(target));
if (initial.state !== 'in_progress' || initial.buildId !== env.PHONEHAUL_BUILD_ID)
  throw new Error('unrecognized build reservation');
const completionSeq = Number(env.PHONEHAUL_COMPLETION_SEQ);
if (!Number.isSafeInteger(completionSeq) || completionSeq < 1)
  throw new Error('invalid completion sequence');
const tools = { node: process.version };
const wrapper = path.join(project, 'android/gradle/wrapper/gradle-wrapper.properties');
if (fs.existsSync(wrapper))
  tools.gradle = fs.readFileSync(wrapper, 'utf8').match(/gradle-([0-9.]+)-/)?.[1];
const androidConfig = path.join(project, 'android/app/build.gradle.kts');
if (fs.existsSync(androidConfig))
  tools.androidSdk = fs.readFileSync(androidConfig, 'utf8').match(/compileSdk = ([0-9]+)/)?.[1];
const javaVersion = spawnSync('java', ['-version'], { encoding: 'utf8' });
tools.java = (javaVersion.stderr ?? '').match(/version "([^"]+)"/)?.[1] ?? 'not available';
for (const [name, cmd, args] of [
  ['rust', 'rustc', ['--version']],
  ['cargo', 'cargo', ['--version']],
]) {
  try {
    tools[name] = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    tools[name] = 'not available / see target build log';
  }
}
const m = {
  ...initial,
  product,
  platforms: platforms.split(' '),
  declaredVersion: fs.readFileSync(path.join(project, 'VERSION'), 'utf8').trim(),
  version: env.PHONEHAUL_VERSION,
  core: env.PHONEHAUL_CORE,
  channel: 'local',
  state: 'succeeded',
  completedAt: new Date().toISOString(),
  completionSeq,
  commit: env.PHONEHAUL_COMMIT,
  dirty: env.PHONEHAUL_DIRTY === '1',
  configurationDigest: hash(path.join(project, 'DEVELOPMENT_STANDARDS.md')),
  sourceDigest: { value: env.PHONEHAUL_SOURCE_DIGEST, algorithm: 'sha256', scope: sourceScope },
  environment: { os: process.platform, arch: process.arch, tools },
  targets: JSON.parse(env.PHONEHAUL_TARGETS_JSON),
  lockfiles: Object.fromEntries(
    [
      'package-lock.json',
      'receiver/package-lock.json',
      'desktop/package-lock.json',
      'desktop/src-tauri/Cargo.lock',
      'android/gradle/wrapper/gradle-wrapper.properties',
    ]
      .filter((f) => fs.existsSync(path.join(project, f)))
      .map((f) => [f, hash(path.join(project, f))]),
  ),
  outputs: files.map((f) => {
    const relative = path.relative(dir, f);
    if (relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(f).isSymbolicLink())
      throw new Error('artifact escapes build directory');
    return {
      file: relative,
      size: fs.statSync(f).size,
      sha256: hash(f),
      packageVersion: env.PHONEHAUL_VERSION,
      signing: relative.endsWith('.apk') ? 'test-only debug signer' : 'unsigned/checksum-only',
    };
  }),
};
if (!m.outputs.length || m.targets.some((t) => t.outcome !== 'succeeded'))
  throw new Error('incomplete target outcomes');
const tmp = `${target}.tmp-${process.pid}`;
fs.writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`, { flag: 'wx' });
fs.renameSync(tmp, target);
