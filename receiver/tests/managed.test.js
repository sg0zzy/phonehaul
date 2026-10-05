import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('desktop managed mode reports its address and shuts down on SIGTERM', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-managed-'));
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../src/server/main.js', import.meta.url))],
    {
      env: {
        ...process.env,
        PHONEHAUL_DESKTOP_MANAGED: '1',
        PHONEHAUL_NO_BROWSER: '1',
        PHONEHAUL_TRANSFER_PORT: '0',
        PHONEHAUL_SETTINGS_FILE: path.join(directory, 'settings.json'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let lines = '';
  child.stdout.setEncoding('utf8');
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Managed server did not start: ${output}`)),
        10_000,
      );
      child.stdout.on('data', (chunk) => {
        output += chunk;
        lines += chunk;
        const complete = lines.split('\n');
        lines = complete.pop();
        for (const candidate of complete)
          if (candidate.startsWith('PHONEHAUL_READY ')) {
            clearTimeout(timer);
            try {
              resolve(JSON.parse(candidate.slice('PHONEHAUL_READY '.length)));
            } catch (error) {
              reject(error);
            }
          }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Managed server exited early (${code}): ${output}`));
      });
    });
    assert.equal(new URL(ready.uiUrl).hostname, '127.0.0.1');
    assert.ok(ready.port > 0);
    // stdin stays open, so the only way the child can exit is the signal handler.
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    const [code, signal] = await exit;
    assert.equal(code, 0);
    assert.equal(signal, null);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});

test('desktop managed mode exits when its wrapper closes stdin', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-managed-stdin-'));
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../src/server/main.js', import.meta.url))],
    {
      env: {
        ...process.env,
        PHONEHAUL_DESKTOP_MANAGED: '1',
        PHONEHAUL_NO_BROWSER: '1',
        PHONEHAUL_TRANSFER_PORT: '0',
        PHONEHAUL_SETTINGS_FILE: path.join(directory, 'settings.json'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  try {
    let output = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Managed server did not start: ${output}`)),
        10_000,
      );
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('PHONEHAUL_READY ')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Managed server exited early (${code}): ${output}`));
      });
    });
    child.stdin.end();
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, 0);
    assert.equal(signal, null);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});
