// export-debug.mjs — 导出 Debug 版自包含包（无外部依赖）
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const version = 'v' + readFileSync(join(root, 'VERSION'), 'utf8').trim();
const outDir = join(root, 'release', `Debug-${version}`);
const serverDir = join(outDir, 'GinyScreen-Server');

// 安全校验：输出目录必须在项目根内
if (!outDir.startsWith(root)) throw new Error('输出目录不在项目根内');

// 清空旧输出
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(serverDir, { recursive: true });

// 复制代码（排除 .git / release / temp / node_modules）
const EXCLUDE = new Set(['.git', 'release', 'temp', 'node_modules', 'build', 'installer', 'versions', 'dist', 'logs']);
function copyFilter(src) {
  const rel = src.slice(root.length + 1);
  return !EXCLUDE.has(rel.split(/[\\/]/)[0]);
}
for (const name of readdirSync(root)) {
  if (EXCLUDE.has(name)) continue;
  const s = join(root, name);
  const d = join(serverDir, name);
  cpSync(s, d, { recursive: true, filter: copyFilter });
}
// 复制依赖
const nmSrc = join(root, 'node_modules');
if (!existsSync(nmSrc)) throw new Error('缺少 node_modules，请先 npm install');
cpSync(nmSrc, join(serverDir, 'node_modules'), { recursive: true });

// 启动脚本（UTF-8 无 BOM）
const bat = `@echo off\r\nchcp 65001 >nul\r\ntitle GinyScreen Debug Server\r\ncd /d "%~dp0GinyScreen-Server"\r\nif not exist "%~dp0logs" mkdir "%~dp0logs"\r\nset NODE_ENV=debug\r\nset LOG_DIR=%~dp0logs\r\necho ==================================================\r\necho   GinyScreen Debug\r\necho   工作日志: %~dp0logs\\work-日期.log\r\necho   报错日志: %~dp0logs\\error-日期.log\r\necho   启动后请打开浏览器: http://localhost:3000\r\necho   关闭本窗口即停止服务器\r\necho ==================================================\r\nstart "" http://localhost:3000\r\nnode server/index.js\r\necho.\r\necho 服务器已退出。按任意键关闭窗口...\r\npause >nul\r\n`;
writeFileSync(join(outDir, 'Start-GinyScreen-Debug.bat'), bat, 'utf8');

const logBat = `@echo off\r\nchcp 65001 >nul\r\nif not exist "%~dp0logs" (\r\n  echo 还没有日志文件，请先运行"Start-GinyScreen-Debug.bat"。\r\n  pause\r\n  exit /b\r\n)\r\nexplorer "%~dp0logs"\r\n`;
writeFileSync(join(outDir, 'Open-Logs.bat'), logBat, 'utf8');

const readme = `【GinyScreen Debug ${version}】

一、怎么启动
  双击"Start-GinyScreen-Debug.bat"，会自动：
  1. 启动服务器（需已安装 Node.js 18+）
  2. 打开浏览器 http://localhost:3000
  3. 开始记录日志

二、日志在哪里
  本目录 logs\\ 下：
  - work-日期.log   工作日志：服务器启动、连接、建房/加房、进出频道、信令明细等
  - error-日期.log  报错日志：服务器异常 + 浏览器端 JS 错误（自动上报）
  可双击"Open-Logs.bat"直接打开日志文件夹。

三、试用步骤
  1. 浏览器打开 http://localhost:3000
  2. 输入昵称 → 创建房间 → 复制房间号给朋友（或开无痕窗口双开）
  3. 点击左侧语音频道 → 允许麦克风 → 开始说话
  4. 底部可共享屏幕、切换 VAD/PTT/自由麦

四、常见问题
  - 提示端口被占用：说明已有一个实例在跑（如开发版），关掉一个再启动。
  - 局域网其他设备要加入：请改用 HTTPS 启动（见 README 的"局域网使用"）。
  - 浏览器不开麦克风：地址栏左侧点锁图标，允许麦克风权限后刷新。

五、反馈
  把 logs 文件夹（或其中的 work/error 日志）发回来即可定位问题。
`;
writeFileSync(join(outDir, 'README-Debug.txt'), readme, 'utf8');

console.log('导出完成:');
console.log('  目录: ' + outDir);
