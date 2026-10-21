// Storage transactions. Caller holds the lock adjacent to local_artifacts/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = path.join(project, 'local_artifacts');
const stateDir = path.join(project, '.build-state');
const schema = 'phonehaul.build-info/2';
const manager = 'scripts/build.sh';
const [op, value, ...args] = process.argv.slice(2);
if (op === 'counter' && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
  throw new Error('invalid counter core');
function fail(message) {
  throw new Error(message);
}
function atomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(tmp, file);
}
function safeRoot() {
  if (
    process.env.PHONEHAUL_ARTIFACTS_DIR &&
    path.resolve(process.env.PHONEHAUL_ARTIFACTS_DIR) !== root
  )
    fail('artifact root must be repository local_artifacts/');
  if (
    fs.existsSync(root) &&
    (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root)
  )
    fail('symlinked artifact root refused');
}
function child(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) fail('invalid build ID');
  const dir = path.join(root, name);
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(dir) !== dir)
    fail('not a direct managed directory');
  return { dir, st };
}
function read(name) {
  const { dir, st } = child(name);
  const f = path.join(dir, 'build-info.json');
  if (!fs.lstatSync(f).isFile() || fs.lstatSync(f).isSymbolicLink()) fail('invalid manifest file');
  const m = JSON.parse(fs.readFileSync(f));
  if (
    m.schema !== schema ||
    m.manager !== manager ||
    m.buildId !== name ||
    !['in_progress', 'failed', 'succeeded'].includes(m.state)
  )
    fail('unknown schema/manager/identity/state');
  if (
    m.state === 'succeeded' &&
    (!Number.isSafeInteger(m.completionSeq) ||
      m.completionSeq < 1 ||
      !Number.isFinite(Date.parse(m.completedAt)) ||
      !Array.isArray(m.outputs) ||
      !m.outputs.length)
  )
    fail('malformed successful manifest');
  if (
    m.state === 'succeeded' &&
    (typeof m.version !== 'string' ||
      !/^[a-f0-9]{40}$/.test(m.commit ?? '') ||
      !/^[a-f0-9]{64}$/.test(m.sourceDigest?.value ?? '') ||
      m.outputs.some(
        (o) =>
          typeof o.file !== 'string' ||
          o.file.split('/').some((p) => p === '..' || p === '') ||
          path.isAbsolute(o.file) ||
          !Number.isSafeInteger(o.size) ||
          o.size < 0 ||
          !/^[a-f0-9]{64}$/.test(o.sha256 ?? ''),
      ))
  )
    fail('malformed successful identity/artifacts');
  return {
    dir,
    st,
    m,
    protected:
      fs.existsSync(path.join(dir, '.keep')) ||
      (() => {
        try {
          fs.lstatSync(path.join(dir, '.keep'));
          return true;
        } catch {
          return false;
        }
      })(),
  };
}
safeRoot();
if (op === 'counter' || op === 'sequence') {
  fs.mkdirSync(stateDir, { recursive: true });
  const ledger = path.join(stateDir, 'artifact-counters.json');
  // Sentinel survives a lost ledger so identities cannot silently restart after retention.
  const sentinel = path.join(stateDir, 'artifact-counters.initialized');
  const recoveryMarker = path.join(project, '.phonehaul-local-counter-initialized');
  let state = { sequence: 0, counters: {} };
  if (fs.existsSync(ledger)) state = JSON.parse(fs.readFileSync(ledger));
  else if (fs.existsSync(sentinel) || fs.existsSync(recoveryMarker))
    fail('counter ledger missing; restore from backup or reconcile high-water explicitly');
  else if (fs.existsSync(root) && fs.readdirSync(root).length) {
    // First adoption only: old dev.N archives predate the local.N namespace.
    // Any newer/unknown archive blocks initialization; never guess a high-water.
    for (const name of fs.readdirSync(root)) {
      const { dir } = child(name);
      const m = JSON.parse(fs.readFileSync(path.join(dir, 'build-info.json')));
      if (m.schema || !/^\d+\.\d+\.\d+-dev\.[1-9]\d*$/.test(m.version) || m.buildId !== name)
        fail('existing output needs counter reconciliation');
    }
  }
  if (
    !Number.isSafeInteger(state.sequence) ||
    state.sequence < 0 ||
    !state.counters ||
    Object.values(state.counters).some((n) => !Number.isSafeInteger(n) || n < 1)
  )
    fail('invalid counter ledger');
  let n;
  if (op === 'sequence') n = ++state.sequence;
  else n = state.counters[value] = (state.counters[value] ?? 0) + 1;
  if (!Number.isSafeInteger(n)) fail('counter exhausted');
  atomic(ledger, state);
  fs.writeFileSync(sentinel, 'Do not remove; restore ledger on loss.\n');
  fs.writeFileSync(recoveryMarker, 'Restore the counter ledger if .build-state is lost.\n');
  console.log(n);
} else if (op === 'start') {
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, value);
  fs.mkdirSync(dir); // exclusive reservation
  atomic(path.join(dir, 'build-info.json'), {
    schema,
    manager,
    buildId: value,
    state: 'in_progress',
    startedAt: new Date().toISOString(),
    targets: [],
  });
} else if (op === 'failed') {
  const { dir, m } = read(value);
  if (m.state !== 'in_progress') fail('cannot fail a completed build');
  atomic(path.join(dir, 'build-info.json'), {
    ...m,
    state: 'failed',
    reason: args.join(' '),
    targets: JSON.parse(process.env.PHONEHAUL_TARGETS_JSON || '[]'),
  });
} else {
  let rows = [];
  for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    try {
      rows.push({ name, ...read(name) });
    } catch (error) {
      console.log(`skip ${name}: ${error.message}`);
    }
  }
  if (['protect', 'unprotect', 'remove'].includes(op)) {
    if (args.includes('--dry-run')) {
      console.log(`would ${op} ${value}; no changes`);
      process.exit(0);
    }
    const row = rows.find((r) => r.name === value);
    if (!row)
      fail('select a recognized managed directory; unknown output requires manual inspection');
    if (op === 'protect') {
      if (!row.protected) fs.closeSync(fs.openSync(path.join(row.dir, '.keep'), 'wx'));
    } else {
      if (!args.includes('--yes')) fail(`${op} requires explicit selection and --yes`);
      if (op === 'unprotect') fs.rmSync(path.join(row.dir, '.keep'), { force: true });
      else {
        const current = read(value);
        if (current.st.ino !== row.st.ino || current.st.dev !== row.st.dev)
          fail('directory substituted');
        fs.rmSync(row.dir, { recursive: true });
        console.log(`removed ${value}`);
      }
    }
  } else if (op === 'list' || op === 'clean') {
    const keep = Number(value ?? 10);
    if (!/^(0|[1-9]\d*)$/.test(String(value ?? 10)) || !Number.isSafeInteger(keep))
      fail('keep must be a nonnegative integer');
    const duplicates = new Set(
      rows
        .filter(
          (a) =>
            a.m.state === 'succeeded' &&
            rows.some((b) => a !== b && b.m.completionSeq === a.m.completionSeq),
        )
        .map((a) => a.m.completionSeq),
    );
    rows.sort((a, b) => (b.m.completionSeq ?? 0) - (a.m.completionSeq ?? 0));
    let retained = 0;
    for (const row of rows) {
      if (row.m.state !== 'succeeded' || row.protected || duplicates.has(row.m.completionSeq)) {
        console.log(
          `retain ${row.name}: ${row.m.state}, protected=${row.protected}, ambiguous=${duplicates.has(row.m.completionSeq)}`,
        );
        continue;
      }
      const remove = ++retained > keep;
      console.log(`${remove ? 'candidate' : 'retain'} ${row.name}: seq=${row.m.completionSeq}`);
      if (op === 'clean' && remove && !args.includes('--dry-run')) {
        const current = read(row.name);
        if (
          current.protected ||
          current.m.state !== 'succeeded' ||
          current.m.completionSeq !== row.m.completionSeq ||
          current.st.ino !== row.st.ino ||
          current.st.dev !== row.st.dev
        ) {
          console.log(`skip changed ${row.name}`);
          continue;
        }
        fs.rmSync(row.dir, { recursive: true });
        console.log(`deleted ${row.name}`);
      }
    }
  } else fail('unknown storage operation');
}
