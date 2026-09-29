import { spawn } from 'node:child_process';

export function browserCommand(url, platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  return { command: 'xdg-open', args: [url] };
}

export function openDefaultBrowser(url, { platform = process.platform, spawnProcess = spawn, onError = () => {} } = {}) {
  const { command, args } = browserCommand(url, platform);
  try {
    const child = spawnProcess(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', onError);
    child.unref();
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}
