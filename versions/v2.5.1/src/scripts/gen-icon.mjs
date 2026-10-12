// gen-icon.mjs — 从设计素材同步应用图标（零依赖，不再程序化绘制）
// 素材来源：assets/design-*/ 中最新的一个包含 gracs.ico 的目录（可用 ICON_SOURCE 环境变量覆盖）
// 产物：
//   assets/icon.ico / icon.png(256) / tray.png(32)
//   client/assets/icon-192.png / icon-512.png / icon-maskable-512.png
//   client/favicon-32.png / favicon-64.png
// 说明：图标由图标设计工作流（Project6 图标素材库）产出，本脚本只做同步，保证 `npm run icon` 不会覆盖新设计。
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const assetsDir = join(root, 'assets');
const clientDir = join(root, 'client');
const clientAssets = join(clientDir, 'assets');

// ── 找素材源：ICON_SOURCE > assets/design-*/ 中最新的含 gracs.ico 目录 ──
function findSource() {
  if (process.env.ICON_SOURCE) return process.env.ICON_SOURCE;
  const candidates = readdirSync(assetsDir)
    .filter((n) => n.startsWith('design-'))
    .map((n) => join(assetsDir, n))
    .filter((d) => { try { return statSync(d).isDirectory() && existsSync(join(d, 'gracs.ico')); } catch { return false; } })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] || null;
}

const src = findSource();
if (!src) {
  console.error('✗ 找不到图标素材源（assets/design-*/ 下需包含 gracs.ico）；可用 ICON_SOURCE=<目录> 指定');
  process.exit(1);
}

const MAP = [
  ['gracs.ico', join(assetsDir, 'icon.ico')],
  ['gracs-256.png', join(assetsDir, 'icon.png')],
  ['tray-32.png', join(assetsDir, 'tray.png')],
  ['icon-192.png', join(clientAssets, 'icon-192.png')],
  ['icon-512.png', join(clientAssets, 'icon-512.png')],
  ['icon-maskable-512.png', join(clientAssets, 'icon-maskable-512.png')],
  ['favicon-32.png', join(clientDir, 'favicon-32.png')],
  ['favicon-64.png', join(clientDir, 'favicon-64.png')],
];

mkdirSync(clientAssets, { recursive: true });
let copied = 0;
for (const [from, to] of MAP) {
  const srcFile = join(src, from);
  if (!existsSync(srcFile)) {
    console.error(`✗ 素材缺失：${srcFile}`);
    process.exit(1);
  }
  copyFileSync(srcFile, to);
  copied++;
}

console.log(`已从 ${src.replace(root + '\\', '')} 同步 ${copied} 个图标：`);
console.log('  assets/icon.ico（多尺寸 16→256） · assets/icon.png(256) · assets/tray.png(32)');
console.log('  client/assets/icon-192/512/maskable-512.png（PWA）');
console.log('  client/favicon-32.png / favicon-64.png');
