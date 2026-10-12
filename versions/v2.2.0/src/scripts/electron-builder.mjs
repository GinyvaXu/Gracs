// electron-builder.mjs — 统一 electron-builder 调用（生成「按实际存在的资源过滤」的临时配置）
// 背景：resources/ 下的二进制不入 git 仓库；缺失的可选资源（如 Radmin 安装包）不应导致构建失败。
// 用法：node scripts/electron-builder.mjs --win portable [...更多 electron-builder 参数]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const config = structuredClone(pkg.build || {});

// 国内网络友好：默认走 npmmirror 镜像下载 Electron / 打包工具（可用环境变量覆盖）
process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||= 'https://npmmirror.com/mirrors/electron-builder-binaries/';

// ── 过滤 extraResources：只包含实际存在的文件，缺失的（可选资源）跳过并提示 ──
const skipped = [];
if (Array.isArray(config.extraResources)) {
  config.extraResources = config.extraResources.filter((entry) => {
    const from = typeof entry === 'string' ? entry : entry.from;
    const ok = from && existsSync(join(root, from));
    if (!ok) skipped.push(from);
    return ok;
  });
}

// ── 额外覆盖（由调用方通过环境变量注入，例如 Debug 版输出目录/产物名）──
const extraConfig = process.env.GV_BUILDER_OVERRIDES ? JSON.parse(process.env.GV_BUILDER_OVERRIDES) : null;
if (extraConfig) {
  for (const [key, value] of Object.entries(extraConfig)) {
    const parts = key.split('.');
    let node = config;
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] ??= {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
  }
}

const cfgDir = join(root, 'temp');
mkdirSync(cfgDir, { recursive: true });
const cfgPath = join(cfgDir, '_electron-builder.generated.json');
writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf8');

if (skipped.length) {
  console.warn('⚠️  以下可选资源不存在，已从打包清单跳过：');
  for (const f of skipped) console.warn('   - ' + f);
}

const args = [join('node_modules', 'electron-builder', 'cli.js'), ...process.argv.slice(2), '--config', cfgPath];
const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
