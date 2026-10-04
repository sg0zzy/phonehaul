import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import {
  defaultDestination,
  defaultDownloadsDirectory,
  loadSettings,
  parseXdgDownloadsDirectory,
  settingsDirectory,
  settingsFilePath,
} from '../src/settings/store.js';

test('settings use XDG_CONFIG_HOME on Linux and home fallback', () => {
  assert.equal(
    settingsDirectory({
      platform: 'linux',
      env: { XDG_CONFIG_HOME: '/tmp/user-config' },
      home: '/home/test',
    }),
    '/tmp/user-config/phonehaul',
  );
  assert.equal(
    settingsDirectory({ platform: 'linux', env: {}, home: '/home/test' }),
    '/home/test/.config/phonehaul',
  );
  assert.equal(
    settingsDirectory({
      platform: 'linux',
      env: { XDG_CONFIG_HOME: 'relative' },
      home: '/home/test',
    }),
    '/home/test/.config/phonehaul',
  );
});

test('settings use platform user config locations', () => {
  assert.equal(
    settingsDirectory({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
      home: 'C:\\Users\\test',
    }),
    path.win32.join('C:\\Users\\test\\AppData\\Roaming', 'PhoneHaul'),
  );
  assert.equal(
    settingsDirectory({ platform: 'win32', env: {}, home: 'C:\\Users\\test' }),
    path.win32.join('C:\\Users\\test', 'AppData', 'Roaming', 'PhoneHaul'),
  );
  assert.equal(
    settingsDirectory({ platform: 'darwin', env: {}, home: '/Users/test' }),
    path.posix.join('/Users/test', 'Library', 'Application Support', 'PhoneHaul'),
  );
  assert.equal(
    settingsFilePath({ platform: 'darwin', env: {}, home: '/Users/test' }),
    path.posix.join('/Users/test', 'Library', 'Application Support', 'PhoneHaul', 'settings.json'),
  );
});

test('Linux default destination follows XDG configured Downloads directory', async () => {
  assert.equal(
    parseXdgDownloadsDirectory('XDG_DOWNLOAD_DIR="$HOME/Scaricati"', '/home/test'),
    '/home/test/Scaricati',
  );
  assert.equal(
    parseXdgDownloadsDirectory('XDG_DOWNLOAD_DIR="/mnt/Big Disk/Download\\"s"', '/home/test'),
    '/mnt/Big Disk/Download"s',
  );
  assert.equal(
    parseXdgDownloadsDirectory('XDG_DOWNLOAD_DIR="$(touch /tmp/nope)"', '/home/test'),
    null,
  );

  const home = '/home/test';
  const config = '/tmp/phonehaul-user-config';
  const folder = await defaultDownloadsDirectory({
    platform: 'linux',
    home,
    env: { XDG_CONFIG_HOME: config },
    readText: async (file) => {
      assert.equal(file, path.posix.join(config, 'user-dirs.dirs'));
      return 'XDG_DOWNLOAD_DIR="$HOME/Scaricati"';
    },
  });
  assert.equal(folder, '/home/test/Scaricati');
  assert.equal(
    await defaultDestination({
      platform: 'linux',
      home,
      env: { XDG_DOWNLOAD_DIR: '/mnt/Downloads' },
    }),
    '/mnt/Downloads/PhoneHaul',
  );
  assert.equal(
    await defaultDownloadsDirectory({
      platform: 'linux',
      home,
      env: {},
      readText: async () => {
        throw new Error('missing config');
      },
    }),
    '/home/test/Downloads',
  );
});

test('Windows default Downloads honors the user shell folder registry entry', async () => {
  const folder = await defaultDownloadsDirectory({
    platform: 'win32',
    home: 'C:\\Users\\test',
    env: { USERPROFILE: 'C:\\Users\\test' },
    readRegistry: async () =>
      '{374DE290-123F-4565-9164-39C4925E467B}    REG_EXPAND_SZ    %USERPROFILE%\\OneDrive\\Downloads',
  });
  assert.equal(folder, path.win32.join('C:\\Users\\test', 'OneDrive', 'Downloads'));
  assert.equal(
    await defaultDestination({
      platform: 'win32',
      home: 'C:\\Users\\test',
      env: {},
      readRegistry: async () => {
        throw new Error('no registry');
      },
    }),
    'C:\\Users\\test\\Downloads\\PhoneHaul',
  );
});

test('a saved destination continues to override the platform default', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-saved-settings-'));
  const file = path.join(directory, 'settings.json');
  try {
    await writeFile(
      file,
      JSON.stringify({ destination: path.join(directory, 'custom'), conflict: 'rename' }),
    );
    assert.deepEqual(await loadSettings(file), {
      destination: path.join(directory, 'custom'),
      conflict: 'rename',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('first launch creates and persists the default PhoneHaul destination', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-first-run-'));
  const file = path.join(directory, 'config', 'settings.json');
  try {
    const settings = await loadSettings(file);
    assert.equal(settings.conflict, 'rename');
    assert.equal(path.basename(settings.destination), 'PhoneHaul');
    assert.equal(path.basename(path.dirname(settings.destination)), 'Downloads');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), settings);
    assert.equal((await stat(settings.destination)).isDirectory(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
