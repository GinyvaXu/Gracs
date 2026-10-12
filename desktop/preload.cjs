// preload.cjs — 渲染进程安全桥（contextIsolation 开启时暴露最小 API）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gvDesktop', {
  // 检查更新 → { ok, current, latest, hasUpdate, url, notes, source, error, detail }
  checkUpdate: () => ipcRenderer.invoke('gv:check-update'),
  // 应用更新（下载 + 确认 + 静默安装 + 重启）
  applyUpdate: () => ipcRenderer.invoke('gv:apply-update'),
  // 打开 GitHub Releases 页
  openReleasePage: () => ipcRenderer.invoke('gv:open-release-page'),
  // 退出应用
  quit: () => ipcRenderer.send('gv:quit'),
  // 服务器设置（本机开服 / 连接远程）
  getServerConfig: () => ipcRenderer.invoke('gv:get-server-config'),
  setServerConfig: (cfg) => ipcRenderer.invoke('gv:set-server-config', cfg),
  // 内置屏幕/窗口选择器（getDisplayMedia 由主进程提供桌面源）
  onDisplaySourceList: (cb) => ipcRenderer.on('gv:display-source-list', (_e, list) => cb(list)),
  pickDisplaySource: (sourceId) => ipcRenderer.send('gv:pick-display-source', sourceId),
  cancelDisplaySource: () => ipcRenderer.send('gv:cancel-display-source'),
  // 系统声音启动失败（声卡驱动不兼容回环）→ 通知主进程按上次来源自动重试（无音频、不弹二次选择器）
  // opts.useHelper=true 时渲染进程会用 helper 兼容采集系统声音（主进程保留窗口声音隔离）
  notifyAudioFallback: (opts) => ipcRenderer.invoke('gv:audio-fallback', opts || {}),
  // 兼容模式系统声音：helper 采集回环 PCM → 渲染进程合成 MediaStreamTrack
  startSystemAudio: () => ipcRenderer.invoke('gv:system-audio-start'),
  stopSystemAudio: () => ipcRenderer.send('gv:system-audio-stop'),
  onSystemAudioFormat: (cb) => { const h = (_e, f) => cb(f); ipcRenderer.on('gv:system-audio-format', h); return () => ipcRenderer.removeListener('gv:system-audio-format', h); },
  onSystemAudioChunk: (cb) => { const h = (_e, b) => cb(b); ipcRenderer.on('gv:system-audio-chunk', h); return () => ipcRenderer.removeListener('gv:system-audio-chunk', h); },
  onSystemAudioEnd: (cb) => { const h = () => cb(); ipcRenderer.on('gv:system-audio-end', h); return () => ipcRenderer.removeListener('gv:system-audio-end', h); },
  // 窗口声音方案A：停止共享时恢复被静音的其他应用
  restoreWindowAudio: () => ipcRenderer.send('gv:restore-window-audio'),
  // Radmin VPN 联机
  radminStatus: () => ipcRenderer.invoke('gv:radmin-status'),
  radminInstall: () => ipcRenderer.invoke('gv:radmin-install'),
  radminNetwork: (mode, name, pwd) => ipcRenderer.invoke('gv:radmin-network', mode, name, pwd),
  // 更新进度/状态推送：cb({ stage })
  onUpdateProgress: (cb) => ipcRenderer.on('gv:update-progress', (_e, data) => cb(data)),
  // 启动时后台发现新版本：cb(result)
  onUpdateAvailable: (cb) => ipcRenderer.on('gv:update-available', (_e, data) => cb(data)),
});
