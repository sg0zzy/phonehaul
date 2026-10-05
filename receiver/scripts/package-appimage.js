import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chmod, copyFile, mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'linux') throw new Error('AppImage packaging is available only on Linux.');
const receiverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = path.dirname(receiverDir);
const archNames = { x64: 'x86_64', arm64: 'aarch64' };
const arch = archNames[process.arch];
if (!arch) throw new Error(`AppImage packaging does not support Linux ${process.arch}.`);
const executable = path.join(rootDir, 'dist', `phonehaul-linux-${process.arch}`);
const appImage = path.join(rootDir, 'dist', `PhoneHaul-${arch}.AppImage`);
const stagedAppImage = path.join(rootDir, 'dist', `.PhoneHaul-${arch}-${process.pid}.AppImage`);
const tool = process.env.APPIMAGETOOL || 'appimagetool';
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'phonehaul-appimage-'));
const appDir = path.join(tempDir, 'PhoneHaul.AppDir');

try {
  execFileSync(process.execPath, [path.join(receiverDir, 'scripts', 'package-sea.js')], {
    stdio: 'inherit',
  });
  await mkdir(appDir, { recursive: true });
  await copyFile(executable, path.join(appDir, 'phonehaul'));
  await chmod(path.join(appDir, 'phonehaul'), 0o755);
  const iconDir = path.join(appDir, 'usr', 'share', 'icons', 'hicolor', '128x128', 'apps');
  await mkdir(iconDir, { recursive: true });
  const appRun = `#!/bin/sh\nAPPDIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexport PHONEHAUL_EXIT_ON_UI_CLOSE=1\nexec "$APPDIR/phonehaul" "$@"\n`;
  await writeFile(path.join(appDir, 'AppRun'), appRun, { mode: 0o755 });
  await writeFile(
    path.join(appDir, 'phonehaul.desktop'),
    `[Desktop Entry]\nType=Application\nName=PhoneHaul Receiver\nComment=Move files from Android to this computer over the local network\nExec=AppRun\nIcon=phonehaul\nTerminal=true\nCategories=Utility;\n`,
  );
  const iconPath = path.join(iconDir, 'phonehaul.png');
  await copyFile(path.join(rootDir, 'assets', 'appicon-128.png'), iconPath);
  await copyFile(iconPath, path.join(appDir, 'phonehaul.png'));
  await symlink(path.relative(appDir, iconPath), path.join(appDir, '.DirIcon'));
  const args = [appDir, stagedAppImage];
  if (process.env.APPIMAGE_RUNTIME) args.push('--runtime-file', process.env.APPIMAGE_RUNTIME);
  execFileSync(tool, args, {
    stdio: 'inherit',
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' },
  });
  await rename(stagedAppImage, appImage);
  await chmod(appImage, 0o755);
  console.log(`AppImage created: ${appImage}`);
} finally {
  await rm(stagedAppImage, { force: true });
  await rm(tempDir, { recursive: true, force: true });
}
