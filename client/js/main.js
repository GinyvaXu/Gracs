// main.js — Gracs v2 应用编排（进入页 / 房间 / 共享 / 观看 / 诊断 / 设置）
import { $, $$, toast, openModal, closeModal, storage, urlParam, setUrlParams, copyText, fmtBitrate } from './core.js';
import { fetchConfig, fetchIce, fetchNetworkReport } from './api.js';
import { connectSignaling } from './signaling.js';
import { connectCloudSignaling } from './cloud-signal.js';
import {
  describeEnvironment, canCaptureScreen, captureBlockReason, preferredWebRtcOrder,
  webrtcPreferredCodec, isMobile, isElectron,
} from './capabilities.js';
import { PRESETS, getPreset, startScreenShare, applyPresetToStream } from './screenshare.js';
import { MeshManager } from './webrtc.js';
import { CinemaSender, CinemaReceiver } from './cinema.js';
import { StatsHub } from './stats.js';
import { Stage } from './stage.js';
import * as ui from './ui.js';
import { renderInvite, renderNetworkReport, renderStats, clearStatsHistory, renderSourcePicker, renderQrModal } from './panels.js';
import { initChat, addChatMessage, mergeChatHistory, clearChat } from './chat.js';

// ═══════════ 状态 ═══════════
const state = {
  version: '—',
  features: {},
  maxUsers: 12,
  env: describeEnvironment(),
  settings: {
    linkMode: 'webrtc',
    codecPreference: 'auto',
    uplinkMbps: 20,
    aspect: 'auto',
    audioSource: { mode: 'system' },   // 音频源：system 整机 / follow 跟随共享窗口 / app 指定应用（桌面版）
  },
  socket: null,
  mesh: null,
  cloudCode: null,         // 云房间码（云房间模式下有效）
  cloudHosted: false,      // 页面由云信令服务托管（gracs.ginyva.site 等），进入页只保留「云房间」
  cloudWeb: null,          // 云网页版地址（托管页或 /api/config 提供）
  stats: null,
  stage: null,
  meId: null,
  username: '',
  members: [],
  shares: new Map(),       // peerId -> share
  remotes: new Map(),      // peerId -> { username, stream, audioEl, cinema: { canvas, receiver, lastStats } }
  local: null,             // { stream, mode, preset, meta, cinema: sender, targetKbps }
  focused: null,
  preset: 'auto',
  linkMode: 'webrtc',
  sharePending: false,
  sharePendingTimer: null,
  statsOpen: false,
  joined: false,
};

const names = () => {
  const map = new Map(state.members.map((m) => [m.id, m.username]));
  if (state.meId) map.set(state.meId, state.username + '（我）');
  return map;
};

// 由 wireStaticUI 赋值：进入页模式同步（boot 中 ?cloud= 预处理需要调用）
let syncLobbyMode = () => {};

// ═══════════ 启动 ═══════════
async function boot() {
  loadSettings();
  wireStaticUI();

  try {
    const cfg = await fetchConfig();
    state.version = cfg.appVersion || cfg.version || '—';   // 云网页版：优先显示客户端版本（appVersion）
    state.features = cfg.features || {};
    state.maxUsers = cfg.maxUsers || 12;
    state.stunServers = cfg.stunServers || [];
    if (!state.stunServers.length && Array.isArray(cfg.iceServers) && cfg.iceServers.length) {
      // 云信令 /api/config 用 iceServers 字段：兼容两种写法，保证静态托管时也有 STUN
      state.stunServers = cfg.iceServers
        .map((s) => (typeof s === 'string' ? s : s?.urls))
        .flat()
        .filter(Boolean);
    }
    if (!isElectron && cfg.cloud?.relay) {
      // 页面由云信令服务托管（gracs.ginyva.site）：只保留「云房间」，隐藏本机服务器入口
      state.cloudHosted = true;
      state.cloudWeb = cfg.cloud.web || location.origin + '/';
    }
  } catch {
    ui.renderLobbyServer('无法读取服务器配置（可继续尝试进入房间）');
  }

  if (state.cloudHosted) applyCloudHostedLobby();
  applyCodecPreference();
  refreshIceServers();   // 提前拿 ICE/TURN 配置，避免入房后第一帧连接缺服务器
  if (!state.cloudHosted) ui.renderLobbyServer(`当前服务器：${location.origin} · v${state.version}`);
  ui.renderEnvInfo(state.env);
  ui.showScreen('lobby');
  renderLobbyCaps();

  if (urlParam('recover') === '1' && isElectron) {
    const banner = $('#lobby-recover-banner');
    banner.textContent = '⚠️ 上次连接的服务器不可用，已返回本机设置页。可在「设置 → 服务器」中修改地址。';
    banner.hidden = false;
  }
  const nick = urlParam('nick');
  if (nick) $('#input-username').value = nick;
  const cloudCode = (urlParam('cloud') || '').trim().toUpperCase();
  if (cloudCode) {
    $('#mode-cloud').checked = true;
    $('#input-cloud-code').value = cloudCode;
    syncLobbyMode();
  }
  if (urlParam('autojoin') === '1' && nick) {
    setTimeout(() => enterRoom(), 150);
  }
  bootDone();
}

/** 隐藏启动加载动画（boot 成功/失败都会调用；另有 8s 兜底） */
function bootDone() {
  const el = document.getElementById('boot-loader');
  if (!el || el.classList.contains('hide')) return;
  el.classList.add('hide');
  setTimeout(() => { try { el.remove(); } catch { /* 忽略 */ } }, 450);
}
setTimeout(bootDone, 8000);   // 兜底：极端情况下也不让加载动画永久遮挡

function loadSettings() {
  const saved = storage.get('settings', {});
  state.settings = { ...state.settings, ...(saved || {}) };
  state.preset = storage.get('preset', 'auto');
  state.linkMode = state.settings.linkMode === 'cinema' ? 'cinema' : 'webrtc';
}

function applyCodecPreference() {
  window.__gsCodecOrder = preferredWebRtcOrder(state.settings.codecPreference);
}

function renderLobbyCaps() {
  const node = $('#lobby-caps');
  const env = state.env;
  if (!env.capture) {
    node.textContent = env.blockReason || '当前环境无法共享屏幕，但可以观看。';
    return;
  }
  const codec = webrtcPreferredCodec(state.settings.codecPreference);
  node.textContent = `✅ 可以共享屏幕 · 首选编码 ${codec.label}${state.features.cinema && env.webcodecs.encode ? ' · 支持影院模式' : ''}`;
}

/** 云信令服务托管的网页版：只保留「云房间」入口（本机开服/加入朋友在公网页面上不可用） */
function applyCloudHostedLobby() {
  $('#mode-host')?.closest('label')?.setAttribute('hidden', '');
  $('#mode-guest')?.closest('label')?.setAttribute('hidden', '');
  const cloud = $('#mode-cloud');
  if (cloud) cloud.checked = true;
  syncLobbyMode();
  $('#btn-network-lobby')?.setAttribute('hidden', '');
  $('#btn-network')?.setAttribute('hidden', '');
  document.querySelector('[data-action="open-network"]')?.setAttribute('hidden', '');
  try {
    ui.renderLobbyServer(`☁️ 云信令 · ${new URL(state.cloudWeb).host} · v${state.version}`);
  } catch {
    ui.renderLobbyServer('☁️ 云信令已就绪');
  }
}

function wireStaticUI() {
  // 进入页（三种模式：本机开房间 / 加入朋友 / ☁️ 云房间）
  const modeHost = $('#mode-host');
  const modeGuest = $('#mode-guest');
  const modeCloud = $('#mode-cloud');
  syncLobbyMode = () => {
    const cloud = !!modeCloud?.checked;
    const guest = !!modeGuest?.checked && !cloud;
    $('#port-field').hidden = cloud || guest || !isElectron;
    $('#address-field').hidden = cloud || !guest || !isElectron;
    $('#cloud-field').hidden = !cloud;
    const code = $('#input-cloud-code').value.trim();
    $('#btn-enter').textContent = cloud ? (code ? '加入云房间' : '创建云房间') : '进入房间';
    if (cloud) $('#input-cloud-code').focus();
  };
  [modeHost, modeGuest, modeCloud].forEach((r) => r?.addEventListener('change', syncLobbyMode));
  $('#input-cloud-code').addEventListener('input', syncLobbyMode);
  $('#input-cloud-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') enterRoom(); });
  $('#btn-enter').addEventListener('click', () => enterRoom());
  $('#input-username').addEventListener('keydown', (e) => { if (e.key === 'Enter') enterRoom(); });
  $('#input-address').addEventListener('keydown', (e) => { if (e.key === 'Enter') enterRoom(); });
  $('#input-port').addEventListener('keydown', (e) => { if (e.key === 'Enter') enterRoom(); });
  $('#btn-network-lobby').addEventListener('click', () => openNetworkModal());
  $('#btn-settings-lobby').addEventListener('click', openSettingsModal);
  $('#btn-about-lobby').addEventListener('click', openAboutModal);
  if (!isElectron) {
    // 浏览器版不能本机开服：隐藏「开房间」，保留「加入当前服务器 / ☁️ 云房间」
    modeHost.closest('label')?.setAttribute('hidden', '');
    modeGuest.checked = true;
  }
  syncLobbyMode();
  // 画质 / 链路下拉
  ui.initPresetOptions();
  state.preset = $('#preset-select').value;
  $('#link-mode').value = state.linkMode;

  // 房间
  $('#btn-share').addEventListener('click', toggleShare);
  $('#btn-fullscreen')?.addEventListener('click', () => state.stage?.fullscreenFocused());
  $('#preset-select').addEventListener('change', onPresetChange);
  $('#link-mode').addEventListener('change', () => {
    state.linkMode = $('#link-mode').value;
    state.settings.linkMode = state.linkMode;
    saveSettings();
    if (!state.local) toast(state.linkMode === 'cinema' ? '下次共享将使用影院模式（画质更稳）' : '下次共享将使用标准链路（延迟更低）');
  });
  // 音频源（桌面版：整机 / 跟随窗口 / 指定应用）
  $('#btn-audio-source')?.addEventListener('click', openAudioSourceModal);
  $('#share-audio')?.addEventListener('change', updateAudioSourceButton);
  $('#btn-audio-refresh')?.addEventListener('click', refreshAudioAppList);
  $('#btn-audio-ok')?.addEventListener('click', applyAudioSourceFromModal);
  $('#btn-audio-cancel')?.addEventListener('click', () => closeModal('#modal-audio-source'));
  updateAudioSourceButton();
  $('#btn-invite').addEventListener('click', openInviteModal);
  $('#btn-qr').addEventListener('click', openQrModal);
  $('#btn-network').addEventListener('click', () => openNetworkModal());
  $('#btn-stats-toggle').addEventListener('click', toggleStatsPanel);
  $('#btn-stats-close').addEventListener('click', () => toggleStatsPanel(false));
  $('#btn-leave').addEventListener('click', leaveRoom);
  ui.wireHelpDropdown({
    'check-update': checkUpdate,
    'open-network': () => openNetworkModal(),
    'open-settings': openSettingsModal,
    'open-about': openAboutModal,
    'quit-app': () => window.gvDesktop?.quit(),
  });

  // 设置 / 关于 / 邀请 等弹窗关闭
  $('#btn-settings-close').addEventListener('click', () => {
    state.settings = { ...state.settings, ...ui.readSettingsForm() };
    saveSettings();
    applyCodecPreference();
    state.stage?.setAspect(state.settings.aspect);
    closeModal('#modal-settings');
    renderLobbyCaps();
    refreshBudgetInfo();
  });
  $('#btn-about-close').addEventListener('click', () => closeModal('#modal-about'));
  $('#btn-invite-close').addEventListener('click', () => closeModal('#modal-invite'));
  $('#btn-network-close').addEventListener('click', () => closeModal('#modal-network'));
  $('#btn-qr-close').addEventListener('click', () => closeModal('#modal-qr'));
  $('#btn-update-cancel').addEventListener('click', () => closeModal('#modal-update'));
  $('#btn-network-advanced').addEventListener('click', () => {
    const box = $('#network-advanced');
    box.hidden = !box.hidden;
  });
  $('#btn-radmin-open').hidden = !isElectron;
  $('#btn-radmin-open').addEventListener('click', () => { closeModal('#modal-network'); openRadminModal(); });
  wireDesktopUI();
  wireModalBackdrops();

  // 舞台
  state.stage = new Stage({
    mainEl: $('#stage-main'),
    stripEl: $('#stage-strip'),
    onFocus: (id) => { state.focused = id; renderStage(); ui.renderMembers(state.members, state.meId, state.focused, focusMember); },
    onAction: (id, action) => {
      if (action === 'share') toggleShare();
      if (action === 'stats') { toggleStatsPanel(true); }
    },
    onFullscreenChange: (on) => {
      const btn = $('#btn-fullscreen');
      if (btn) {
        btn.textContent = on ? '⛶ 退出全屏' : '⛶ 全屏';
        btn.classList.toggle('active', on);
      }
    },
  });
  state.stage.setAspect(state.settings.aspect);

  // 移动端侧栏切换（按钮始终渲染，由 CSS 控制显示；避免窄窗口/平板下无法打开成员列表）
  const sidebar = $('#sidebar');
  $('#btn-members')?.addEventListener('click', (e) => {
    e.stopPropagation();
    sidebar.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (sidebar.classList.contains('open') && !sidebar.contains(e.target) && e.target.id !== 'btn-members') sidebar.classList.remove('open');
  });

  // 错误上报
  window.addEventListener('error', (e) => {
    state.socket?.reportError({ message: e.message, stack: e.error?.stack, url: location.href });
  });
  window.addEventListener('unhandledrejection', (e) => {
    state.socket?.reportError({ message: String(e.reason || 'Unknown rejection') });
  });
  window.addEventListener('online', () => ui.setConnStatus(true));
  window.addEventListener('offline', () => ui.setConnStatus(false, '● 离线'));
}

function wireModalBackdrops() {
  $$('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) closeModal(m); }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $$('.modal.open').forEach((m) => closeModal(m));
  });
}

function saveSettings() {
  storage.set('settings', state.settings);
  storage.set('preset', state.preset);
}

function focusMember(id) {
  state.focused = id || null;
  renderStage();
  ui.renderMembers(state.members, state.meId, state.focused, focusMember);
  if (isMobile) $('#sidebar').classList.remove('open');
}

// ═══════════ 进入房间 ═══════════
async function enterRoom() {
  ui.showLobbyError('');
  const username = $('#input-username').value.trim() || '观众';
  state.username = username;

  // ☁️ 云房间：走 Project4 云信令（房间码进出，免组网）
  if ($('#mode-cloud')?.checked) return enterCloudRoom(username);

  if (isElectron && window.gvDesktop?.setServerConfig && !urlParam('autojoin')) {
    const guest = $('#mode-guest').checked;
    const port = Number($('#input-port').value);
    const address = $('#input-address').value.trim();
    if (guest && !address) return ui.showLobbyError('请输入主机地址，例如 192.168.1.5:3000');
    if (!guest && (!port || port < 1024 || port > 65535)) return ui.showLobbyError('请输入有效端口（1024-65535）');
    const r = await window.gvDesktop.setServerConfig({
      mode: guest ? 'remote' : 'local',
      address,
      port,
      nickname: username,
      autoJoin: true,
    });
    if (r?.ok) toast('正在重启并进入房间…', { ms: 4000 });
    else ui.showLobbyError(r?.error || '设置保存失败');
    return;
  }

  if (!state.socket) {
    // Socket.IO 按需加载（从本机服务器 /vendor 路径）；云网页版与云房间模式完全不需要它
    const ioOk = await ensureSocketIo();
    if (!ioOk) return ui.showLobbyError('本机服务器组件加载失败：无法连接自托管服务器（云房间不需要本机服务器）');
    connect();
  }
  if (!state.socket.connected()) {
    const ok = await waitForConnect(6000);
    if (!ok) return ui.showLobbyError('无法连接服务器：请确认主机已在房间内、地址填写正确');
  }
  // 关键：先拿到 ICE/TURN 配置再进房（否则新入房时的第一帧连接会缺少中继服务器）
  if (!state.iceServers?.length) await refreshIceServers();
  if (state.joined) return;
  const btn = $('#btn-enter');
  btn.disabled = true;
  btn.textContent = '进入中…';
  state.meId = state.socket.id();
  const res = await state.socket.join(username);
  btn.disabled = false;
  btn.textContent = '进入房间';
  if (res?.error) return ui.showLobbyError(res.error);

  state.meId = state.socket.id();
  state.joined = true;
  state.members = res.roomState?.users || [];
  mergeChatHistory(res.roomState?.chat, state.meId);   // 进房时带上最近聊天记录
  for (const m of state.members) if (m.share) state.shares.set(m.id, m.share);
  ui.renderRoomInfo({ version: state.version, mode: isElectron ? (await desktopMode()) : 'browser' });
  ui.setConnStatus(true);
  ui.showScreen('room');
  setUrlParams({ autojoin: null, nick: null, recover: null });
  ui.renderMembers(state.members, state.meId, state.focused, focusMember);
  state.stats.start();
  refreshBudgetInfo();
  renderStage();
  toast('已进入房间：把「邀请」里的地址发给好友即可一起看', { ms: 5000 });
  refreshIceServers();   // 异步刷新 TURN 凭据，不阻塞入房
}

// 进入「☁️ 云房间」（Project4 云信令：房间码进出，跨网络免组网）
async function enterCloudRoom(username) {
  const code = $('#input-cloud-code').value.trim().toUpperCase();
  const kind = code ? 'join' : 'create';
  const btn = $('#btn-enter');
  btn.disabled = true;
  btn.textContent = kind === 'create' ? '创建云房间中…' : '加入云房间中…';
  try {
    connectCloud();
    const res = kind === 'create'
      ? await state.socket.createRoom(username)
      : await state.socket.joinRoom(username, code);
    if (res?.error) return ui.showLobbyError(res.error);

    state.cloudCode = (res.code || code).toUpperCase();
    state.meId = state.socket.id();
    state.joined = true;
    state.members = res.roomState?.users || [];
    mergeChatHistory(res.roomState?.chat, state.meId);   // 云房间：进房时带上最近聊天记录
    for (const m of state.members) if (m.share) state.shares.set(m.id, m.share);
    ui.renderRoomInfo({ version: state.version, mode: 'cloud', code: state.cloudCode });
    ui.setConnStatus(true);
    ui.showScreen('room');
    setUrlParams({ autojoin: null, nick: null, recover: null });
    ui.renderMembers(state.members, state.meId, state.focused, focusMember);
    refreshIceServers();   // 页面由本机服务器提供时自动带上 TURN 凭据；静态托管时降级为 STUN
    state.stats?.start();
    refreshBudgetInfo();
    renderStage();
    const invite = cloudInviteUrl(state.cloudCode);
    if (kind === 'create') copyText(invite, `☁️ 云房间已创建 · 房间码 ${state.cloudCode}（邀请链接已复制）`);
    else toast(`已加入云房间 ${state.cloudCode}`);
  } catch (err) {
    ui.showLobbyError('云房间连接失败：' + (err?.message || err));
  } finally {
    btn.disabled = false;
    syncLobbyMode();
  }
}

/** 刷新 ICE 配置（含 TURN 临时凭据）。TURN 尚未就绪时会自动稍后重试。 */
async function refreshIceServers({ force = false } = {}) {
  if (state.cloudHosted) {
    // 云网页版：/api/ice 由云信令服务提供（当前阶段仅 STUN），直接用 /api/config 的 STUN
    if (!state.iceServers?.length) {
      state.iceServers = (state.stunServers || []).map((s) => ({ urls: /^stun:/i.test(s) ? s : `stun:${s}` }));
      state.iceAt = Date.now();
      state.mesh?.setIceServers(state.iceServers);
    }
    return;
  }
  const fresh = state.iceAt && Date.now() - state.iceAt < 30 * 60 * 1000;
  if (!force && state.iceServers?.length && fresh && state.iceTurnReady !== false) return;
  try {
    const ice = await fetchIce(state.username);
    const prev = JSON.stringify(state.iceServers || []);
    state.iceServers = ice.iceServers || [];
    state.iceAt = Date.now();
    state.iceTurnReady = ice.turn ? (ice.turn.ready || !ice.turn.enabled) : true;
    if (JSON.stringify(state.iceServers) !== prev) state.mesh?.setIceServers(state.iceServers);
    // 服务端中继还在启动中 → 稍后重试（最多 3 次）
    if (!state.iceTurnReady) {
      clearTimeout(state.iceRetryTimer);
      state.iceRetries = (state.iceRetries || 0) + 1;
      if (state.iceRetries <= 3) {
        state.iceRetryTimer = setTimeout(() => refreshIceServers({ force: true }), 6000);
      }
    }
  } catch {
    if (!state.iceServers?.length) {
      state.iceServers = (state.stunServers || []).map((s) => ({ urls: /^stun:/i.test(s) ? s : `stun:${s}` }));
      state.iceAt = Date.now();
      state.mesh?.setIceServers(state.iceServers);
    }
  }
}

async function desktopMode() {
  try { return (await window.gvDesktop?.getServerConfig?.())?.mode || 'local'; } catch { return 'local'; }
}

function waitForConnect(timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (state.socket?.connected()) return resolve(true);
      if (Date.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(tick, 200);
    };
    tick();
  });
}

// ═══════════ 信令连接（本机服务器 / ☁️ 云信令）═══════════
function setupTransport(socket) {
  state.socket = socket;

  state.mesh = new MeshManager({
    socket: state.socket,
    getIceServers: () => state.iceServers || [],
    myId: () => state.socket?.id(),
    onRemoteStream: (peerId, stream, channel) => onRemoteStream(peerId, stream, channel),
    onPeerState: (peerId, st, channel) => onPeerState(peerId, st, channel),
  });

  state.stats = new StatsHub({
    mesh: state.mesh,
    getPresetKey: () => (state.local ? state.preset : 'auto'),
    getBudgetBps: () => (state.settings.uplinkMbps > 0 ? state.settings.uplinkMbps * 1_000_000 : Number.MAX_SAFE_INTEGER),
    onSample: (samples) => onStatsSample(samples),
  });
}

/** 按需加载 Socket.IO 客户端（本机服务器提供 /vendor/socket.io/socket.io.js），失败返回 false */
function ensureSocketIo() {
  if (window.io) return Promise.resolve(true);
  if (!window.__gsIoLoading) {
    window.__gsIoLoading = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = '/vendor/socket.io/socket.io.js';
      s.onload = () => resolve(!!window.io);
      s.onerror = () => { window.__gsIoLoading = null; resolve(false); };
      document.head.appendChild(s);
    });
  }
  return window.__gsIoLoading;
}

function connect() {
  setupTransport(connectSignaling({
    onConnect: () => {
      ui.setConnStatus(true);
      // 断线重连后自动恢复房间
      if (state.joined && !state.members.some((m) => m.id === state.socket.id())) {
        state.joined = false;
        enterRoom();
      }
    },
    onDisconnect: () => ui.setConnStatus(false, '● 重连中…'),
    onConnectError: () => ui.setConnStatus(false, '● 连接失败'),
    onRoomState: (s) => applyRoomState(s),
    onMemberJoined: (user) => onMemberJoined(user),
    onMemberLeft: (id) => onMemberLeft(id),
    onShareUpdate: (id, share) => onShareUpdate(id, share),
    onSignal: (from, data) => state.mesh?.handleSignal(from, data),
    onChatMessage: (m) => addChatMessage(m, state.meId),
    onCinemaMeta: (id, meta) => onCinemaMeta(id, meta),
    onCinemaChunk: (id, batch) => onCinemaChunk(id, batch),
    onCinemaFeedback: (id, stats) => onCinemaFeedback(id, stats),
    onCinemaKeyframeRequest: () => state.local?.cinema?.requestKeyframe(),
  }));
}

// ─────────── ☁️ 云房间（Project4 云信令）───────────
/** 云信令地址：?relay= 参数优先（自建/本地调试），默认线上服务 */
function getRelayUrl() {
  const q = urlParam('relay');
  if (q) return q;
  if (state.settings.relay) return state.settings.relay;
  return 'wss://gracs.ginyva.site/ws';
}

/** 云房间邀请链接的网页版地址：?web= > /api/config cloud.web > 云信令同域（自建）> 官方云网页版 */
function cloudWebBase() {
  const q = urlParam('web');
  if (q) return q.replace(/\/+$/, '') + '/';
  if (state.cloudWeb) return state.cloudWeb.replace(/\/+$/, '') + '/';
  try {
    const host = new URL(getRelayUrl()).host;
    if (host && !/^gracs\.ginyva\.site$/i.test(host)) return 'https://' + host + '/';
  } catch { /* 相对地址：忽略 */ }
  return 'https://gracs.ginyva.site/';
}

function cloudInviteUrl(code) {
  return cloudWebBase() + '?cloud=' + encodeURIComponent(code);
}

function connectCloud() {
  if (state.socket?.isCloud) return;
  setupTransport(connectCloudSignaling({
    getUrl: getRelayUrl,
    onConnect: () => ui.setConnStatus(true),
    onDisconnect: () => ui.setConnStatus(false, '● 云信令重连中…'),
    onConnectError: () => ui.setConnStatus(false, '● 云信令连接失败'),
    onRoomState: (s) => applyRoomState(s),
    onMemberJoined: (user) => onMemberJoined(user),
    onMemberLeft: (id) => onMemberLeft(id),
    onShareUpdate: (id, share) => onShareUpdate(id, share),
    onSignal: (from, data) => state.mesh?.handleSignal(from, data),
    onChatMessage: (m) => addChatMessage(m, state.meId),
    onError: (msg) => {
      toast(msg || '云信令连接异常', { kind: 'error', ms: 6000 });
      ui.setConnStatus(false, '● 云信令断开');
    },
  }));
}

function applyRoomState(s) {
  const prevShares = new Map(state.shares);
  state.members = s.users || [];
  mergeChatHistory(s.chat, state.meId);   // 云端/本地房间状态里可能带最近聊天记录
  state.shares.clear();
  for (const m of state.members) if (m.share) state.shares.set(m.id, m.share);
  // 清理已停止共享的画面
  for (const [peerId, share] of prevShares) {
    if (!state.shares.has(peerId) && peerId !== state.meId) cleanupRemote(peerId, '对方已停止共享');
  }
  // 影院模式元数据补全（后来者可用）
  for (const m of state.members) {
    if (m.share?.mode === 'cinema' && m.share.cinema && m.id !== state.meId) {
      const remote = ensureRemote(m.id);
      if (remote.cinema?.receiver) remote.cinema.receiver.setMeta(m.share.cinema).catch(() => {});
    }
  }
  ui.renderMembers(state.members, state.meId, state.focused, focusMember);
  if (!state.shares.size && !state.local) state.focused = null;
  renderStage();
}

function onMemberJoined(user) {
  if (!state.members.some((m) => m.id === user.id)) state.members.push(user);
  ui.renderMembers(state.members, state.meId, state.focused, focusMember);
  state.mesh?.peerJoined(user);   // 我正在共享 → 向新成员发起连接
}

function onMemberLeft(id) {
  state.members = state.members.filter((m) => m.id !== id);
  state.shares.delete(id);
  cleanupRemote(id);
  state.mesh?.closeIncoming(id);
  ui.renderMembers(state.members, state.meId, state.focused, focusMember);
  renderStage();
}

function onShareUpdate(id, share) {
  const m = state.members.find((x) => x.id === id);
  if (m) m.share = share;
  if (share) state.shares.set(id, share); else state.shares.delete(id);
  ui.renderMembers(state.members, state.meId, state.focused, focusMember);
  if (!share) {
    cleanupRemote(id, '对方已停止共享');
    state.mesh?.closeIncoming(id);
  } else if (share.mode === 'cinema' && share.cinema) {
    const remote = ensureRemote(id);
    remote.cinema?.receiver?.setMeta(share.cinema).catch(() => {});
  }
  renderStage();
}

function onRemoteStream(peerId, stream, channel) {
  const remote = ensureRemote(peerId);
  const hasVideo = stream.getVideoTracks().length > 0;
  if (channel === 'cinema-audio' || !hasVideo) {
    // 影院模式的系统声音（仅音频）
    attachRemoteAudio(peerId, stream);
    renderStage();
    return;
  }
  remote.stream = stream;
  renderStage();
}

function ensureRemote(peerId) {
  let remote = state.remotes.get(peerId);
  if (!remote) {
    remote = { username: state.members.find((m) => m.id === peerId)?.username || '好友', stream: null, audioEl: null, cinema: null };
    state.remotes.set(peerId, remote);
  }
  return remote;
}

function attachRemoteAudio(peerId, stream) {
  const remote = ensureRemote(peerId);
  if (!remote.audioEl) {
    remote.audioEl = new Audio();
    remote.audioEl.autoplay = true;
  }
  if (remote.audioEl.srcObject !== stream) {
    remote.audioEl.srcObject = stream;
    remote.audioEl.play?.().catch(() => { /* 点击后恢复 */ });
  }
}

function cleanupRemote(peerId, reason) {
  const remote = state.remotes.get(peerId);
  if (!remote) return;
  const hadStream = !!remote.stream || !!remote.cinema;
  if (remote.stream) remote.stream = null;
  if (remote.audioEl) { try { remote.audioEl.srcObject = null; } catch { /* 忽略 */ } }
  if (remote.cinema) {
    try { remote.cinema.receiver?.destroy(); } catch { /* 忽略 */ }
    remote.cinema = null;
  }
  state.remotes.delete(peerId);
  if (state.focused === peerId) state.focused = null;
  if (reason && hadStream) toast(`${remote.username}：${reason}`);
}

function onPeerState(peerId, st, channel) {
  if (channel === 'cinema-audio') return;
  if ((st === 'failed' || st === 'closed') && state.remotes.has(peerId)) {
    const remote = state.remotes.get(peerId);
    toast(`与「${remote.username}」的画面连接中断，正在尝试恢复…`, { ms: 4000 });
  }
}

// ═══════════ 影院模式（接收端）═══════════
function onCinemaMeta(id, meta) {
  const remote = ensureRemote(id);
  ensureCinemaReceiver(id, remote);
  remote.cinema.receiver.setMeta(meta).catch(() => {});
  state.socket?.cinemaWatch(id);
  state.socket?.cinemaKeyframe();
}

function onCinemaChunk(id, batch) {
  const remote = ensureRemote(id);
  if (!remote.cinema) ensureCinemaReceiver(id, remote);
  remote.cinema.receiver.pushBatch(batch);
}

function ensureCinemaReceiver(id, remote) {
  if (remote.cinema) return remote.cinema;
  const canvas = document.createElement('canvas');
  const receiver = new CinemaReceiver({
    canvas,
    onNeedKeyframe: () => state.socket?.cinemaKeyframe(),
    onStats: (stats) => {
      if (stats.error) { toast(stats.error, { ms: 6000, kind: 'error' }); return; }
      remote.cinema = { ...remote.cinema, stats };
      updateTileBadge(id);
    },
  });
  remote.cinema = { canvas, receiver, stats: null };
  const share = state.shares.get(id);
  if (share?.cinema) receiver.setMeta(share.cinema).catch(() => {});
  state.socket?.cinemaWatch(id);
  state.socket?.cinemaKeyframe();
  if (!remote.cinemaNoticeShown) {
    remote.cinemaNoticeShown = true;
    toast(`${remote.username} 正在共享（影院模式）`, { ms: 3000 });
  }
  renderStage();
  return remote.cinema;
}

function onCinemaFeedback(id, stats) {
  state.local?.cinema?.onFeedback?.(stats);
}

// ═══════════ 共享（发送端）═══════════

// ── 音频源（桌面版：整机声音 / 跟随共享窗口 / 指定应用）──
let pendingAppName = null;   // 音频源弹窗里选中的应用名（未点确定前暂存）

function currentAudioSource() {
  const s = state.settings.audioSource;
  return s && s.mode ? s : { mode: 'system' };
}

function audioSourceLabel(src) {
  const s = src || currentAudioSource();
  if (s.mode === 'app') return s.name ? `🎯 ${s.name}` : '🎯 指定应用';
  if (s.mode === 'follow') return '🪟 跟随窗口';
  return '🔊 整机声音';
}

function updateAudioSourceButton() {
  const btn = $('#btn-audio-source');
  if (!btn) return;
  const desktop = !!window.gvDesktop?.startSystemAudio;
  const withAudio = !!$('#share-audio')?.checked;
  btn.hidden = !desktop;   // 浏览器版无法按应用采声
  if (!desktop) return;
  btn.disabled = !withAudio;
  btn.textContent = withAudio ? audioSourceLabel() : '🔇 未勾选声音';
  btn.title = '选择共享的音频来源：整机声音 / 跟随共享窗口 / 指定应用（只播该应用，不影响语音软件）';
}

async function refreshAudioAppList() {
  const box = $('#audio-app-list');
  if (!box) return;
  if (!window.gvDesktop?.listAudioSessions) {
    box.innerHTML = '<p class="dim audio-app-empty">按应用采集仅桌面版支持</p>';
    return;
  }
  box.innerHTML = '<p class="dim audio-app-empty">读取中…</p>';
  let res = null;
  try { res = await window.gvDesktop.listAudioSessions(); } catch { /* 忽略 */ }
  if (!res?.ok) {
    box.innerHTML = `<p class="dim audio-app-empty">读取失败：${res?.error || '未知错误'}</p>`;
    return;
  }
  const sessions = (res.sessions || []).filter((s) => s.pid > 0);
  if (!sessions.length) {
    box.innerHTML = '<p class="dim audio-app-empty">当前没有正在发声的应用（先让应用播放声音，再点「刷新」）</p>';
    return;
  }
  const cur = currentAudioSource();
  box.innerHTML = '';
  for (const s of sessions) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'audio-app-row' + (cur.mode === 'app' && cur.name === s.name ? ' active' : '');
    row.textContent = s.name + (s.muted ? '（已静音）' : '');
    row.dataset.name = s.name;
    row.addEventListener('click', () => {
      pendingAppName = s.name;
      const radio = document.querySelector('input[name="audio-source-mode"][value="app"]');
      if (radio) radio.checked = true;
      for (const el of box.querySelectorAll('.audio-app-row')) el.classList.toggle('active', el === row);
    });
    box.append(row);
  }
}

async function openAudioSourceModal() {
  const modal = $('#modal-audio-source');
  if (!modal) return;
  const cur = currentAudioSource();
  pendingAppName = cur.mode === 'app' ? (cur.name || null) : null;
  const radio = document.querySelector(`input[name="audio-source-mode"][value="${cur.mode === 'app' ? 'app' : cur.mode}"]`);
  if (radio) radio.checked = true;
  openModal('#modal-audio-source');
  await refreshAudioAppList();
}

function applyAudioSourceFromModal() {
  const checked = document.querySelector('input[name="audio-source-mode"]:checked');
  const mode = checked?.value === 'app' ? 'app' : checked?.value === 'follow' ? 'follow' : 'system';
  if (mode === 'app') {
    if (!pendingAppName) {
      return toast('请先在下方列表里选择一个应用（需正在发声）', { kind: 'error', ms: 5000 });
    }
    state.settings.audioSource = { mode: 'app', name: pendingAppName };
  } else {
    state.settings.audioSource = { mode };
  }
  saveSettings();
  updateAudioSourceButton();
  closeModal('#modal-audio-source');
}

/** 共享前解析音频源：app 模式把「应用名」解析为当前 PID（应用可能重启过） */
async function resolveAudioSource() {
  const src = currentAudioSource();
  if (src.mode !== 'app') return src;
  if (!window.gvDesktop?.listAudioSessions) return { mode: 'system' };
  try {
    const res = await window.gvDesktop.listAudioSessions();
    const hit = res?.ok ? (res.sessions || []).find((s) => s.name === src.name && s.pid > 0) : null;
    if (hit) return { mode: 'app', name: src.name, pid: hit.pid };
    toast(`「${src.name}」当前没有在发声，已改用整机声音`, { kind: 'error', ms: 6000 });
  } catch { /* 忽略 */ }
  return { mode: 'system' };
}

async function toggleShare() {
  if (state.local) return stopShare();
  if (state.sharePending) return;
  if (!canCaptureScreen()) return toast(captureBlockReason() || '当前环境不支持共享屏幕', { ms: 6000, kind: 'error' });
  if (state.iceTurnReady === false) await refreshIceServers({ force: true });

  state.sharePending = true;
  ui.shareControlState({ pending: true, sharing: false });
  state.sharePendingTimer = setTimeout(() => {
    state.sharePending = false;
    ui.shareControlState({ pending: false, sharing: false });
    window.gvDesktop?.cancelDisplaySource?.();
    toast('等待选择超时，已取消（请重试）');
  }, 60_000);

  const withAudio = $('#share-audio').checked;
  const audioSource = withAudio ? await resolveAudioSource() : null;
  let captured;
  try {
    captured = await startScreenShare({ presetKey: state.preset, withAudio, audioSource });
  } catch (err) {
    state.sharePending = false;
    clearTimeout(state.sharePendingTimer);
    ui.shareControlState({ pending: false, sharing: false });
    if (err?.name === 'NotAllowedError' || /cancel|abort/i.test(String(err?.message || ''))) toast('已取消共享');
    else { console.error(err); toast('共享失败：' + (err?.message || err), { kind: 'error' }); }
    return;
  }
  state.sharePending = false;
  clearTimeout(state.sharePendingTimer);
  if (!captured.stream?.getVideoTracks().length) {
    ui.shareControlState({ pending: false, sharing: false });
    return;
  }
  await startShareFlow(captured.stream, captured.meta);
}

/** 把一条采集流接入共享链路（标准 / 影院），并同步共享状态到服务器 */
async function startShareFlow(stream, meta, modeOverride = null) {
  stream.addEventListener('userstopped', () => stopShare('已在系统里停止共享'));
  const preset = getPreset(state.preset);
  const wantedMode = modeOverride || state.linkMode;
  const cloudNoCinema = !!state.socket?.isCloud && wantedMode === 'cinema';
  if (cloudNoCinema) toast('云房间暂不支持影院模式，已自动改用标准链路', { ms: 6000 });
  let cinemaPick = null;
  if (wantedMode === 'cinema' && !cloudNoCinema) {
    const { pickVideoEncoderConfig } = await import('./capabilities.js');
    cinemaPick = await pickVideoEncoderConfig({
      width: meta.width || 1920,
      height: meta.height || 1080,
      fps: preset.fps,
      bitrate: preset.bitrate,
      preference: state.settings.codecPreference,
    });
    if (!cinemaPick) toast('影院模式不可用（浏览器不支持 WebCodecs），已自动改用标准链路', { ms: 6000, kind: 'error' });
  }

  state.local = { stream, mode: cinemaPick ? 'cinema' : 'webrtc', preset: state.preset, meta, cinema: null };
  state.focused = 'local';

  try {
    if (state.local.mode === 'cinema') {
      const sender = new CinemaSender({ stream, socket: state.socket, codecPreference: state.settings.codecPreference });
      const res = await sender.start({ width: meta.width || 1920, height: meta.height || 1080, fps: preset.fps, bitrate: preset.bitrate });
      if (!res.ok) {
        toast(res.error || '影院模式启动失败，已改用标准链路', { ms: 6000, kind: 'error' });
        state.local.mode = 'webrtc';
      } else {
        state.local.cinema = sender;
        const cinemaMeta = { codec: res.codec, codedWidth: res.width, codedHeight: res.height, description: null, hw: res.hw };
        sender.sendInitialMeta(cinemaMeta);
        state.mesh.startCinemaAudio(stream, state.members);
        state.socket.cinemaMeta(cinemaMeta);
        meta.width = res.width;
        meta.height = res.height;
        toast(`影院模式已启动（${res.label}${res.hw ? ' · 硬件编码' : ''}）`, { kind: 'ok' });
      }
    }
    if (state.local.mode === 'webrtc') {
      state.mesh.startSharing(stream, state.members, { preset });
    }
    await state.socket.setShare({
      mode: state.local.mode,
      preset: state.preset,
      title: meta.title,
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      bitrate: preset.bitrate,
      audio: meta.hasAudio,
      since: Date.now(),
    });
    ui.shareControlState({ sharing: true, mode: state.local.mode, preset: state.preset, statusText: shareStatusText() });
    renderStage();
    // 声音状态提示（拿不到时给出可操作原因，而不是静默无声）
    if (meta.audioNote) {
      toast(meta.audioNote, { ms: 12_000, kind: 'error' });
    } else if (!meta.hasAudio && $('#share-audio')?.checked) {
      toast('本次共享没有声音：系统未提供音轨（可尝试「整个屏幕」+ 勾选共享音频）', { ms: 9000, kind: 'error' });
    } else if (meta.hasAudio) {
      toast('共享已开始（含系统声音），观看端可听到；本机预览静音属正常', { kind: 'ok', ms: 5000 });
    } else {
      toast('共享已开始（仅画面）', { kind: 'ok' });
    }
  } catch (err) {
    console.error(err);
    toast('共享启动失败：' + (err?.message || err), { kind: 'error' });
    stopShare(null, { silent: true });
  }
}

function shareStatusText() {
  if (!state.local) return '';
  const presetLabel = PRESETS[state.local.preset]?.label || '';
  const modeLabel = state.local.mode === 'cinema' ? '影院模式' : '标准链路';
  const size = state.local.meta.width && state.local.meta.height ? `${state.local.meta.width}×${state.local.meta.height}` : '';
  const audio = state.local.meta.hasAudio
    ? ` · 🔊 ${state.local.meta.audioSourceLabel || '系统声音'}`
    : ' · 🔇 无系统声音';
  return `正在共享 · ${modeLabel} · ${presetLabel}${size ? ' · ' + size : ''}${audio}`;
}

async function stopShare(reason, { silent = false } = {}) {
  if (!state.local) return;
  const local = state.local;
  state.local = null;
  try { await local.cinema?.stop?.(); } catch { /* 忽略 */ }
  try { local.stream?._helperStop?.(); } catch { /* 兼容模式系统声音清理 */ }
  state.mesh?.stopSharing();
  state.mesh?.stopCinemaAudio();
  window.gvDesktop?.restoreWindowAudio?.();
  try { await state.socket?.setShare(null); } catch { /* 忽略 */ }
  if (state.focused === 'local') state.focused = null;
  ui.shareControlState({ sharing: false, statusText: '' });
  renderStage();
  refreshBudgetInfo();
  if (!silent) toast(reason || '已停止共享');
}

async function onPresetChange() {
  state.preset = $('#preset-select').value;
  storage.set('preset', state.preset);
  if (!state.local) return;
  const preset = getPreset(state.preset);
  const local = state.local;
  local.preset = state.preset;
  if (local.mode === 'webrtc') {
    await applyPresetToStream(local.stream, state.preset);
    await state.mesh.applyPresetToAll(preset);
    await state.socket.setShare({
      mode: 'webrtc', preset: state.preset, title: local.meta.title,
      width: local.meta.width, height: local.meta.height, fps: local.meta.fps, bitrate: preset.bitrate,
      audio: local.meta.hasAudio, since: Date.now(),
    });
  } else {
    // 影院模式：重建编码器（分辨率/帧率变化需要重新配置）
    toast('影院模式切换画质中…');
    const sender = local.cinema;
    await sender?.stop();
    const { pickVideoEncoderConfig } = await import('./capabilities.js');
    const pick = await pickVideoEncoderConfig({
      width: local.meta.width || 1920, height: local.meta.height || 1080, fps: preset.fps, bitrate: preset.bitrate, preference: state.settings.codecPreference,
    });
    if (pick) {
      const next = new CinemaSender({ stream: local.stream, socket: state.socket, codecPreference: state.settings.codecPreference });
      const res = await next.start({ width: local.meta.width || 1920, height: local.meta.height || 1080, fps: preset.fps, bitrate: preset.bitrate });
      if (res.ok) {
        local.cinema = next;
        next.sendInitialMeta({ codec: res.codec, codedWidth: res.width, codedHeight: res.height, description: null, hw: res.hw });
        state.socket.cinemaMeta({ codec: res.codec, codedWidth: res.width, codedHeight: res.height, description: null, hw: res.hw });
      }
    }
  }
  ui.shareControlState({ sharing: true, mode: local.mode, preset: state.preset, statusText: shareStatusText() });
}

// ═══════════ 舞台渲染 ═══════════
function renderStage() {
  const views = [];
  if (state.local) {
    views.push({
      id: 'local',
      kind: 'video',
      stream: state.local.stream,
      title: `我（${state.username}）· ${state.local.mode === 'cinema' ? '影院模式' : '标准链路'}`,
      badge: { text: `${PRESETS[state.local.preset]?.label || ''}`, level: 'good' },
      isLocal: true,
    });
  }
  for (const [id, remote] of state.remotes) {
    const share = state.shares.get(id);
    const user = state.members.find((m) => m.id === id)?.username || remote.username;
    if (remote.cinema) {
      views.push({
        id,
        kind: 'canvas',
        canvas: remote.cinema.canvas,
        audioEl: remote.audioEl,
        title: `${user} 的屏幕（影院模式）`,
        badge: badgeFor(id, remote.cinema.stats),
      });
    } else if (remote.stream) {
      views.push({
        id,
        kind: 'video',
        stream: remote.stream,
        title: `${user} 的屏幕`,
        badge: badgeFor(id, state.stats?.samples?.in?.get(id)),
      });
    } else if (share) {
      views.push({
        id,
        kind: 'empty',
        title: `${user} 正在共享…`,
        badge: { text: '连接中', level: 'fair' },
      });
    }
  }
  state.stage.render(views, state.focused);
}

function badgeFor(id, stats) {
  if (!stats) {
    const share = state.shares.get(id);
    const settings = state.remotes.get(id)?.stream?.getVideoTracks?.()[0]?.getSettings?.();
    const size = settings?.width && settings?.height ? `${settings.width}×${settings.height} · ` : '';
    return { text: size + (share ? (share.mode === 'cinema' ? '影院模式 · 连接中' : '连接中') : '连接中'), level: 'fair' };
  }
  const parts = [];
  if (stats.width && stats.height) parts.push(`${stats.height}p`);
  if (stats.fps) parts.push(`${stats.fps}fps`);
  if (stats.bitrate) parts.push(fmtBitrate(stats.bitrate));
  parts.push(stats.relay ? '中继' : '直连');
  return { text: parts.join(' · '), level: stats.level || 'fair' };
}

function updateTileBadge(id) {
  const remote = state.remotes.get(id);
  if (!remote) return;
  state.stage.setBadge(id, badgeFor(id, remote.cinema?.stats || state.stats?.samples?.in?.get(id)));
}

function onStatsSample(samples) {
  state.statsSamples = samples;
  state.mesh?.reviveStale?.();   // 失败连接自动重建（带冷却）
  let totalOut = 0;
  if (state.local) {
    if (state.local.mode === 'webrtc') {
      for (const [id, s] of samples.out) {
        if (!s) continue;
        totalOut += s.bitrate || 0;
        updateTileBadge(id);
      }
    }
  }
  for (const [id] of samples.in) updateTileBadge(id);
  if (state.local) refreshBudgetInfo(totalOut);
  if (state.statsOpen) {
    const cinema = state.local?.cinema?.stats;
    renderStats(samples, {
      names: names(),
      sharing: !!state.local,
      cinema: [...state.remotes.entries()]
        .filter(([, r]) => r.cinema?.stats)
        .map(([id, r]) => ({ id, name: names().get(id) || r.username, stats: r.cinema.stats, audio: samples.out.get(id) || samples.in.get(id) || null })),
      encoder: state.local ? {
        mode: state.local.mode,
        codec: state.local.cinema?.codecInfo?.label || webrtcPreferredCodec(state.settings.codecPreference).label,
        hw: state.local.cinema?.codecInfo?.hw,
        kbps: cinema?.kbps || 0,
        fps: cinema?.fps || 0,
        targetKbps: state.local.cinema ? Math.round((state.local.cinema.bitrate || 0) / 1000) : null,
        dropped: cinema?.dropped,
      } : null,
    });
  }
}

function refreshBudgetInfo(totalOut = null) {
  if (!state.local) {
    ui.setUplinkInfo('');
    return;
  }
  if (state.local.mode === 'cinema') {
    ui.setUplinkInfo(`影院模式 · 目标 ${Math.round((state.local.cinema?.bitrate || 0) / 1000)} kbps · 观看者 ${Math.max(0, state.members.length - 1)} 人`);
    return;
  }
  const budget = state.settings.uplinkMbps > 0 ? state.settings.uplinkMbps + ' Mbps' : '不限';
  const viewers = Math.max(0, state.members.length - 1);
  ui.setUplinkInfo(`上行预算 ${budget} · 观看者 ${viewers} 人${totalOut ? ' · 当前 ' + fmtBitrate(totalOut) : ''}`);
}

function toggleStatsPanel(force) {
  state.statsOpen = force ?? !state.statsOpen;
  $('#stats-panel').hidden = !state.statsOpen;
  if (state.statsOpen && state.statsSamples) {
    const cinemaStats = state.local?.cinema?.stats;
    renderStats(state.statsSamples, {
      names: names(),
      sharing: !!state.local,
      cinema: [...state.remotes.entries()]
        .filter(([, r]) => r.cinema?.stats)
        .map(([id, r]) => ({ id, name: names().get(id) || r.username, stats: r.cinema.stats, audio: state.statsSamples.out.get(id) || state.statsSamples.in.get(id) || null })),
      encoder: state.local ? {
        mode: state.local.mode,
        codec: state.local.cinema?.codecInfo?.label || '—',
        hw: state.local.cinema?.codecInfo?.hw,
        kbps: cinemaStats?.kbps || 0,
        fps: cinemaStats?.fps || 0,
        targetKbps: state.local.cinema ? Math.round((state.local.cinema.bitrate || 0) / 1000) : null,
      } : null,
    });
  }
}

// ═══════════ 邀请 / 二维码 ═══════════
async function inviteUrls() {
  const list = [];
  try {
    const report = await fetchNetworkReport();
    const addrs = report.addresses || {};
    for (const url of addrs.lan || []) list.push({ url, label: '局域网' });
    for (const url of addrs.ipv6 || []) list.push({ url, label: 'IPv6' });
    if (report.gateway?.publicUrl) list.push({ url: report.gateway.publicUrl, label: '公网' });
    if (addrs.https?.lan?.length) list.push({ url: addrs.https.lan[0], label: 'HTTPS' });
  } catch { /* 忽略 */ }
  if (!list.length) list.push({ url: location.origin, label: '当前地址' });
  return list;
}

async function openInviteModal() {
  openModal('#modal-invite');
  if (state.socket?.isCloud && state.cloudCode) {
    const url = cloudInviteUrl(state.cloudCode);
    renderInvite({ urls: [{ url, label: `☁️ 云房间邀请（房间码 ${state.cloudCode}）` }], primary: url });
    return;
  }
  const urls = await inviteUrls();
  const primary = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? (urls.find((u) => u.label === '公网') || urls.find((u) => u.label === '局域网') || urls[0]).url
    : location.origin;
  renderInvite({ urls, primary });
}

async function openQrModal() {
  openModal('#modal-qr');
  if (state.socket?.isCloud && state.cloudCode) {
    renderQrModal(cloudInviteUrl(state.cloudCode));
    return;
  }
  const urls = await inviteUrls();
  const primary = urls.find((u) => u.label === '公网')?.url || urls[0]?.url || location.origin;
  renderQrModal(primary);
}

// ═══════════ 网络诊断 ═══════════
async function openNetworkModal() {
  openModal('#modal-network');
  await refreshNetwork(false);
}

async function refreshNetwork(deep) {
  const box = $('#network-verdict');
  box.innerHTML = '<div class="dim" style="padding:8px 0">正在检测网络…</div>';
  try {
    const report = await fetchNetworkReport({ deep });
    renderNetworkReport(report, { onDeep: () => refreshNetwork(true), onRefresh: () => refreshNetwork(false) });
  } catch (err) {
    renderNetworkReport({
      verdict: [{ level: 'bad', title: '诊断失败', detail: String(err?.message || err) + '（可点「重新检测」重试）' }],
      addresses: { lan: [location.origin] },
    }, { onRefresh: () => refreshNetwork(false) });
  }
}

// ═══════════ 设置 / 关于 / 更新 ═══════════
function openSettingsModal() {
  ui.loadSettingsIntoForm(state.settings);
  openModal('#modal-settings');
}

function openAboutModal() {
  $('#about-version').textContent = state.version;
  ui.renderEnvInfo(describeEnvironment());
  openModal('#modal-about');
}

async function checkUpdate() {
  openModal('#modal-update');
  $('#update-info').hidden = true;
  $('#btn-update-now').hidden = true;
  if (!window.gvDesktop?.checkUpdate) {
    $('#update-status').textContent = '浏览器版通过服务器地址访问即为最新版本';
    return;
  }
  $('#update-status').textContent = '检查更新中…';
  const r = await window.gvDesktop.checkUpdate();
  if (r?.ok) {
    if (!r.hasUpdate) { $('#update-status').textContent = `已是最新版本（v${r.current}）`; return; }
    $('#update-status').textContent = `发现新版本（${r.source}）`;
    $('#update-cur').textContent = `v${r.current}`;
    $('#update-new').textContent = `v${r.latest}`;
    $('#update-notes').textContent = r.notes || '';
    $('#update-info').hidden = false;
    $('#btn-update-now').hidden = false;
    $('#btn-update-now').onclick = async () => {
      $('#update-status').textContent = '正在下载并安装…';
      const res = await window.gvDesktop.applyUpdate();
      if (res && !res.ok && res.error) $('#update-status').textContent = res.error;
    };
  } else {
    $('#update-status').textContent = r?.error || '检查更新失败';
  }
}

// ═══════════ 服务器设置 / Radmin（桌面版）═══════════
function wireDesktopUI() {
  if (isElectron) {
    $('#btn-open-server').hidden = false;
    $('#btn-open-server').addEventListener('click', () => {
      closeModal('#modal-settings');
      openServerSettings();
    });
  }
  $('#btn-server-cancel')?.addEventListener('click', () => closeModal('#modal-server'));
  $('#btn-server-save')?.addEventListener('click', saveServerSettings);
  for (const id of ['#server-mode-local', '#server-mode-remote']) {
    $(id)?.addEventListener('change', () => {
      const remote = $('#server-mode-remote').checked;
      $('#server-address-field').hidden = !remote;
      $('#server-port-field').hidden = remote;
    });
  }
  // Radmin（高级备选）
  $('#btn-radmin-cancel')?.addEventListener('click', () => closeModal('#modal-radmin'));
  $('#btn-radmin-install')?.addEventListener('click', async () => {
    $('#radmin-status').textContent = '正在启动安装 Radmin VPN…（如弹出 UAC 请点“是”）';
    const r = await window.gvDesktop?.radminInstall?.();
    $('#radmin-status').textContent = r?.ok ? '安装程序已启动，完成后点「刷新状态」' : (r?.error || '启动安装失败，请查看日志');
  });
  $('#btn-radmin-create')?.addEventListener('click', () => radminNetwork('create'));
  $('#btn-radmin-join')?.addEventListener('click', () => radminNetwork('join'));
  $('#btn-radmin-refresh')?.addEventListener('click', refreshRadminStatus);
  $('#btn-radmin-use-ip')?.addEventListener('click', useRadminIp);
  // 共享源选择器
  if (window.gvDesktop?.onDisplaySourceList) {
    window.gvDesktop.onDisplaySourceList((list) => {
      renderSourcePicker(list, (id) => {
        closeModal('#modal-source-picker');
        window.gvDesktop.pickDisplaySource(id);
      });
      openModal('#modal-source-picker');
    });
    $('#btn-source-cancel')?.addEventListener('click', () => {
      closeModal('#modal-source-picker');
      window.gvDesktop.cancelDisplaySource();
    });
  }
  // 聊天（侧栏「聊天」页签）
  initChat({
    onSend: async (text) => {
      if (!state.socket?.connected?.()) {
        toast('尚未连接，无法发送', { kind: 'error' });
        return { error: '尚未连接' };
      }
      return await state.socket.chatSend(text);
    },
  });
}

async function openServerSettings() {
  openModal('#modal-server');
  if (window.gvDesktop?.getServerConfig) {
    const cfg = await window.gvDesktop.getServerConfig();
    ui.fillServerForm(cfg, true);
  } else {
    ui.fillServerForm({ mode: 'local', port: 3000 }, false);
  }
}

async function saveServerSettings() {
  if (!window.gvDesktop?.setServerConfig) { closeModal('#modal-server'); return; }
  const { mode, address, port } = ui.readServerForm();
  if (mode === 'remote' && !address) return toast('请输入好友地址', { kind: 'error' });
  if (mode === 'local' && (port < 1024 || port > 65535)) return toast('端口需在 1024-65535 之间', { kind: 'error' });
  const r = await window.gvDesktop.setServerConfig({ mode, address, port, nickname: state.username, autoJoin: true });
  if (r?.ok) { closeModal('#modal-server'); toast('设置已保存，正在重启应用…', { ms: 4000 }); }
  else toast(r?.error || '保存失败', { kind: 'error' });
}

async function openRadminModal() {
  openModal('#modal-radmin');
  await refreshRadminStatus();
}

async function refreshRadminStatus() {
  if (!window.gvDesktop?.radminStatus) { $('#radmin-status').textContent = '浏览器版不支持 Radmin，请使用桌面版'; return; }
  $('#radmin-status').textContent = '正在检测 Radmin VPN…';
  const r = await window.gvDesktop.radminStatus();
  const st = $('#radmin-status');
  if (!r?.ok) { st.textContent = r?.error || '获取状态失败'; return; }
  const parts = [`Radmin VPN：${r.installed ? '已安装' : '未安装'}`];
  if (r.running) parts.push('运行中');
  if (r.ip) parts.push('虚拟 IP ' + r.ip);
  st.textContent = parts.join(' · ');
  $('#btn-radmin-install').hidden = !!r.installed;
  $('#btn-radmin-use-ip').disabled = !r.ip;
}

async function radminNetwork(mode) {
  const name = $('#radmin-name').value.trim();
  const pwd = $('#radmin-pwd').value.trim();
  if (!name || !pwd) return toast('请输入网络名称和密码', { kind: 'error' });
  $('#radmin-net-result').hidden = false;
  $('#radmin-net-result').textContent = mode === 'create' ? '正在创建网络…' : '正在加入网络…';
  const r = await window.gvDesktop?.radminNetwork?.(mode, name, pwd);
  $('#radmin-net-result').textContent = r?.ok ? '操作已执行，点「刷新状态」获取虚拟 IP' : (r?.error || '操作失败');
}

async function useRadminIp() {
  const r = await window.gvDesktop?.radminStatus?.();
  if (!r?.ip) return toast('未检测到 Radmin 虚拟 IP', { kind: 'error' });
  const addr = $('#server-address');
  if (addr) addr.value = r.ip + ':3000';
  toast(`已填入 ${r.ip}:3000，点「保存并重启」生效`);
}

// ═══════════ 离开房间 ═══════════
async function leaveRoom() {
  if (state.local) await stopShare('已离开房间', { silent: true });
  for (const id of [...state.remotes.keys()]) cleanupRemote(id);
  state.mesh?.closeAll();
  state.stats?.stop();
  clearStatsHistory();
  state.members = [];
  state.shares.clear();
  state.focused = null;
  state.joined = false;
  state.stage.clear();
  ui.renderMembers([], null, null, focusMember);   // 清空侧栏成员列表
  clearChat();                                      // 清空聊天记录
  ui.setUplinkInfo('');
  ui.shareControlState({ sharing: false, pending: false, statusText: '' });
  const wasCloud = !!state.socket?.isCloud;
  try { await state.socket?.leave(); } catch { /* 忽略 */ }
  if (wasCloud) { state.socket = null; state.cloudCode = null; }   // 云传输已关闭：下次进入时重建
  ui.renderLobbyServer(wasCloud ? '☁️ 云房间已断开' : `当前服务器：${location.origin} · v${state.version}`);
  ui.showScreen('lobby');
}

// ═══════════ 移动端：侧栏自动收起（顶栏 👥 按钮开合）═══════════
if (isMobile) {
  document.addEventListener('click', (e) => {
    if (['btn-invite', 'btn-qr', 'btn-leave'].includes(e.target?.id)) $('#sidebar').classList.remove('open');
  });
}

// ── PWA ──
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* 注册失败不影响使用 */ });
  });
}

// ── 自动化测试钩子（不影响正常使用；浏览器控制台/测试脚本可调用）──
window.__ginyTest = {
  state,
  enter: (nick = '测试') => {
    $('#input-username').value = nick;
    return enterRoom();
  },
  /** 用 canvas 合成画面模拟「屏幕共享」，用于链路自测（无需真实屏幕授权）；tone=true 时附带合成音轨 */
  fakeShare: async ({ mode = 'webrtc', width = 1280, height = 720, fps = 30, text = 'Gracs 测试画面', tone = false } = {}) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    let n = 0;
    const timer = setInterval(() => {
      n++;
      const t = n / 30;
      ctx.fillStyle = '#0b1220';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = `hsl(${(t * 40) % 360} 80% 55%)`;
      ctx.fillRect((t * 90) % (width - 160), 80, 160, 90);
      ctx.fillStyle = '#e8f0ff';
      ctx.font = '600 36px sans-serif';
      ctx.fillText(text, 40, 60);
      ctx.font = '500 24px monospace';
      ctx.fillText(`frame ${n} · ${new Date().toLocaleTimeString()}`, 40, height - 40);
    }, 1000 / fps);
    const stream = canvas.captureStream(fps);
    stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
    state.local?.stream?.addEventListener('ended', () => clearInterval(timer));
    if (tone) {
      const ac = new AudioContext();
      await ac.resume().catch(() => {});
      const osc = ac.createOscillator();
      osc.frequency.value = 440;
      const gain = ac.createGain();
      gain.gain.value = 0.12;
      const dest = ac.createMediaStreamDestination();
      osc.connect(gain);
      gain.connect(dest);
      osc.start();
      for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
    }
    await startShareFlow(stream, {
      width, height, fps, title: '测试画面', hasAudio: stream.getAudioTracks().length > 0,
    }, mode);
    return { ok: true, mode: state.local?.mode, size: `${width}x${height}`, fps, audio: stream.getAudioTracks().length };
  },
  stopShare: () => stopShare('测试结束', { silent: true }),
  cinemaStats: () => state.local?.cinema?.stats || null,
  receiverStats: (peerId) => state.remotes.get(peerId)?.cinema?.stats || null,
  sample: () => ({
    local: state.local ? { mode: state.local.mode, preset: state.local.preset } : null,
    remotes: [...state.remotes.entries()].map(([id, r]) => ({ id, hasStream: !!r.stream, kind: r.cinema ? 'cinema' : r.stream ? 'video' : 'none', stats: r.cinema?.stats || null })),
    members: state.members.map((m) => ({ id: m.id, name: m.username, share: m.share?.mode || null })),
    focused: state.focused,
    stats: state.statsSamples ? {
      out: [...state.statsSamples.out.entries()].map(([id, s]) => ({ id, bitrate: s?.bitrate, fps: s?.fps, level: s?.level, relay: s?.relay })),
      in: [...state.statsSamples.in.entries()].map(([id, s]) => ({ id, bitrate: s?.bitrate, fps: s?.fps, level: s?.level, relay: s?.relay })),
    } : null,
  }),
};

boot();
