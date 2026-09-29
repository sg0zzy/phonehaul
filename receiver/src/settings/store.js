import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const windowsDownloadsId = '{374DE290-123F-4565-9164-39C4925E467B}';

export function parseXdgDownloadsDirectory(contents, home) {
  const match = contents.match(/^\s*XDG_DOWNLOAD_DIR\s*=\s*"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/m);
  if (!match) return null;
  let value = match[1].replace(/\\(["\\$`])/g, '$1');
  value = value.replace(/\$\{HOME\}|\$HOME/g, home);
  if (/[$`\0]/.test(value) || !path.posix.isAbsolute(value)) return null;
  return path.posix.resolve(value);
}

async function readWindowsDownloads({ env, readRegistry }) {
  const raw = await readRegistry();
  const id = windowsDownloadsId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = raw.match(new RegExp(`^\\s*${id}\\s+REG_(?:EXPAND_SZ|SZ)\\s+(.+?)\\s*$`, 'mi'));
  if (!match) return null;
  const value = match[1].replace(/%([^%]+)%/g, (placeholder, key) => env[key] ?? placeholder);
  if (/%[^%]+%/.test(value) || !path.win32.isAbsolute(value)) return null;
  return path.win32.normalize(value);
}

export async function defaultDownloadsDirectory({ platform = process.platform, home = os.homedir(), env = process.env, readText = file => readFile(file, 'utf8'), readRegistry } = {}) {
  if (platform === 'win32') {
    try {
      const registryReader = readRegistry ?? (() => execFileAsync('reg.exe', [
        'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
        '/v', windowsDownloadsId
      ], { encoding: 'utf8', timeout: 2000, windowsHide: true }).then(result => result.stdout));
      const folder = await readWindowsDownloads({ env, readRegistry: registryReader });
      if (folder) return folder;
    } catch { /* use the standard user Downloads path */ }
    return path.win32.join(home, 'Downloads');
  }
  if (platform === 'darwin') return path.join(home, 'Downloads');

  if (env.XDG_DOWNLOAD_DIR && path.posix.isAbsolute(env.XDG_DOWNLOAD_DIR)) return path.posix.normalize(env.XDG_DOWNLOAD_DIR);
  const configHome = env.XDG_CONFIG_HOME && path.posix.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : path.posix.join(home, '.config');
  try {
    const folder = parseXdgDownloadsDirectory(await readText(path.posix.join(configHome, 'user-dirs.dirs')), home);
    if (folder) return folder;
  } catch { /* use the standard user Downloads path */ }
  return path.posix.join(home, 'Downloads');
}

export async function defaultDestination(options) {
  const downloads = await defaultDownloadsDirectory(options);
  const pathApi = (options?.platform ?? process.platform) === 'win32' ? path.win32 : path;
  return pathApi.join(downloads, 'PhoneHaul');
}
export function settingsDirectory({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    const appData = env.APPDATA && pathApi.isAbsolute(env.APPDATA) ? env.APPDATA : pathApi.join(home, 'AppData', 'Roaming');
    return pathApi.join(appData, 'PhoneHaul');
  }
  if (platform === 'darwin') return pathApi.join(home, 'Library', 'Application Support', 'PhoneHaul');
  const xdg = env.XDG_CONFIG_HOME && pathApi.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : pathApi.join(home, '.config');
  return pathApi.join(xdg, 'phonehaul');
}
export function settingsFilePath(options) {
  const platform = options?.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return pathApi.join(settingsDirectory(options), 'settings.json');
}
export const defaultSettingsPath = settingsFilePath();
const conflicts = new Set(['rename', 'skip', 'replace']);

export function validateSettings(settings) {
  if (!settings || typeof settings.destination !== 'string' || !path.isAbsolute(settings.destination) || !conflicts.has(settings.conflict)) throw new Error('Invalid settings');
  return { destination: path.resolve(settings.destination), conflict: settings.conflict };
}

export async function loadSettings(file = defaultSettingsPath) {
  try { return validateSettings(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Materialize the default on first launch so the destination is both ready
  // to receive files and persisted like any destination chosen in the UI.
  return saveSettings({ destination: await defaultDestination(), conflict: 'rename' }, file);
}

export async function saveSettings(settings, file = defaultSettingsPath) {
  const checked = validateSettings(settings);
  await mkdir(checked.destination, { recursive: true });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(checked, null, 2) + '\n', { mode: 0o600 });
  return checked;
}
