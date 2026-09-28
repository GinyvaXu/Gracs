// build-debug.mjs — 构建 Debug 版便携 exe（控制台 + 日志 + DevTools）
// 用法: npm run dist:debug  （构建前自动从 VERSION 同步版本号）
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('VERSION 格式非法:', version);
  process.exit(1);
}

// 本地构建依赖（不入 git 仓库）：缺失时给出明确指引，避免 electron-builder 报错难懂
const required = ['resources/gv-helper.exe', 'resources/NAudio.Core.dll', 'resources/NAudio.Wasapi.dll'];
const missing = required.filter((f) => !existsSync(join(root, f)));
if (missing.length) {
  console.error('❌ 缺少本地构建依赖（resources/ 不入库，需从上一版本归档或本机拷贝）：');
  for (const f of missing) console.error('   - ' + f);
  process.exit(1);
}
if (!existsSync(join(root, 'resources/Radmin_VPN_2.0.4899.9.exe'))) {
  console.warn('⚠️  未找到 resources/Radmin_VPN_2.0.4899.9.exe（高级备选联机用，可选）');
}

// 直调 electron-builder CLI（项目路径含 & ，不能用 .bin 的 .cmd 垫片）
const args = [
  join('node_modules', 'electron-builder', 'cli.js'),
  '--win',
  'portable',
  '-c.directories.output=build/debug',
  `-c.portable.artifactName=GinyScreen-Debug-v${version}.exe`,
  '-c.win.icon=assets/icon.ico',
];
console.log(`▶ 构建 Debug 版 v${version}（控制台 + 日志 + DevTools）...`);
const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
if (r.status !== 0) {
  console.error('Debug 版构建失败');
  process.exit(r.status ?? 1);
}
console.log(`✅ Debug 版已生成: build/debug/GinyScreen-Debug-v${version}.exe`);