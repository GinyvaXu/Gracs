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
// gv-helper.exe 可用 `node scripts/build-helper.mjs` 从源码本地编译；NAudio 两个 DLL 需从 NuGet 获取。
const required = ['resources/gv-helper.exe', 'resources/NAudio.Core.dll', 'resources/NAudio.Wasapi.dll'];
const missing = required.filter((f) => !existsSync(join(root, f)));
if (missing.length) {
  console.error('❌ 缺少本地构建依赖（resources/ 不入库）：');
  for (const f of missing) console.error('   - ' + f);
  console.error('\n提示：gv-helper.exe 可运行 `node scripts/build-helper.mjs` 从源码编译；');
  console.error('      NAudio DLL 可从 NuGet 下载 NAudio.Core / NAudio.Wasapi（netstandard2.0）后放入 resources/。');
  process.exit(1);
}

console.log(`▶ 构建 Debug 版 v${version}（控制台 + 日志 + DevTools）...`);
const overrides = {
  'directories.output': 'build/debug',
  'portable.artifactName': `Gracs-Debug-v${version}.exe`,
  'win.icon': 'assets/icon.ico',
};
const r = spawnSync(process.execPath, [join('scripts', 'electron-builder.mjs'), '--win', 'portable'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, GV_BUILDER_OVERRIDES: JSON.stringify(overrides) },
});
if (r.status !== 0) {
  console.error('Debug 版构建失败');
  process.exit(r.status ?? 1);
}
console.log(`✅ Debug 版已生成: build/debug/Gracs-Debug-v${version}.exe`);
