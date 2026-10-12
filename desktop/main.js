// desktop/main.js — Gracs桌面版（Electron 主进程）
// 职责：内嵌启动信令服务器 → 打开主窗口；系统托盘驻留；日志落盘（Debug 版）
import { app, BrowserWindow, Tray, Menu, nativeImage, clipboard, session, dialog, ipcMain, shell, desktopCapturer } from 'electron';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 崩溃报告：主进程未捕获异常/拒绝 → 写 crash_时间戳_类型.txt ──
process.on('uncaughtException', (err) => { writeCrashReport('uncaughtException', err); });
process.on('unhandledRejection', (reason) => { writeCrashReport('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason))); });

function writeCrashReport(kind, err) {
  try {
    const dir = process.env.LOG_DIR || join(__dirname, '..', 'logs');
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const file = join(dir, `crash_${ts}_${kind}.txt`);
    writeFileSync(file, `${kind}: ${err?.stack || err}\n`, 'utf8');
    console.error('已写入崩溃报告:', file);
  } catch { /* 崩溃报告失败不阻塞退出 */ }
}

// Debug 版判定：便携版 exe 文件名含 "Debug"，或环境变量 GV_DEBUG=1
// （便携版运行时 electron-builder 会注入 PORTABLE_EXECUTABLE_FILE）
const isDebugBuild = (process.env.PORTABLE_EXECUTABLE_FILE || process.execPath).toLowerCase().includes('debug') || process.env.GV_DEBUG === '1';

// ── 单实例锁：重复启动时唤起已有窗口 ──
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // relaunch 竞态：app.relaunch 会在旧实例完全退出前启动新实例，此时拿不到单实例锁；
  // 带 --gv-relaunch 标记时短暂重试，避免新实例启动即退出
  if (process.argv.includes('--gv-relaunch')) {
    let lockTries = 0;
    const retryLock = () => {
      if (app.requestSingleInstanceLock()) {
        app.on('second-instance', () => showMainWindow());
        bootstrap();
      } else if (++lockTries < 20) {
        setTimeout(retryLock, 300);
      } else {
        app.quit();
      }
    };
    retryLock();
  } else {
    app.quit();
  }
} else {
  app.on('second-instance', () => showMainWindow());
  bootstrap();
}

let mainWindow = null;
let tray = null;
let serverHandle = null;
let appUrl = '';
let quitting = false;
let serverPort = 3000;
let pendingDisplayCapture = null; // { callback, audioRequested, sources }
let lastDisplayPick = null;       // { sourceId, at } 最近一次用户在应用内选择器里选中的来源
let lastDisplayPickInfo = null;   // { sourceId, type, pid, name, at } 同上（含窗口 PID，供「跟随共享窗口」音频源）
let audioFallbackUntil = 0;       // 系统声音启动失败后的自动重试窗口（主进程收到 gv:audio-fallback 时设置）
let helperAudioFallback = false;  // 自动重试时是否用 helper 兼容采集系统声音（true）还是仅画面（false）
let systemAudioProc = null;       // 兼容模式系统声音采集进程（gv-helper audio capture）
let activeWindowAudioSnapshot = null; // 窗口声音方案A：被静音应用的快照路径
let remoteRecoveryShown = false;
let localUrlForRecovery = '';
let publicUrl = '';   // 自动端口映射成功后得到的公网入口（发给好友用）

// ── 服务器连接配置（本机开服 / 连接朋友的远程服务器）──
let connCfg = { mode: 'local', address: '', port: 3000, nickname: '' };
let remoteOrigin = null;
let logger = null; // module-level, 由 bootstrap() 赋值，供 IPC/更新处理器使用

function connectionFile() {
  return join(app.getPath('userData'), 'connection.json');
}

function readConnectionConfig() {
  try {
    const raw = readFileSync(connectionFile(), 'utf8');
    const cfg = JSON.parse(raw);
    const port = Math.min(65535, Math.max(1024, Number(cfg?.port) || 3000));
    const nickname = String(cfg?.nickname || '').slice(0, 16);
    if (cfg?.mode === 'remote' && typeof cfg.address === 'string' && cfg.address.trim()) {
      return { mode: 'remote', address: normalizeRemoteAddress(cfg.address), port, nickname };
    }
    if (cfg?.mode === 'local') {
      return { mode: 'local', address: '', port, nickname };
    }
  } catch { /* 无配置或损坏 → 本机开服 */ }
  return { mode: 'local', address: '', port: 3000, nickname: '' };
}

function normalizeRemoteAddress(input) {
  let s = String(input).trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) {
    // 裸 IPv6（含 2 个以上冒号且没有方括号）先自动补方括号，避免 new URL 直接失败
    const colonCount = (s.match(/:/g) || []).length;
    if (!s.startsWith('[') && colonCount >= 2) {
      try {
        new URL(`http://[${s}]`);      // 整串是一个合法 IPv6（无端口）→ 用默认端口
        s = `[${s}]`;
      } catch {
        const m = s.match(/^(.*):(\d{1,5})$/);   // 否则尝试按「IPv6:端口」拆分
        if (m && m[1].includes(':')) s = `[${m[1]}]:${m[2]}`;
        else return '';
      }
    }
    // 内网/组网虚拟 IP、localhost、【IPv6】走明文 HTTP；公网域名（如 SakuraFrp 隧道）默认 HTTPS
    const m = s.match(/^\[([^\]]+)\]|^([^:]+)/);
    const host = m ? (m[1] || m[2]) : s;
    const isLocal = /^[\d.]+$/.test(host) || host.includes(':') || /^(localhost|.+\.(local|lan|home))$/i.test(host);
    s = (isLocal ? 'http://' : 'https://') + s;
  }
  try {
    const u = new URL(s);
    if (!u.port) u.port = '3000';
    return u.origin;
  } catch {
    return '';
  }
}

function writeConnectionConfig(cfg) {
  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  writeFileSync(connectionFile(), JSON.stringify(cfg, null, 2), 'utf8');
}

function getLocalUrls(port) {
  const urls = [];
  if (publicUrl) urls.push(publicUrl);   // 公网入口优先展示（零外置软件直连）
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.internal || net.address === '::1' || net.address.startsWith('fe80')) continue;
      urls.push(net.family === 'IPv6' ? `http://[${net.address}]:${port}` : `http://${net.address}:${port}`);
    }
  }
  if (serverHandle?.httpsPort) urls.push(`https://127.0.0.1:${serverHandle.httpsPort}`);
  return urls;
}

async function bootstrap() {
  const isPackaged = app.isPackaged;
  const logDir = resolveLogDir(isPackaged);
  process.env.LOG_DIR = logDir;
  // 可写状态目录：打包后 asar 内不可写，证书/中继密钥等持久化文件放这里
  process.env.GV_STATE_DIR = logDir;
  process.env.GV_CERT_DIR = join(logDir, 'certs');
  process.env.NODE_ENV = isDebugBuild ? 'debug' : 'production';
  process.env.DEBUG_LOG = isDebugBuild ? '1' : '0';

  const { startGracsServer } = await import('../server/app.js');
  logger = (await import('../server/logger.js')).logger;
  const cdpArg = process.argv.find((a) => a.startsWith('--remote-debugging-port='));
  if (cdpArg) logger.work('远程调试端口: ' + cdpArg);
  logger.work('══════════════════════════════════════════');
  logger.work('  🖥️ Gracs 桌面版启动中 (Debug 日志已开启)');
  logger.work(`  日志目录: ${logDir}`);
  logger.work('══════════════════════════════════════════');

  connCfg = readConnectionConfig();
  remoteOrigin = connCfg.mode === 'remote' ? connCfg.address : null;
  serverPort = connCfg.port;
  const autoJoin = process.argv.includes('--autojoin');
  if (remoteOrigin) {
    // 远程服务器多为内网/虚拟局域网明文 HTTP，Chromium 默认不给 getUserMedia 权限；
    // 将该 origin 标记为安全来源（必须在 app ready 前设置）
    app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', remoteOrigin);
    logger.work(`连接远程服务器: ${remoteOrigin}`);
  }

  // 语音/共享音频播放需要 WebAudio，桌面版放开自动播放限制
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

  // 启动画面：尽早出现（服务启动 + 页面加载期间不再黑屏等待），主窗口就绪后淡出
  await app.whenReady();
  app.setAppUserModelId('com.gracs.app');
  createSplash();
  app.on('before-quit', () => closeSplash());

  // 始终启动本地服务器：本机开服时它是房间服务器；远程模式下作为「恢复页」兜底（失败时跳回本地设置页）
  try {
    serverHandle = await startGracsServer({
      port: connCfg.port,   // 主机自选端口（默认 3000）
      host: '::',           // 双栈监听：本机/局域网/IPv6 均可访问
      retryOnBusy: connCfg.mode === 'remote', // 本机开服端口必须严格；远程模式可自动换端口
      onNetworkReady: () => {
        const g = serverHandle?.network?.gateway;
        const t = serverHandle?.network?.turn;
        if (g?.ok && g.externalIp) {
          const tcp = (g.mappings || []).find((m) => m.protocol === 'tcp' && m.internalPort === serverPort);
          publicUrl = `http://${g.externalIp}:${tcp?.externalPort || serverPort}`;
          logger.work(`公网入口已打通: ${publicUrl}`);
        }
        if (t?.running) logger.work(`内嵌中继服务运行中: UDP/TCP ${t.port}`);
        refreshTrayMenu();
      },
    });
  } catch (err) {
    logger.error('服务器启动失败:', err);
    closeSplash();
    dialog.showErrorBox('Gracs', '服务器启动失败（端口可能被占用），请查看日志：\n' + (err?.message || String(err)));
    app.quit();
    return;
  }
  serverPort = serverHandle.port;
  localUrlForRecovery = `http://127.0.0.1:${serverPort}`;
  if (connCfg.mode === 'remote') {
    appUrl = remoteOrigin;
    logger.work(`远程模式：窗口加载 ${appUrl}（本地兜底 ${localUrlForRecovery}）`);
  } else {
    appUrl = localUrlForRecovery;
    logger.work(`服务器已启动: ${appUrl}`);
  }

  if (autoJoin && connCfg.nickname) {
    appUrl += (appUrl.includes('?') ? '&' : '?') + `autojoin=1&nick=${encodeURIComponent(connCfg.nickname)}`;
    logger.work('自动进入房间（--autojoin）');
  }

  openDebugConsole(logDir);

  // 权限：屏幕采集 / 系统声音 自动放行（本软件只加载自家页面）
  // 注意：session 必须在 app ready 之后使用
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allow = ['media', 'display-capture', 'audioCapture', 'videoCapture', 'mediaKeySystem'].includes(permission);
    callback(allow);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    ['media', 'display-capture', 'audioCapture', 'videoCapture'].includes(permission)
  );

  wireDisplayCapture();
  wireSystemAudioCapture();

  // 自动更新启动校验：上次安装是否已生效（参考诺丁汉 updater 的 boot marker）
  try {
    const { verifyUpdateMarker } = await import('./updater.js');
    verifyUpdateMarker(app.getVersion(), logger);
  } catch { /* 校验失败不影响启动 */ }

  createWindow();
  createTray();
  wireUpdater();
  logger.work('桌面版就绪，主窗口已打开');

  // 安装版启动时后台静默检查更新（便携版/开发版不自动检查）
  if (app.isPackaged && !isPortableBuild()) {
    autoCheckUpdate();
  }
}

// ── 屏幕采集：注册 getDisplayMedia 处理器，用桌面源列表做内置选择器 ──
function wireDisplayCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      // 系统声音启动失败（声卡驱动不兼容回环）后的自动降级：沿用上次选择的来源、仅画面、不再弹选择器
      const canFallback = !request.audioRequested && lastDisplayPick
        && Date.now() < audioFallbackUntil && Date.now() - lastDisplayPick.at < 60_000;
      audioFallbackUntil = 0;
      if (canFallback) {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        const source = sources.find((src) => src.id === lastDisplayPick.sourceId);
        if (source) {
          // 兼容模式（helper 采集系统声音）→ 保留窗口声音隔离；仅画面 → 恢复被静音的应用
          const keepIsolation = helperAudioFallback;
          helperAudioFallback = false;
          if (!keepIsolation) await restoreMutedApps();
          logger.work(`系统声音启动失败 → 自动沿用上次来源${keepIsolation ? '（兼容模式采集声音）' : '（仅画面）'}：${source.name}`);
          callback({ video: source });
          return;
        }
      }
      helperAudioFallback = false;
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true,
      });
      const list = sources.map((src) => ({
        id: src.id,
        name: src.name,
        type: String(src.id).startsWith('screen:') ? 'screen' : 'window',
        thumbnail: src.thumbnail && !src.thumbnail.isEmpty() ? src.thumbnail.toDataURL() : '',
      }));
      pendingDisplayCapture = { callback, audioRequested: request.audioRequested, sources };
      logger.work(`屏幕采集请求：来源候选 ${sources.length} 个 · 页面请求音频=${request.audioRequested ? '是' : '否'}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('gv:display-source-list', list);
      } else {
        callback(null);
      }
    } catch (err) {
      logger.error('desktopCapturer 获取源失败:', err);
      callback(null);
    }
  });

  ipcMain.on('gv:pick-display-source', async (_e, sourceId) => {
    const pending = pendingDisplayCapture;
    pendingDisplayCapture = null;
    if (!pending) return;
    const source = pending.sources.find((src) => src.id === sourceId);
    if (!source) { pending.callback(null); return; }
    lastDisplayPick = { sourceId: source.id, at: Date.now() };
    // 记录本次选择（含窗口 PID，供「跟随共享窗口」音频源解析）
    let pickPid = 0;
    if (String(source.id).startsWith('window:')) {
      try { pickPid = Number(await windowPidFromSource(source)) || 0; } catch { pickPid = 0; }
    }
    lastDisplayPickInfo = {
      sourceId: source.id,
      type: String(source.id).startsWith('screen:') ? 'screen' : 'window',
      pid: pickPid,
      name: source.name,
      at: Date.now(),
    };
    // 窗口声音方案A：共享「窗口」并勾选系统声音时，静音其它应用（含本机语音回放），
    // 让回环采集只包含该窗口的声音，也避免他人声音/杂音被当作共享音频传回。
    if (pending.audioRequested && String(source.id).startsWith('window:')) {
      try {
        const pid = await windowPidFromSource(source);
        if (pid) {
          activeWindowAudioSnapshot = join(app.getPath('temp'), `gv-share-audio-${Date.now()}.tsv`);
          const r = await runHelper(['audio', 'mute-others', String(pid), activeWindowAudioSnapshot]);
          logger.work('窗口声音共享：已静音其它应用 → ' + (r.ok ? r.out : (r.err || '失败')));
        }
      } catch (err) {
        logger.error('静音其它应用失败（不影响共享）:', err);
        activeWindowAudioSnapshot = null;
      }
    }
    pending.callback({
      video: source,
      audio: pending.audioRequested ? 'loopback' : undefined,
    });
    logger.work(`屏幕采集选择：${source.name}（${source.type}）· 系统声音=${pending.audioRequested ? 'loopback 回环采集（保留本机回放）' : '关闭（页面未请求音频）'}`);
  });

  // 系统声音启动失败（页面收到 NotReadableError）→ 打开自动降级窗口：
  // 下一次采集直接沿用上次来源、不弹选择器；useHelper=true 时渲染进程将用 helper 兼容采集系统声音
  ipcMain.handle('gv:audio-fallback', (_e, opts = {}) => {
    audioFallbackUntil = Date.now() + 30_000;
    helperAudioFallback = !!(opts && opts.useHelper);
    logger.work('系统声音启动失败：下次采集将自动沿用上次来源' + (helperAudioFallback ? '（兼容模式：helper 采集系统声音）' : '（仅画面，不再弹选择器）'));
    return { ok: true };
  });

  // 停止共享 / 降级时恢复被静音的其他应用
  ipcMain.on('gv:restore-window-audio', () => { restoreMutedApps(); });

  ipcMain.on('gv:cancel-display-source', () => {
    const pending = pendingDisplayCapture;
    pendingDisplayCapture = null;
    pending?.callback(null);
  });
}

/** 发送事件到主窗口（窗口不存在/已销毁时静默忽略） */
function sendToWindow(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  } catch { /* 忽略 */ }
}

// ── 兼容模式系统声音：helper 回环采集（NAudio）→ 裸 PCM 流 → 渲染进程合成音轨 ──
// 用于 Chromium/Electron 自带回环在部分声卡驱动上失败
// （NotReadableError: Could not start audio source）的机器。
function wireSystemAudioCapture() {
  const stopCapture = () => {
    const p = systemAudioProc;
    systemAudioProc = null;
    if (!p) return;
    try { p.kill(); } catch { /* 忽略 */ }
  };

  ipcMain.handle('gv:system-audio-start', async (_e, opts = {}) => {
    stopCapture();
    const helper = helperPath();
    if (!existsSync(helper)) return { ok: false, error: '缺少音频兼容组件（gv-helper.exe）' };
    const pid = Number(opts?.pid) || 0;
    return await new Promise((resolve) => {
      let settled = false;
      let headerDone = false;
      let header = '';
      const finish = (res) => { if (!settled) { settled = true; resolve(res); } };
      let proc;
      try {
        const args = pid > 0 ? ['audio', 'capture', '--pid', String(pid)] : ['audio', 'capture'];
        proc = spawn(helper, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        finish({ ok: false, error: String(err?.message || err) });
        return;
      }
      systemAudioProc = proc;
      const timer = setTimeout(() => { finish({ ok: false, error: '采集启动超时' }); stopCapture(); }, 8000);

      proc.stdout.on('data', (buf) => {
        if (!headerDone) {
          header += buf.toString('latin1');
          const nl = header.indexOf('\n');
          if (nl < 0) return;
          headerDone = true;
          const line = header.slice(0, nl).trim();
          const rest = Buffer.from(header.slice(nl + 1), 'latin1');
          const m = /^#PCM (\d+) (\d+) 16$/.exec(line);
          if (!m) {
            finish({ ok: false, error: '输出格式无效: ' + line.slice(0, 40) });
            stopCapture();
            return;
          }
          const format = { rate: Number(m[1]), channels: Number(m[2]) };
          logger.work(`系统声音兼容采集已启动：${format.rate}Hz × ${format.channels}ch`);
          sendToWindow('gv:system-audio-format', format);
          if (rest.length) sendToWindow('gv:system-audio-chunk', rest);
          clearTimeout(timer);
          finish({ ok: true, format });
          return;
        }
        sendToWindow('gv:system-audio-chunk', buf);
      });
      proc.stderr.on('data', (b) => logger.error('gv-helper(audio capture): ' + String(b).trim()));
      proc.on('error', (err) => {
        clearTimeout(timer);
        finish({ ok: false, error: String(err?.message || err) });
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (systemAudioProc === proc) systemAudioProc = null;
        sendToWindow('gv:system-audio-end');
        if (settled) logger.work(`系统声音兼容采集结束（code ${code ?? '?'}）`);
        else finish({ ok: false, error: `采集进程退出（code ${code ?? '?'}）` });
      });
    });
  });

  // 列出当前发声的应用（用于「音频源：指定应用」选择器）
  ipcMain.handle('gv:audio-sessions', () => new Promise((resolve) => {
    const helper = helperPath();
    if (!existsSync(helper)) return resolve({ ok: false, error: '缺少音频组件（gv-helper.exe）' });
    let out = '';
    let child;
    try {
      child = spawn(helper, ['audio', 'list'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ ok: false, error: String(err?.message || err) });
    }
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.on('error', (err) => resolve({ ok: false, error: String(err?.message || err) }));
    child.on('exit', () => {
      const lines = out.split(/\r?\n/).filter((l) => l.length);
      const header = lines.shift() || '';
      const device = (/device=(.*?) sessions=/.exec(header) || [])[1] || '';
      const sessions = [];
      for (const raw of lines) {
        const m = /^(\d+)\t([^\t]*)\tmuted=([01])$/.exec(raw.replace(/\r$/, ''));
        if (m) sessions.push({ pid: Number(m[1]), name: m[2], muted: m[3] === '1' });
      }
      resolve({ ok: true, device, sessions });
    });
  }));

  // 最近一次屏幕/窗口选择（含窗口 PID 与新鲜度，用于「跟随共享窗口」音频源）
  ipcMain.handle('gv:last-display-pick', () => {
    const info = lastDisplayPickInfo;
    if (!info) return null;
    return { ...info, fresh: Date.now() - info.at < 60_000 };
  });

  ipcMain.on('gv:system-audio-stop', () => stopCapture());
  app.on('before-quit', () => stopCapture());
}

/** 恢复「窗口声音」方案中为隔离声音而静音的其它应用（幂等：无快照时直接返回） */
async function restoreMutedApps() {
  if (!activeWindowAudioSnapshot) return;
  const snap = activeWindowAudioSnapshot;
  activeWindowAudioSnapshot = null;
  try {
    const r = await runHelper(['audio', 'restore', snap]);
    logger.work('恢复音频会话 → ' + (r.ok ? r.out : (r.err || '失败')));
  } catch (err) {
    logger.error('恢复音频失败:', err);
  }
  try { rmSync(snap, { force: true }); } catch { /* 忽略 */ }
}

function resolveLogDir(isPackaged) {
  if (!isPackaged) {
    return join(__dirname, '..', 'logs');
  }
  // 便携版：exe 所在目录
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return join(process.env.PORTABLE_EXECUTABLE_DIR, 'logs');
  }
  // 安装版：优先安装目录，不可写时退回用户数据目录
  const exeLogDir = join(dirname(process.execPath), 'logs');
  try {
    mkdirSync(exeLogDir, { recursive: true });
    writeFileSync(join(exeLogDir, '.write-test'), 'ok');
    return exeLogDir;
  } catch {
    return join(app.getPath('userData'), 'logs');
  }
}

// Debug 控制台：打包版弹出一个窗口实时滚动显示 work/error 日志（开发模式直接看终端，不弹）
function openDebugConsole(logDir) {
  if (!app.isPackaged || !isDebugBuild) return; // 开发模式日志已在终端可见；正式版不弹控制台
  try {
    const scriptPath = join(logDir, '_debug-console.ps1');
    const ps = `$Host.UI.RawUI.WindowTitle = 'Gracs Debug 控制台'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 > $null
Write-Host '=================================================='
Write-Host '  Gracs Debug 控制台 - 实时日志'
Write-Host ('  日志目录: ' + '${logDir}')
Write-Host '  关闭本窗口不影响程序运行；退出程序后窗口自动失效'
Write-Host '=================================================='
$pos = @{}
while ($true) {
  Get-ChildItem -Path '${logDir}' -Filter *.log -ErrorAction SilentlyContinue | ForEach-Object {
    $f = $_
    $len = $f.Length
    if (-not $pos.ContainsKey($f.FullName)) { $pos[$f.FullName] = 0 }
    if ($len -gt $pos[$f.FullName]) {
      try {
        $stream = [System.IO.File]::Open($f.FullName, 'Open', 'Read', 'ReadWrite')
        $stream.Seek($pos[$f.FullName], 'Begin') | Out-Null
        $reader = New-Object System.IO.StreamReader($stream)
        $text = $reader.ReadToEnd()
        $reader.Close()
        $stream.Close()
        if ($text) { Write-Host $text.TrimEnd([char]13, [char]10) }
        $pos[$f.FullName] = $len
      } catch { }
    }
  }
  Start-Sleep -Milliseconds 500
}`;
    // PS 5.1 需带 BOM 才能正确读取中文
    writeFileSync(scriptPath, '\ufeff' + ps, 'utf8');
    // 以 logs 目录为 cwd 用相对文件名启动，避免项目路径中的 & 干扰命令行
    const child = spawn('powershell.exe', ['-NoExit', '-ExecutionPolicy', 'Bypass', '-File', '_debug-console.ps1'], {
      cwd: logDir,
      stdio: 'ignore',
    });
    child.unref();
  } catch { /* 控制台打不开不阻塞主程序 */ }
}

// ── 启动画面：品牌加载动画（服务启动/页面加载期间显示，主窗口就绪后淡出）──
let splashWindow = null;
const SPLASH_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#0b0d14;overflow:hidden}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;
    font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#e8ecf8;
    background:radial-gradient(600px 320px at 50% -10%,rgba(77,212,200,.1),transparent 60%),#0b0d14}
  .mark{position:relative;width:84px;height:84px;display:grid;place-items:center}
  .scr{font-size:40px;filter:drop-shadow(0 0 14px rgba(77,212,200,.45));animation:breathe 1.8s ease-in-out infinite}
  .ring{position:absolute;inset:0;border-radius:50%;border:2px solid transparent;border-top-color:#4dd4c8;animation:spin 1s linear infinite}
  .ring::after{content:"";position:absolute;inset:6px;border-radius:50%;border:2px solid transparent;border-bottom-color:rgba(139,124,246,.85);animation:spin 1.6s linear infinite reverse}
  .title{font-size:22px;font-weight:700;letter-spacing:.5px}
  .sub{font-size:12px;color:#97a0b8}
  .dots{display:flex;gap:6px}
  .dots i{width:6px;height:6px;border-radius:50%;background:#4dd4c8;opacity:.35;animation:dot 1.2s ease-in-out infinite}
  .dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}
  @keyframes dot{0%,100%{opacity:.3;transform:translateY(0)}50%{opacity:1;transform:translateY(-3px)}}
</style></head><body>
  <div class="mark"><span class="scr">🖥️</span><span class="ring"></span></div>
  <div class="title">Gracs</div>
  <div class="sub">一起看屏幕 · 正在启动本机服务…</div>
  <div class="dots"><i></i><i></i><i></i></div>
</body></html>`;

function createSplash() {
  try {
    splashWindow = new BrowserWindow({
      width: 420, height: 240,
      frame: false, resizable: false, movable: true, show: false,
      alwaysOnTop: true, skipTaskbar: true, fullscreenable: false,
      backgroundColor: '#0b0d14',
      icon: join(__dirname, '..', 'assets', 'tray.png'),
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(SPLASH_HTML));
    splashWindow.once('ready-to-show', () => { try { splashWindow?.show(); } catch { /* 忽略 */ } });
    splashWindow.on('closed', () => { splashWindow = null; });
  } catch { splashWindow = null; }
}

function closeSplash() {
  const w = splashWindow;
  splashWindow = null;
  if (!w) return;
  try {
    let opacity = 1;
    const timer = setInterval(() => {
      opacity -= 0.14;
      if (opacity <= 0) { clearInterval(timer); try { w.destroy(); } catch { /* 忽略 */ } return; }
      try { w.setOpacity(opacity); } catch { clearInterval(timer); try { w.destroy(); } catch { /* 忽略 */ } }
    }, 24);
  } catch { try { w.destroy(); } catch { /* 忽略 */ } }
}

function createWindow() {  const iconPath = join(__dirname, '..', 'assets', 'tray.png');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'Gracs',
    icon: iconPath,
    backgroundColor: '#14151a',
    autoHideMenuBar: true,
    show: false,   // 等 ready-to-show 再显示，避免白屏闪烁（启动画面淡出衔接）
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow.loadURL(appUrl);
  // 安全：外部链接一律交给系统浏览器；主窗口不允许导航离开应用页面
  // （preload 桥暴露了设置/更新等能力，页面被导航到第三方站点会带来风险）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) { try { shell.openExternal(url); } catch { /* 忽略 */ } }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    try {
      const target = new URL(url);
      const current = new URL(appUrl);
      const sameServer = target.host === current.host || (!!remoteOrigin && url.startsWith(remoteOrigin));
      if (sameServer || target.protocol === 'file:') return;
      e.preventDefault();
      if (/^https?:/i.test(url)) { try { shell.openExternal(url); } catch { /* 忽略 */ } }
    } catch {
      e.preventDefault();
    }
  });
  // 主窗口就绪 → 显示并淡出启动画面；远程模式加载慢/失败时 12s 兜底（恢复页接管）
  mainWindow.once('ready-to-show', () => {
    try { mainWindow.show(); } catch { /* 忽略 */ }
    closeSplash();
  });
  setTimeout(() => {
    if (splashWindow) closeSplash();
    try {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
    } catch { /* 忽略 */ }
  }, 12_000);
  mainWindow.webContents.on('render-process-gone', (_e, details) =>
    writeCrashReport('renderer-gone', new Error(JSON.stringify(details)))
  );
  // 远程模式：加载失败 / 返回非 Gracs 页面（如 SakuraFrp 501 拦截页）时跳回本地设置页
  if (connCfg.mode === 'remote' && remoteOrigin) {
    remoteRecoveryShown = false;
    const wc = mainWindow.webContents;
    wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
      if (isMainFrame && code !== -3 && failedUrl.startsWith(remoteOrigin)) {
        showRemoteRecovery(`无法连接 ${failedUrl}（${desc || code}）`);
      }
    });
    wc.on('did-finish-load', async () => {
      try {
        const u = wc.getURL();
        if (!u.startsWith(remoteOrigin)) return; // 恢复页/本地页不检查
        const isApp = await wc.executeJavaScript("!!(document.getElementById('screen-lobby')||document.getElementById('screen-room'))");
        if (!isApp) showRemoteRecovery(`目标地址 ${u} 返回的不是 Gracs 界面（可能被网络拦截）`);
      } catch { /* 页面异常时保持现状 */ }
    });
  }
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide(); // 最小化到托盘
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  if (isDebugBuild) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function createTray() {
  if (process.platform === 'darwin') return;
  const image = nativeImage.createFromPath(join(__dirname, '..', 'assets', 'tray.png'));
  tray = new Tray(image);
  tray.setToolTip('Gracs');
  refreshTrayMenu();
  tray.on('double-click', () => showMainWindow());
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主界面', click: () => showMainWindow() },
    { label: '复制访问地址', click: () => clipboard.writeText(remoteOrigin || publicUrl || getLocalUrls(serverPort)[0] || appUrl) },
    { label: '返回服务器设置', click: () => { if (remoteOrigin) { remoteRecoveryShown = false; showRemoteRecovery('手动返回设置'); } } },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; shutdown(); } },
  ]));
}

function showRemoteRecovery(reason) {
  if (remoteRecoveryShown || !mainWindow || mainWindow.isDestroyed()) return;
  remoteRecoveryShown = true;
  logger.work('远程加载失败，返回本地设置页: ' + reason);
  const url = localUrlForRecovery + (localUrlForRecovery.includes('?') ? '&' : '?') + 'recover=1';
  mainWindow.loadURL(url);
}

function showMainWindow() {
  if (!mainWindow) { createWindow(); return; }
  mainWindow.show();
  mainWindow.focus();
}

// ---------- 自动更新（IPC + 后台检查）----------
function isPortableBuild() {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
}

function wireUpdater() {
  ipcMain.handle('gv:check-update', async () => {
    const { checkForUpdate } = await import('./updater.js');
    return checkForUpdate({
      currentVersion: app.getVersion(),
      onStatus: (stage) => mainWindow?.webContents.send('gv:update-progress', { stage }),
    });
  });
  ipcMain.handle('gv:apply-update', async () => {
    const { applyUpdate } = await import('./updater.js');
    return applyUpdate({
      currentVersion: app.getVersion(),
      logger,
      onProgress: (stage) => mainWindow?.webContents.send('gv:update-progress', { stage }),
    });
  });
  ipcMain.handle('gv:open-release-page', async () => {
    const { RELEASE_PAGE } = await import('./updater.js');
    shell.openExternal(RELEASE_PAGE);
    return { ok: true };
  });
  // 服务器设置（帮助 → 服务器设置）
  ipcMain.handle('gv:get-server-config', () => ({
    mode: connCfg.mode,
    address: connCfg.address,
    port: connCfg.port,
    nickname: connCfg.nickname,
    localUrls: getLocalUrls(connCfg.port),
  }));
  ipcMain.handle('gv:set-server-config', (_e, { mode, address, port, nickname, autoJoin } = {}) => {
    const nextMode = mode === 'remote' ? 'remote' : 'local';
    const nextPort = Math.min(65535, Math.max(1024, Number(port) || 3000));
    const nextAddress = nextMode === 'remote' ? normalizeRemoteAddress(address || '') : '';
    const nextNickname = String(nickname || '').slice(0, 16);
    if (nextMode === 'remote' && !nextAddress) return { ok: false, error: '服务器地址无效' };
    if (nextMode === 'local' && (Number(port) < 1024 || Number(port) > 65535)) return { ok: false, error: '端口需在 1024-65535 之间' };
    writeConnectionConfig({ mode: nextMode, address: nextAddress, port: nextPort, nickname: nextNickname });
    logger.work(`连接配置已保存: ${nextMode}${nextMode === 'local' ? ' port=' + nextPort : ' → ' + nextAddress}`);
    const relaunchArgs = process.argv.slice(1)
      .filter((a) => a !== '--autojoin' && a !== '--gv-relaunch')
      // 旧实例退出后其调试端口 socket 可能残留 CloseWait，换用新端口避免新实例无法绑定
      .map((a) => (a.startsWith('--remote-debugging-port=') ? '--remote-debugging-port=' + String(39000 + Math.floor(Math.random() * 1000)) : a));
    if (autoJoin) relaunchArgs.push('--autojoin');
    if (!relaunchArgs.includes('--gv-relaunch')) relaunchArgs.push('--gv-relaunch'); // 标记重启用例，容忍单实例锁竞态
    // 手动拉起新进程替代 app.relaunch：Windows 上 app.relaunch + 单实例锁存在竞态，新实例可能不启动
    // 便携版优先用 PORTABLE_EXECUTABLE_FILE（原 stub）：process.execPath 是 stub 解压出的临时 exe，
    // 旧实例退出时 stub 会清理临时目录，直接 spawn 临时 exe 在二次重启时会失败
    const relaunchExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    setTimeout(() => {
      const child = spawn(relaunchExe, relaunchArgs, { detached: true, stdio: 'ignore' });
      child.unref();
      app.exit(0);
    }, 500); // 切换服务器/端口需重启生效
    return { ok: true, restarting: true };
  });
  // ── Radmin VPN 联机（内嵌）──
  ipcMain.handle('gv:radmin-status', async () => {
    try {
      const installed = await isRadminInstalled();
      const r = await runHelper(['radmin', 'describe']);
      const running = r.ok && /status=running/.test(r.out);
      const ipR = await runHelper(['radmin', 'ip']);
      const ip = ipR.ok ? ((ipR.out.match(/ip=([^\s]+)/) || [])[1] || '') : '';
      return { ok: true, installed, running, ip };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });
  ipcMain.handle('gv:radmin-install', async () => {
    const inst = radminInstallerPath();
    if (!existsSync(inst)) return { ok: false, error: '安装包缺失：resources/Radmin_VPN_2.0.4899.9.exe' };
    try {
      // Inno Setup 静默参数 + 提升权限（UAC 由系统弹出）
      const ps = `Start-Process -FilePath '${inst}' -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-' -Verb RunAs`;
      const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true, detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true, elevated: true };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });
  ipcMain.handle('gv:radmin-network', async (_e, mode, name, pwd) => {
    if (!['create', 'join'].includes(mode)) return { ok: false, error: 'mode 无效' };
    const r = await runHelper(['radmin', mode, String(name || ''), String(pwd || '')], 60_000);
    return r.ok ? { ok: true, output: r.out } : { ok: false, error: r.out || r.err || '操作失败，请查看日志' };
  });
  // 界面内退出（帮助 → 退出 Gracs）
  ipcMain.on('gv:quit', () => { quitting = true; shutdown(); });
}

async function autoCheckUpdate() {
  try {
    const { checkForUpdate } = await import('./updater.js');
    const result = await checkForUpdate({ currentVersion: app.getVersion() });
    if (result.ok && result.hasUpdate) {
      mainWindow?.webContents.send('gv:update-available', result);
      logger.work(`发现新版本 v${result.latest}`);
    }
  } catch { /* 后台检查失败静默处理 */ }
}

// ── 系统助手 gv-helper + Radmin 检测 ──
function helperPath() {
  return app.isPackaged ? join(process.resourcesPath, 'gv-helper.exe') : join(__dirname, '..', 'resources', 'gv-helper.exe');
}
function radminInstallerPath() {
  return app.isPackaged ? join(process.resourcesPath, 'Radmin_VPN_2.0.4899.9.exe') : join(__dirname, '..', 'resources', 'Radmin_VPN_2.0.4899.9.exe');
}

function runHelper(args, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(helperPath(), args, { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, code: -1, out: '', err: String(err) });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, out: out.trim(), err: err.trim() });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, out: '', err: String(e) });
    });
  });
}

// 由窗口源 id（window:<hwnd>:0）反查进程 PID
async function windowPidFromSource(source) {
  const m = String(source.id).match(/^window:(\d+)/);
  if (!m) return null;
  const r = await runHelper(['win', 'pid', m[1]]);
  const pid = (r.out.match(/pid=(\d+)/) || [])[1];
  return pid ? Number(pid) : null;
}

function isRadminInstalled() {
  try {
    const r = spawnSync('reg', [
      'query',
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      '/s', '/f', 'Radmin', '/d',
    ], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    if (r.status === 0 && r.stdout) return true;
    const r2 = spawnSync('reg', [
      'query',
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      '/s', '/f', 'Radmin', '/d',
    ], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    return r2.status === 0 && !!r2.stdout;
  } catch {
    return false;
  }
}

// 退出：必须先 app.quit()。内嵌服务器上挂着本应用自己的 Socket.IO 长连接，
// 若先 await server.close() 会永远等不到回调（连接不释放）导致“退不出去”。
function shutdown() {
  try { serverHandle?.server?.closeAllConnections?.(); } catch { /* 忽略 */ }
  try { serverHandle?.server?.close(); } catch { /* 忽略 */ }
  try { serverHandle?.stop?.(); } catch { /* 清理中继与端口映射 */ }
  app.quit();
}

app.on('window-all-closed', () => { /* 驻留托盘，不退出 */ });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => {
  try { serverHandle?.stop?.(); } catch { /* 兜底清理 */ }
  if (activeWindowAudioSnapshot) {
    try {
      const snap = activeWindowAudioSnapshot;
      activeWindowAudioSnapshot = null;
      const r = spawnSync(helperPath(), ['audio', 'restore', snap], { windowsHide: true, timeout: 10000 });
      logger?.work?.('退出前恢复音频 → ' + (r.status === 0 ? r.stdout?.toString().trim() : '失败'));
    } catch { /* 忽略 */ }
  }
});
