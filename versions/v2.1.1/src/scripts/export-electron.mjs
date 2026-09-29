// export-electron.mjs — 把 build\ 里构建好的 exe 复制到 installer\（交付目录）
// 收集范围：build\ 顶层（portable/setup）+ build\debug\（Debug 版）
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const buildDir = join(root, 'build');
const installerDir = join(root, 'installer');
mkdirSync(installerDir, { recursive: true });

// 收集 { 文件名, 完整路径 }
let picked = [];
try {
  picked = picked.concat(
    readdirSync(buildDir)
      .filter((f) => /\.exe$/.test(f))
      .map((f) => ({ f, src: join(buildDir, f) }))
  );
} catch { /* build 目录不存在 */ }
try {
  picked = picked.concat(
    readdirSync(join(buildDir, 'debug'))
      .filter((f) => /\.exe$/.test(f))
      .map((f) => ({ f, src: join(buildDir, 'debug', f) }))
  );
} catch { /* 无 Debug 构建 */ }

if (!picked.length) {
  console.error('build\ 下没有找到 exe，请先运行: npm run dist:debug / dist:portable / dist:installer');
  process.exit(1);
}

for (const { f, src } of picked) {
  copyFileSync(src, join(installerDir, f));
}

console.log(`[${pkg.version}] 已复制 ${picked.length} 个 exe 到 installer\:`);
for (const { f } of picked) console.log('  ' + f);
