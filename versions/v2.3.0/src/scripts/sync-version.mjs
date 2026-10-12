// sync-version.mjs — 版本号单一来源：读取 VERSION，同步到 package.json（构建前自动执行）
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('VERSION 格式非法（应为 x.y.z）:', JSON.stringify(version));
  process.exit(1);
}

const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
if (pkg.version !== version) {
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`已同步 package.json version: ${pkg.version} -> ${version}`);
} else {
  console.log(`版本一致: v${version}`);
}
