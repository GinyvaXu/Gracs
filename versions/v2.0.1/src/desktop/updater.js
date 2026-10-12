// updater.js — 自动更新（参考诺丁汉桌游项目 updater.py 的思路）
// 清单 update.json 存于仓库根目录（随 git 推送）；客户端从多个源并行拉取并对比版本：
//   raw.githubusercontent.com / 国内加速代理(ghfast.top、ghproxy.net、gh.llkk.cc、gh-proxy.com) / jsDelivr / Releases API
// 安装版（NSIS）：下载新版安装包 → 静默安装(/S，保留安装目录) → 重启应用
// 便携版：引导用户去 GitHub Releases 手动下载（便携 exe 无法自替换运行中的文件）
import { app, shell, dialog } from 'electron';
import { createWriteStream, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const REPO = 'GinyvaXu/GinyScreen';
const RAW_MANIFEST = `https://raw.githubusercontent.com/${REPO}/main/update.json`;
const MANIFEST_SOURCES = [
  ['ghfast', 'https://ghfast.top/' + RAW_MANIFEST],
  ['raw', RAW_MANIFEST],
  ['ghproxy-net', 'https://ghproxy.net/' + RAW_MANIFEST],
  ['gh-llkk', 'https://gh.llkk.cc/' + RAW_MANIFEST],
  ['gh-proxy-com', 'https://gh-proxy.com/' + RAW_MANIFEST],
  ['jsdelivr', `https://cdn.jsdelivr.net/gh/${REPO}@main/update.json`],
  ['api', `https://api.github.com/repos/${REPO}/releases/latest`],
];
export const RELEASE_PAGE = `https://github.com/${REPO}/releases`;
const _UA = 'GinyScreen-Updater/1.0';
const CHECK_TIMEOUT = 12_000;
const DOWNLOAD_TIMEOUT = 180_000;
const MIRROR_PREFIXES = [
  'https://ghfast.top/',
  'https://ghproxy.net/',
  'https://gh.llkk.cc/',
  'https://gh-proxy.com/',
];
const markerFile = () => join(app.getPath('userData'), 'update-marker.json');

// ---------- 版本比较 ----------
export function parseVersion(s) {
  const parts = String(s || '').match(/\d+/g) || [];
  const [a = 0, b = 0, c = 0] = parts;
  return [Number(a), Number(b), Number(c)];
}
export function isNewer(latest, current) {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  return l[0] > c[0] || (l[0] === c[0] && (l[1] > c[1] || (l[1] === c[1] && l[2] > c[2])));
}

// ---------- 拉取清单 ----------
async function fetchJson(url, timeout = CHECK_TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': _UA, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function fromReleaseApi(data) {
  const tag = String(data.tag_name || '').trim().replace(/^v/i, '');
  if (!tag) throw new Error('empty tag');
  const asset = (data.assets || []).find((a) => /Setup.*\.exe$/i.test(a.name) || /\.exe$/i.test(a.name));
  return { version: tag, url: asset?.browser_download_url || '', notes: data.body || '' };
}

function pickBest(results) {
  let best = null;
  for (const r of results) {
    if (!r) continue;
    if (!best || isNewer(r.version, best.version)) best = r;
  }
  return best;
}

/**
 * 检查更新。返回：{ ok, current, latest, hasUpdate, url, notes, source, error, detail }
 */
export async function checkForUpdate({ currentVersion, onStatus }) {
  onStatus?.('检查更新中…');
  const tasks = MANIFEST_SOURCES.map(async ([name, url]) => {
    try {
      const data = await fetchJson(url);
      const m = name === 'api' ? fromReleaseApi(data) : data;
      if (!m?.version) throw new Error('no version');
      return { version: String(m.version).trim(), url: m.url || '', notes: m.notes || '', source: name };
    } catch {
      return null; // 单个源失败不致命
    }
  });
  const results = await Promise.all(tasks);
  const best = pickBest(results);
  if (!best) {
    return { ok: false, error: 'network', detail: '无法连接更新服务器（网络或代理受限）' };
  }
  const current = String(currentVersion || '0.0.0');
  const hasUpdate = isNewer(best.version, current);
  onStatus?.(hasUpdate ? `发现新版本 v${best.version}` : `已是最新版本 v${current}`);
  return { ok: true, current, latest: best.version, hasUpdate, url: best.url, notes: best.notes, source: best.source };
}

// ---------- 下载安装包 ----------
// 单源下载（带进度），并校验 PE 头（MZ）与最小体积，防止代理返回 HTML 错误页
async function downloadOne(url, destPath, onProgress, timeout = DOWNLOAD_TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': _UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length') || 0);
    let received = 0;
    const reader = res.body.getReader();
    const ws = createWriteStream(destPath);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      ws.write(value);
      if (total) onProgress?.(Math.round((received / total) * 100));
      else onProgress?.(Math.min(99, Math.round(received / 1_000_000)));
    }
    await new Promise((resolve, reject) => ws.end((e) => (e ? reject(e) : resolve())));
    if (received < 1_000_000) throw new Error('下载文件过小，疑似被拦截');
    const head = readFileSync(destPath).subarray(0, 2).toString('latin1');
    if (head !== 'MZ') throw new Error('下载内容不是可执行文件（可能被代理拦截）');
    onProgress?.(100);
    return destPath;
  } finally {
    clearTimeout(timer);
  }
}

// 多源下载：官方 URL 优先，失败依次换国内代理镜像，每个源最多 2 次
export async function downloadInstaller(url, destPath, onProgress) {
  const sources = [url, ...MIRROR_PREFIXES.map((m) => m + url)];
  let lastErr = null;
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        onProgress?.(`下载中（源 ${i + 1}/${sources.length} · 第 ${attempt} 次）`);
        await downloadOne(src, destPath, onProgress);
        return destPath;
      } catch (err) {
        lastErr = err;
        onProgress?.(`下载失败，切换备用源…（${err?.message || err}）`);
      }
    }
  }
  throw lastErr || new Error('所有下载源均失败');
}


export function isPortable() {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
}

// 启动时校验上次自动更新是否生效：当前版本 >= 标记目标 → 成功并清理标记；
// 否则保留标记（下次检查更新仍会提示新版，可重试安装）
export function verifyUpdateMarker(currentVersion, logger) {
  try {
    const f = markerFile();
    if (!existsSync(f)) return;
    const m = JSON.parse(readFileSync(f, 'utf8'));
    if (!m?.target) { try { rmSync(f, { force: true }); } catch { /* 忽略 */ } return; }
    if (isNewer(String(currentVersion), m.from)) {
      logger?.work?.(`自动更新成功：v${m.from} → v${currentVersion}（标记已清除）`);
    } else if (String(m.target) === String(currentVersion)) {
      logger?.work?.('自动更新已生效（版本匹配，标记已清除）');
    } else {
      logger?.work?.(`上次自动更新（目标 v${m.target}）可能未生效，当前仍为 v${currentVersion}，可再次检查更新`);
    }
    try { rmSync(f, { force: true }); } catch { /* 忽略 */ }
  } catch { /* 校验失败不影响启动 */ }
}


// ---------- 应用更新：等退出 → 静默安装 → 重启 ----------
// 与诺丁汉 updater.py 同思路：写一个临时 .bat，等本进程退出后以静默参数安装，
// 成功后重启应用并自清理。NSIS 安装器支持 /S 静默安装，AppId 固定保证覆盖升级。
function launchUpdateBatch(installerPath, exePath, logPath) {
  const batDir = app.getPath('temp');
  const batPath = join(batDir, `GinyScreen-update-${Date.now()}.bat`);
  const name = exePath.split(/[\\/]/).pop().replace(/\.exe$/i, '');
  const lines = [
    '@echo off',
    'setlocal EnableDelayedExpansion',
    'set "INST=%~1"',
    'set "EXE=%~2"',
    'set "LOG=%~3"',
    'set "NAME=%~4"',
    'echo [%date% %time%] updater start >> "%LOG%"',
    'rem wait for app exit (max 40s)',
    'set /a n=0',
    ':wait',
    'powershell -NoProfile -WindowStyle Hidden -Command "if (Get-Process -Name '%NAME%' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"',
    'if errorlevel 1 goto gone',
    'set /a n+=1',
    'if !n! lss 20 ( powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2" & goto wait )',
    'echo [%date% %time%] force kill >> "%LOG%"',
    'powershell -NoProfile -WindowStyle Hidden -Command "Stop-Process -Name '%NAME%' -Force -ErrorAction SilentlyContinue"',
    ':gone',
    'rem silent install (NSIS /S), retry while locked',
    'set /a n=0',
    ':install',
    '"%INST%" /S >> "%LOG%" 2>&1',
    'set ec=!errorlevel!',
    'echo [%date% %time%] installer exit=!ec! >> "%LOG%"',
    'if !ec! neq 0 (',
    '  set /a n+=1',
    '  if !n! lss 3 ( powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3" & goto install )',
    '  echo [%date% %time%] install failed, open releases >> "%LOG%"',
    '  start "" "https://github.com/GinyvaXu/GinyScreen/releases"',
    '  goto end',
    ')',
    'echo [%date% %time%] relaunch >> "%LOG%"',
    'if exist "%EXE%" powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%EXE%'"',
    ':end',
    'del "%INST%" >nul 2>&1',
    '(goto) 2>nul & del "%~f0"',
  ].join('\r\n');
  writeFileSync(batPath, lines, 'utf8');
  const child = spawn('cmd.exe', ['/c', batPath, installerPath, exePath, logPath, name], {
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return batPath;
}

/**
 * 应用更新：检查 → 下载 → 确认 → 静默安装并重启
 */
export async function applyUpdate({ currentVersion, logger, onProgress }) {
  const check = await checkForUpdate({ currentVersion, onStatus: onProgress });
  if (!check.ok) return check;
  if (!check.hasUpdate || !check.url) {
    return { ok: true, message: '已是最新版本' };
  }
  if (isPortable()) {
    shell.openExternal(RELEASE_PAGE);
    return { ok: false, message: '便携版不支持自动更新，已打开下载页，请手动下载新版' };
  }
  const destPath = join(app.getPath('temp'), `GinyScreen-Setup-${check.latest}.exe`);
  try {
    onProgress?.('正在下载新版本…');
    await downloadInstaller(check.url, destPath, (pct) => onProgress?.(pct));
  } catch (err) {
    dialog.showErrorBox('更新失败', `下载安装包失败：\n${err?.message || err}`);
    return { ok: false, error: 'download', message: String(err?.message || err) };
  }
  // 记录更新标记：重启后据此校验安装是否生效
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(markerFile(), JSON.stringify({ from: String(currentVersion), target: String(check.latest), at: Date.now() }), 'utf8');
  } catch { /* 标记写失败不阻塞更新 */ }


  const choice = dialog.showMessageBoxSync({
    type: 'question',
    title: 'GinyScreen 更新',
    message: `新版本 v${check.latest} 已下载`,
    detail: `${check.notes?.slice(0, 400) || '点击确定安装并重启。'}\n\n安装过程中程序会自动关闭，完成后自动打开新版本。`,
    buttons: ['立即更新', '稍后'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice !== 0) return { ok: true, message: '已取消，下次启动可再次更新' };

  const logPath = join(app.getPath('temp'), 'GinyScreen-update.log');
  mkdirSync(app.getPath('temp'), { recursive: true });
  launchUpdateBatch(destPath, process.execPath, logPath);
  logger?.work?.(`更新批处理已启动，程序即将退出自动安装`);
  app.quit();
  return { ok: true, message: '正在安装更新，程序将自动重启' };
}
