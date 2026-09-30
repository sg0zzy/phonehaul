import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { browserCommand, openDefaultBrowser } from '../src/server/browser.js';
import { page } from '../src/web/page.js';
import vm from 'node:vm';

test('browser helper selects platform commands without shell interpolation', () => {
  const url = 'http://127.0.0.1:57321/?a=1&b=two';
  assert.deepEqual(browserCommand(url, 'linux'), { command: 'xdg-open', args: [url] });
  assert.deepEqual(browserCommand(url, 'darwin'), { command: 'open', args: [url] });
  assert.deepEqual(browserCommand(url, 'win32'), { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] });
});

test('browser opening is best-effort and reports asynchronous spawn errors', () => {
  const child = new EventEmitter();
  child.unref = () => {};
  const calls = [];
  const failures = [];
  assert.equal(openDefaultBrowser('http://127.0.0.1:1/', {
    platform: 'linux',
    spawnProcess: (...args) => { calls.push(args); return child; },
    onError: error => failures.push(error)
  }), true);
  assert.equal(calls[0][0], 'xdg-open');
  assert.deepEqual(calls[0][1], ['http://127.0.0.1:1/']);
  child.emit('error', new Error('missing browser launcher'));
  assert.equal(failures.length, 1);
});

test('browser opening reports synchronous failures and does not throw', () => {
  const failures = [];
  assert.equal(openDefaultBrowser('http://127.0.0.1:1/', {
    platform: 'linux',
    spawnProcess: () => { throw new Error('spawn failed'); },
    onError: error => failures.push(error)
  }), false);
  assert.equal(failures.length, 1);
});

test('send card has file and folder pickers and its browser script parses', () => {
  const html = page();
  assert.match(html, /<h2>Send to phone<\/h2>/);
  assert.match(html, /id="sendFiles" type="file" multiple/);
  assert.match(html, /id="sendFolder" type="file" webkitdirectory multiple/);
  assert.match(html, /directly to Downloads on Android/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
});
