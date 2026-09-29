// scripts/build-helper.mjs — 编译 gv-helper（C#，.NET Framework 4.x）到 resources\gv-helper.exe
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const cscCandidates = [
  'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
  'C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe',
];
const csc = cscCandidates.find((p) => existsSync(p));
if (!csc) {
  console.error('✗ 未找到 csc.exe（.NET Framework 4.x），无法编译 gv-helper');
  process.exit(1);
}

const refDirs = [
  'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/WPF',
  'C:/Windows/Microsoft.NET/Framework/v4.0.30319/WPF',
  'C:/Program Files (x86)/Reference Assemblies/Microsoft/Framework/v3.0',
  'C:/Program Files/Reference Assemblies/Microsoft/Framework/v3.0',
];
let refDir = refDirs.find((d) => existsSync(join(d, 'UIAutomationClient.dll')) && existsSync(join(d, 'WindowsBase.dll')));
if (!refDir) {
  console.error('✗ 未找到 UIAutomationClient.dll/WindowsBase.dll 引用目录');
  process.exit(1);
}


// NAudio.Core.dll：优先 resources/ 下已归档副本，其次 %TEMP% 下载缓存

const naudioCoreCandidates = [
  join(root, 'resources', 'NAudio.Core.dll'),
  join(process.env.TEMP || '', 'naudio', 'core211', 'lib', 'netstandard2.0', 'NAudio.Core.dll'),
  join(process.env.TEMP || '', 'naudio', 'core', 'lib', 'netstandard2.0', 'NAudio.Core.dll'),
];
const naudioWasapiCandidates = [
  join(root, 'resources', 'NAudio.Wasapi.dll'),
  join(process.env.TEMP || '', 'naudio', 'wasapi', 'lib', 'netstandard2.0', 'NAudio.Wasapi.dll'),
];
const naudioCore = naudioCoreCandidates.find((f) => existsSync(f));
const naudioWasapi = naudioWasapiCandidates.find((f) => existsSync(f));
if (!naudioCore || !naudioWasapi) {
  console.error('✗ 未找到 NAudio.Core.dll / NAudio.Wasapi.dll（需要先下载到 resources/ 或 %TEMP%/naudio）');
  process.exit(1);
}
const naudioCoreDest = join(root, 'resources', 'NAudio.Core.dll');
const naudioWasapiDest = join(root, 'resources', 'NAudio.Wasapi.dll');
mkdirSync(join(root, 'resources'), { recursive: true });
if (naudioCore !== naudioCoreDest) copyFileSync(naudioCore, naudioCoreDest);
if (naudioWasapi !== naudioWasapiDest) copyFileSync(naudioWasapi, naudioWasapiDest);

const src = join(root, 'desktop', 'helpers', 'gv-helper.cs');
const outDir = join(root, 'resources');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, 'gv-helper.exe');
const args = [
  '/nologo', '/target:exe', '/platform:anycpu', '/optimize+',
  `/r:${join(refDir, 'UIAutomationClient.dll')}`,
  `/r:${join(refDir, 'UIAutomationTypes.dll')}`,
  `/r:${join(refDir, 'WindowsBase.dll')}`,
  `/r:${join(refDir, 'PresentationCore.dll')}`,
  '/r:C:/Windows/Microsoft.NET/Framework64/v4.0.30319/netstandard.dll',
  `/r:${naudioCoreDest}`,
  `/r:${naudioWasapiDest}`,
  `/out:${out}`, src,
];
console.log(`▶ 编译 gv-helper → ${out}`);
const r = spawnSync(csc, args, { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log('✅ gv-helper.exe 编译完成');
