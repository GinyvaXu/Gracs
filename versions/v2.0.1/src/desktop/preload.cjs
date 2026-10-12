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
