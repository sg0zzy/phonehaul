import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const assets = path.join(root, 'desktop/msix/Assets');

function xml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&apos;');
}

export function manifest({ name, publisher, publisherDisplayName, version, arch }) {
  if (!/^[A-Za-z0-9.-]{3,50}$/.test(name))
    throw new Error('MSIX_IDENTITY_NAME must be a 3–50 character Partner Center package name.');
  if (!publisher || !publisher.startsWith('CN='))
    throw new Error(
      'MSIX_PUBLISHER must be the full Publisher distinguished name from Partner Center.',
    );
  const parts = version.split('.').map(Number);
  if (
    !/^\d+\.\d+\.\d+\.0$/.test(version) ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 65535) ||
    parts[0] === 0
  ) {
    throw new Error(
      'MSIX_VERSION must be four numbers such as 1.0.0.0, with a nonzero first and zero last number.',
    );
  }
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported MSIX architecture: ${arch}`);
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
         xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
         IgnorableNamespaces="uap10 rescap">
  <Identity Name="${xml(name)}" Publisher="${xml(publisher)}" Version="${version}" ProcessorArchitecture="${arch}" />
  <Properties>
    <DisplayName>PhoneHaul</DisplayName>
    <PublisherDisplayName>${xml(publisherDisplayName)}</PublisherDisplayName>
    <Description>Local network phone file transfer</Description>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Resources><Resource Language="en-us" /></Resources>
  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" /></Dependencies>
  <Applications>
    <Application Id="App" Executable="phonehaul-desktop.exe" uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL">
      <uap:VisualElements DisplayName="PhoneHaul" Description="Local network phone file transfer"
                          Square150x150Logo="Assets\\Square150x150Logo.png"
                          Square44x44Logo="Assets\\Square44x44Logo.png" BackgroundColor="transparent" />
    </Application>
  </Applications>
  <Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities>
</Package>
`;
}

async function findMakeAppx() {
  const sdkBin = path.join(
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Windows Kits',
    '10',
    'bin',
  );
  const versions = (await readdir(sdkBin, { withFileTypes: true }))
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(sdkBin, version, 'x64', 'makeappx.exe');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`MakeAppx.exe not found under ${sdkBin}; install the Windows SDK.`);
}

async function main() {
  if (process.platform !== 'win32') throw new Error('MSIX packages must be built on Windows.');
  const arch = { x64: 'x64', arm64: 'arm64' }[process.arch];
  const name = process.env.MSIX_IDENTITY_NAME;
  const publisher = process.env.MSIX_PUBLISHER;
  if (!name || !publisher)
    throw new Error(
      'Set MSIX_IDENTITY_NAME and MSIX_PUBLISHER to the exact values from Partner Center.',
    );
  const version = process.env.MSIX_VERSION || '1.0.0.0';
  const publisherDisplayName = process.env.MSIX_PUBLISHER_DISPLAY_NAME || 'PhoneHaul';
  const content = manifest({ name, publisher, publisherDisplayName, version, arch });
  const outputDir = path.join(root, 'dist/msix');
  const stage = path.join(outputDir, 'stage');
  const exe = path.join(root, 'desktop/src-tauri/target/release/phonehaul-desktop.exe');
  const sidecar = path.join(root, 'desktop/src-tauri/resources/phonehaul-server.exe');
  if (!existsSync(exe) || !existsSync(sidecar))
    throw new Error('Build the Windows Tauri app before packaging MSIX.');

  await rm(stage, { recursive: true, force: true });
  await mkdir(path.join(stage, 'Assets'), { recursive: true });
  await mkdir(path.join(stage, 'resources'), { recursive: true });
  await copyFile(exe, path.join(stage, 'phonehaul-desktop.exe'));
  await copyFile(sidecar, path.join(stage, 'resources/phonehaul-server.exe'));
  for (const logo of ['StoreLogo.png', 'Square150x150Logo.png', 'Square44x44Logo.png']) {
    await copyFile(path.join(assets, logo), path.join(stage, 'Assets', logo));
  }
  await writeFile(path.join(stage, 'AppxManifest.xml'), content);
  const output = path.join(outputDir, `PhoneHaul_${version}_${arch}.msix`);
  execFileSync(await findMakeAppx(), ['pack', '/d', stage, '/p', output, '/o'], {
    stdio: 'inherit',
  });
  console.log(`Unsigned Microsoft Store MSIX: ${output}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
