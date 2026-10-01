// main.js — GinyScreen 应用逻辑（房间 / 共享 / 观看 / 语音 / 联机 / 设置）
import { connectSignaling } from './signaling.js';
import { connectCloudSignaling } from './cloud-signal.js';
import { MeshManager } from './webrtc.js';
import { PRESETS, DEFAULT_PRESET, startScreenShare, applyPreset } from './screenshare.js';
import * as ui from './ui.js';

const state = {
  meId: null,
  username: '',
  socket: null,
  mesh: null,
  transport: null,          // 'local' | 'cloud'（当前传输方式）
  cloudCode: null,          // 云房间码
  config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], version: '' },
  members: [],
  localStream: null,        // 屏幕共享流
  remoteStreams: new Map(), // peerId -> { username, stream }（屏幕）
  voiceStreams: new Map(),  // peerId -> MediaStream（语音）
  voiceVolumes: new Map(),  // peerId -> 播放音量
  micOn: false,
  micStream: null,
  micRawStream: null,
  micSource: null,
  localAnalyser: null,
  micGain: null,
  focused: null,
  sharing: false,
  preset: DEFAULT_PRESET,
};

// ═══════════ 启动 ═══════════
async function boot() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    if (cfg.iceServers?.length) state.config.iceServers = cfg.iceServers;
    if (cfg.version) state.config.version = cfg.version;
  } catch { /* 配置拉取失败则用默认 STUN */ }

  connect();
  wireLobby();
  wireRoom();
  wireModals();
  wireSourcePicker();
  wireRadmin();
  wireVoiceUI();
  wireErrorReport();
  showLobbyServer();
  const params = new URLSearchParams(location.search);
  if (params.get('recover') === '1') ui.$('#lobby-recover-banner').hidden = false;
  const autoNick = params.get('nick') || '';
  if (autoNick) ui.$('#input-username').value = autoNick;
  const cloudCode = (params.get('cloud') || '').trim().toUpperCase();
  if (cloudCode) {
    ui.$('#mode-cloud').checked = true;
    ui.$('#input-cloud-code').value = cloudCode;
    syncLobbyModeFn?.();
  }
  if (params.get('autojoin') === '1' && autoNick) {
    if (cloudCode) enterCloudRoom('join');
    else enterRoom('join');
  } else ui.showScreen('lobby');
}

let syncLobbyModeFn = null;

function signalCallbacks() {
  return {
    onState: (s) => applyRoomState(s),
    onSignal: (p) => state.mesh?.handleSignal(p.from, p.data),
    onMemberJoined: (p) => onMemberJoined(p.user),
    onMemberLeft: (p) => onMemberLeft(p.id),
    onShareUpdate: (p) => onShareUpdate(p.id, p.share),
    onVoiceUpdate: (p) => onVoiceUpdate(p.id, p.voice),
    onError: (msg) => { ui.toast(msg); setConnStatus(false); },
  };
}

function setupSocket(socket) {
  state.socket = socket;
  state.mesh = new MeshManager({
    socket: state.socket,
    iceServers: state.config.iceServers,
    myId: () => state.socket.id(),
    onRemoteStream: (peerId, stream, channel) => onRemoteStream(peerId, stream, channel),
    onPeerState: (peerId, st, channel) => onPeerState(peerId, st, channel),
  });
}

function connect() {
  state.transport = 'local';
  setupSocket(connectSignaling(signalCallbacks()));
}

// ═══════════ 云房间（Project4 云信令）═══════════
function getRelayUrl() {
  const q = new URLSearchParams(location.search).get('relay');
  if (q) return q;
  if (state.config.cloud?.relay) return state.config.cloud.relay;
  return 'wss://gracs.ginyva.site/ws';
}

function connectCloud() {
  if (state.transport === 'cloud' && state.socket?.isCloud) return;
  state.transport = 'cloud';
  setupSocket(connectCloudSignaling(Object.assign({ getUrl: getRelayUrl }, signalCallbacks())));
}

// ═══════════ 进入页 ═══════════
function wireLobby() {
  const isBrowser = !window.gvDesktop?.setServerConfig;
  const modeHost = ui.$('#mode-host');
  const modeGuest = ui.$('#mode-guest');
  const modeCloud = ui.$('#mode-cloud');
  const btnCreate = ui.$('#btn-create');
  const btnJoin = ui.$('#btn-join');

  function currentMode() {
    if (modeCloud?.checked) return 'cloud';
    return modeGuest?.checked ? 'guest' : 'host';
  }

  function syncLobbyMode() {
    const mode = currentMode();
    ui.$('#port-field').hidden = isBrowser || mode !== 'host';
    ui.$('#address-field').hidden = isBrowser || mode !== 'guest';
    ui.$('#cloud-field').hidden = mode !== 'cloud';
    if (isBrowser) {
      btnJoin.hidden = mode !== 'cloud';
      btnCreate.textContent = mode === 'cloud' ? '☁️ 创建云房间' : '进入房间';
      btnJoin.textContent = '加入云房间';
    } else {
      btnJoin.hidden = false;
      btnCreate.textContent = mode === 'cloud' ? '☁️ 创建云房间' : '开房间';
      btnJoin.textContent = mode === 'cloud' ? '加入云房间' : '加入房间';
    }
    if (mode === 'guest') ui.$('#input-address').focus();
    if (mode === 'cloud') ui.$('#input-cloud-code').focus();
  }

  [modeHost, modeGuest, modeCloud].forEach((r) => r?.addEventListener('change', syncLobbyMode));
  btnCreate.addEventListener('click', () => {
    if (currentMode() === 'cloud') enterCloudRoom('create');
    else enterRoom('create');
  });
  btnJoin.addEventListener('click', () => {
    if (currentMode() === 'cloud') enterCloudRoom('join');
    else enterRoom('join');
  });
  ui.$('#input-username').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (currentMode() === 'cloud') enterCloudRoom('create');
    else enterRoom(modeGuest?.checked ? 'join' : 'create');
  });
  ui.$('#input-port').addEventListener('keydown', (e) => { if (e.key === 'Enter') enterRoom('create'); });
  ui.$('#input-address').addEventListener('keydown', (e) => { if (e.key === 'Enter') enterRoom('join'); });
  ui.$('#input-cloud-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') enterCloudRoom('join'); });
  ui.$('#btn-server-settings-lobby')?.addEventListener('click', openServerSettings);

  // 浏览器版没有端口/IP 直连能力：保留「进入当前服务器」与「云房间」两种方式
  if (isBrowser) {
    ui.$('#mode-guest-opt').hidden = true;
    ui.$('#mode-host-label').textContent = '进入当前服务器';
    ui.$('#btn-radmin-lobby').hidden = true;
  }
  syncLobbyMode();
  syncLobbyModeFn = syncLobbyMode;
}

async function enterRoom(mode) {
  const username = ui.$('#input-username').value.trim() || '观众';
  state.username = username;
  const autojoin = new URLSearchParams(location.search).get('autojoin') === '1';
  // 桌面版首页：先保存连接配置（端口 / IP:端口），重启后自动进入
  if (window.gvDesktop?.setServerConfig && !autojoin) {
    const isHost = mode !== 'join';
    const port = Number(ui.$('#input-port').value);
    const address = ui.$('#input-address').value.trim();
    if (isHost) {
      if (!port || port < 1024 || port > 65535) return showLobbyError('请输入有效端口（1024-65535）');
    } else {
      if (!address) return showLobbyError('请输入目标服务器地址，如 192.168.1.5:3000 或 隧道域名:端口');
    }
    const r = await window.gvDesktop.setServerConfig({
      mode: isHost ? 'local' : 'remote',
      address,
      port,
      nickname: username,
      autoJoin: true,
    });
    if (r?.ok) ui.toast('正在重启并进入房间…');
    else ui.toast(r?.error || '设置保存失败');
    return;
  }
  // 浏览器版 / 重启后的桌面版：直接加入当前服务器的默认房间
  const res = await state.socket.joinRoom(username);
  if (res?.error) return showLobbyError(res.error);
  state.meId = state.socket.id();
  state.members = res.roomState.users;
  ui.$('#lobby-error').hidden = true;
  setConnStatus(true);
  ui.renderMembers(state.members, state.meId);
  applyRoomState(res.roomState);
  ui.showScreen('room');
  renderVoicePanel();
  if (autojoin) history.replaceState(null, '', location.pathname);
}

// 进入「云房间」（Project4 云信令：房间码进出，跨网络免组网）
async function enterCloudRoom(kind) {
  const username = ui.$('#input-username').value.trim() || '观众';
  state.username = username;
  const code = ui.$('#input-cloud-code').value.trim().toUpperCase();
  if (kind === 'join' && !code) return showLobbyError('请输入云房间码（如 K7X2Q9）');
  connectCloud();
  const btn = kind === 'create' ? ui.$('#btn-create') : ui.$('#btn-join');
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = kind === 'create' ? '☁️ 创建中…' : '☁️ 加入中…';
  try {
    const res = kind === 'create'
      ? await state.socket.createRoom(username)
      : await state.socket.joinRoom(username, code);
    if (res?.error) return showLobbyError(res.error);
    state.cloudCode = (res.code || code).toUpperCase();
    state.meId = state.socket.id();
    state.members = res.roomState?.users || [];
    ui.$('#lobby-error').hidden = true;
    setConnStatus(true);
    ui.renderMembers(state.members, state.meId);
    applyRoomState(res.roomState || { users: state.members });
    ui.showScreen('room');
    renderVoicePanel();
    const invite = location.origin + location.pathname + '?cloud=' + state.cloudCode;
    if (kind === 'create') copyText(invite, '☁️ 云房间已创建 · 房间码 ' + state.cloudCode + '（邀请链接已复制）');
    else ui.toast('已加入云房间 ' + state.cloudCode);
    history.replaceState(null, '', location.pathname);
  } catch (err) {
    showLobbyError('云房间连接失败：' + (err?.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

function showLobbyError(msg) {
  const el = ui.$('#lobby-error');
  el.textContent = msg;
  el.hidden = false;
}

async function showLobbyServer() {
  const el = ui.$('#lobby-server');
  try {
    if (window.gvDesktop?.getServerConfig) {
      const cfg = await window.gvDesktop.getServerConfig();
      el.textContent = cfg.mode === 'remote' ? `当前服务器：${cfg.address}` : `当前服务器：本机开服（端口 ${cfg.port || 3000}）`;
    } else {
      el.textContent = `当前服务器：${location.origin}`;
    }
  } catch { /* 忽略 */ }
}

// ═══════════ 房间状态同步 ═══════════
function applyRoomState(s) {
  state.members = s.users || [];
  ui.renderMembers(state.members, state.meId);
  // 清理「对方已停止共享」的画面（以服务器状态为准）
  const still = new Set(state.members.filter((m) => m.share).map((m) => m.id));
  for (const peerId of [...state.remoteStreams.keys()]) {
    if (!still.has(peerId)) removeRemote(peerId);
  }
  // 清理「对方已关麦」的语音（以服务器状态为准；连接关闭事件也会兜底）
  const voiceOn = new Set(state.members.filter((m) => m.voice).map((m) => m.id));
  for (const peerId of [...state.voiceStreams.keys()]) {
    if (!voiceOn.has(peerId) && peerId !== state.meId) {
      detachRemoteVoice(peerId);
      state.voiceStreams.delete(peerId);
    }
  }
  if (!state.members.some((m) => m.share) && !state.sharing) {
    state.focused = null;
  }
  renderStage();
  renderVoicePanel();
}

function onMemberJoined(user) {
  state.members.push(user);
  ui.renderMembers(state.members, state.meId);
  renderVoicePanel();
  state.mesh?.peerJoined(user); // 我共享中 → 发起屏幕；我开着麦 → 发起语音
}

function onMemberLeft(id) {
  state.members = state.members.filter((m) => m.id !== id);
  ui.renderMembers(state.members, state.meId);
  removeRemote(id);
  detachRemoteVoice(id);
  state.voiceStreams.delete(id);
  renderVoicePanel();
  state.mesh?.closeIncoming(id);
}

function onShareUpdate(id, share) {
  const m = state.members.find((x) => x.id === id);
  if (m) m.share = share;
  ui.renderMembers(state.members, state.meId);
  if (!share) {
    removeRemote(id);
    state.mesh?.closeIncoming(id);
  }
  renderStage();
}

function onVoiceUpdate(id, voice) {
  const m = state.members.find((x) => x.id === id);
  if (m) m.voice = voice;
  ui.renderMembers(state.members, state.meId);
  renderVoicePanel();
  if (!voice && id !== state.meId) {
    detachRemoteVoice(id);
    state.voiceStreams.delete(id);
    state.mesh?.closeIncoming(id); // 对方关麦 → 释放入站语音连接
  }
}

function onRemoteStream(peerId, stream, channel) {
  if (channel === 'voice') {
    const member = state.members.find((m) => m.id === peerId);
    state.voiceStreams.set(peerId, stream);
    attachRemoteVoice(peerId, stream);
    if (member) member.voice = true;
    ui.renderMembers(state.members, state.meId);
    renderVoicePanel();
    startVoiceLoop();
    return;
  }
  const member = state.members.find((m) => m.id === peerId);
  state.remoteStreams.set(peerId, { username: member?.username || '好友', stream });
  renderStage();
}

function onPeerState(peerId, st, channel) {
  if (st === 'failed' || st === 'closed') {
    if (channel === 'voice') {
      if (state.voiceStreams.has(peerId)) {
        detachRemoteVoice(peerId);
        state.voiceStreams.delete(peerId);
        renderVoicePanel();
      }
    } else if (state.remoteStreams.has(peerId)) {
      ui.toast(`与「${state.remoteStreams.get(peerId).username}」的连接中断`, 4000);
      removeRemote(peerId);
      state.mesh?.closeIncoming(peerId);
    }
  }
}

function removeRemote(peerId) {
  if (state.remoteStreams.delete(peerId)) {
    if (state.focused === peerId) state.focused = null;
    renderStage();
  }
}

function renderStage() {
  const views = { local: null, remotes: [] };
  if (state.localStream) views.local = { username: state.username, stream: state.localStream };
  for (const [id, v] of state.remoteStreams) views.remotes.push({ id, username: v.username, stream: v.stream });
  ui.renderStage(views, state.focused);
}

// ═══════════ 屏幕共享 ═══════════
let sharePending = false;
let sharePendingTimer = null;

async function toggleShare() {
  if (state.sharing) { stopShare(); return; }
  if (sharePending) return; // 反馈延迟期间防重复点击
  sharePending = true;
  setShareLoading(true, '⏳ 正在准备共享…');
  sharePendingTimer = setTimeout(() => {
    if (!sharePending) return;
    sharePending = false;
    setShareLoading(false);
    window.gvDesktop?.cancelDisplaySource?.();
    ui.toast('等待选择超时，已取消（请重试）');
  }, 60_000);
  const withAudio = ui.$('#share-audio').checked;
  try {
    const { stream } = await startScreenShare({ presetKey: state.preset, withAudio });
    clearTimeout(sharePendingTimer);
    sharePending = false;
    if (!stream || !stream.getVideoTracks().length) { setShareLoading(false); return; }
    state.localStream = stream;
    state.sharing = true;
    state.focused = 'local';
    stream.addEventListener('userstopped', () => stopShare('已在系统里停止共享'));
    state.mesh.startSharing(stream, state.members);
    await state.socket.setShare(true);
    updateShareUI();
    renderStage();
    setShareLoading(false);
    ui.toast(withAudio ? '共享已开始（含系统声音）' : '共享已开始');
    if (withAudio) ui.toast('共享窗口时已自动静音其他应用（含本机语音回放），停止共享后恢复', 5200);
  } catch (err) {
    clearTimeout(sharePendingTimer);
    sharePending = false;
    setShareLoading(false);
    if (err?.name === 'NotAllowedError' || /cancel|abort/i.test(String(err?.message || ''))) ui.toast('已取消共享');
    else { console.error(err); ui.toast('共享失败：' + (err?.message || err)); }
  }
}

function stopShare(reason) {
  if (!state.sharing) return;
  state.sharing = false;
  state.mesh.stopSharing();
  state.socket.setShare(false);
  state.localStream = null;
  if (state.focused === 'local') state.focused = null;
  // 恢复被静音的其他应用（窗口声音方案A）
  window.gvDesktop?.restoreWindowAudio?.();
  updateShareUI();
  renderStage();
  ui.toast(reason || '已停止共享');
}

function setShareLoading(on, text) {
  const btn = ui.$('#btn-share');
  if (btn) {
    btn.disabled = on;
    btn.textContent = on ? text : (state.sharing ? '⏹ 停止共享' : '🖥️ 共享屏幕');
    btn.classList.toggle('loading', on);
  }
  const emptyBtn = ui.$('#btn-empty-share');
  if (emptyBtn) {
    emptyBtn.disabled = on;
    emptyBtn.textContent = on ? '⏳ 准备中…' : '共享屏幕';
  }
}

function updateShareUI() {
  const btn = ui.$('#btn-share');
  btn.textContent = state.sharing ? '⏹ 停止共享' : '🖥️ 共享屏幕';
  btn.classList.toggle('sharing', state.sharing);
  ui.$('#share-audio').disabled = state.sharing;
  const st = ui.$('#share-status');
  st.textContent = state.sharing ? `正在共享（${PRESETS[state.preset].label}）` : '';
  const presetSel = ui.$('#preset-select');
  if (state.sharing) {
    presetSel.onchange = async () => {
      state.preset = presetSel.value;
      applyPreset(state.localStream, state.mesh.outPcsList(), state.preset);
      st.textContent = `正在共享（${PRESETS[state.preset].label}）`;
    };
  } else {
    presetSel.onchange = () => { state.preset = presetSel.value; };
  }
}

// ═══════════ 内置语音（麦克风）═══════════
let audioCtx = null;
const playbackNodes = new Map(); // peerId -> { src, analyser, gain }
const talkingPrev = new Map();   // peerId/'local' -> bool
let voiceRaf = null;

function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}
// autoplay 策略兜底：任何点击都尝试恢复音频上下文
document.addEventListener('pointerdown', () => { try { audioCtx?.resume(); } catch { /* 忽略 */ } }, { passive: true });

function wireVoiceUI() {
  ui.$('#btn-mic').addEventListener('click', toggleMic);
  ui.$('#mic-gain').addEventListener('input', (e) => {
    const v = Number(e.target.value) / 100;
    if (state.micGain) state.micGain.gain.value = v;
  });
  ui.setVoiceVolumeHandler((peerId, v) => setRemoteVoiceVolume(peerId, v));
}

async function toggleMic() {
  if (state.micOn) { disableMic(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,      // AEC：消除扬声器回放（他人声音/共享音频）进入麦克风的回声
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const ctx = ensureAudioCtx();
    await ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const gain = ctx.createGain();
    gain.gain.value = Number(ui.$('#mic-gain').value || 100) / 100;
    const dest = ctx.createMediaStreamDestination();
    src.connect(analyser);
    analyser.connect(gain);
    gain.connect(dest);
    state.micRawStream = stream;
    state.micSource = src;
    state.localAnalyser = analyser;
    state.micGain = gain;
    state.micStream = dest.stream;
    state.micOn = true;
    state.mesh.startMic(dest.stream, state.members);
    await state.socket.setVoice(true);
    updateVoiceUI();
    renderVoicePanel();
    startVoiceLoop();
    ui.toast('麦克风已开启（已开启回声消除，不会把自己的回音传回）');
  } catch (err) {
    console.error(err);
    ui.toast('麦克风开启失败：' + (err?.message || err));
  }
}

function disableMic() {
  state.micOn = false;
  state.mesh.stopMic();
  state.socket.setVoice(false);
  try { state.micSource?.disconnect(); } catch { /* 忽略 */ }
  state.micRawStream?.getTracks().forEach((t) => { try { t.stop(); } catch { /* 忽略 */ } });
  state.micStream = null;
  state.micRawStream = null;
  state.micSource = null;
  state.localAnalyser = null;
  state.micGain = null;
  updateVoiceUI();
  renderVoicePanel();
  stopVoiceLoop();
  ui.toast('麦克风已关闭');
}

function updateVoiceUI() {
  const btn = ui.$('#btn-mic');
  btn.textContent = state.micOn ? '🎙️ 关闭麦克风' : '🎤 打开麦克风';
  btn.classList.toggle('mic-on', state.micOn);
}

function attachRemoteVoice(peerId, stream) {
  const ctx = ensureAudioCtx();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  const gain = ctx.createGain();
  gain.gain.value = state.voiceVolumes.get(peerId) ?? 1;
  src.connect(analyser);
  analyser.connect(gain);
  gain.connect(ctx.destination);
  playbackNodes.set(peerId, { src, analyser, gain });
}

function detachRemoteVoice(peerId) {
  const n = playbackNodes.get(peerId);
  if (n) {
    try { n.src.disconnect(); n.analyser.disconnect(); n.gain.disconnect(); } catch { /* 忽略 */ }
    playbackNodes.delete(peerId);
  }
}

function setRemoteVoiceVolume(peerId, v) {
  state.voiceVolumes.set(peerId, v);
  const n = playbackNodes.get(peerId);
  if (n) n.gain.gain.value = v;
}

function rmsFromAnalyser(analyser) {
  if (!analyser) return 0;
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / data.length);
}

const TALK_THRESHOLD = 0.03;

function startVoiceLoop() {
  if (voiceRaf) return;
  const tick = () => {
    if (state.meId) setTalking(state.meId, rmsFromAnalyser(state.localAnalyser) > TALK_THRESHOLD);
    for (const [peerId, n] of playbackNodes) {
      setTalking(peerId, rmsFromAnalyser(n.analyser) > TALK_THRESHOLD);
    }
    voiceRaf = requestAnimationFrame(tick);
  };
  tick();
}

function stopVoiceLoop() {
  if (voiceRaf) { cancelAnimationFrame(voiceRaf); voiceRaf = null; }
  for (const key of [...talkingPrev.keys()]) setTalking(key, false);
}

function setTalking(id, talking) {
  if (talkingPrev.get(id) === talking) return;
  talkingPrev.set(id, talking);
  const li = document.querySelector(`#voice-list .voice-item[data-id="${id}"]`);
  if (li) li.classList.toggle('talking', talking);
}

function renderVoicePanel() {
  if (!ui.$('#voice-list')) return;
  const items = state.members.map((m) => ({
    id: m.id,
    username: m.username,
    isMe: m.id === state.meId,
    micOn: m.id === state.meId ? state.micOn : !!m.voice,
    talking: !!talkingPrev.get(m.id),
    hasStream: state.voiceStreams.has(m.id),
    volume: state.voiceVolumes.get(m.id),
  }));
  ui.renderVoice(items);
}

// ═══════════ 房间工具栏 ═══════════
function wireRoom() {
  ui.$('#btn-share').addEventListener('click', toggleShare);
  ui.$('#stage').addEventListener('click', (e) => {
    if (e.target.id === 'btn-empty-share') toggleShare();
  });
  ui.setFocusHandler((id) => { state.focused = id; renderStage(); });

  ui.$('#btn-copy-link').addEventListener('click', () => {
    if (state.transport === 'cloud' && state.cloudCode) {
      copyText(location.origin + location.pathname + '?cloud=' + state.cloudCode,
        '☁️ 云房间邀请链接已复制（房间码 ' + state.cloudCode + '）');
    } else {
      copyText(location.origin, '访问地址已复制（好友用它加入你的房间）');
    }
  });
  ui.$('#btn-leave').addEventListener('click', leaveRoom);
  ui.$('#btn-server-settings').addEventListener('click', openServerSettings);
  ui.$('#share-audio').addEventListener('change', (e) => {
    if (state.sharing) { e.target.checked = false; ui.toast('请在停止共享后修改系统声音'); }
  });
}

async function copyText(text, okMsg) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else { const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
    ui.toast(okMsg);
  } catch { ui.toast('复制失败，请手动复制'); }
}

async function leaveRoom() {
  if (state.sharing) stopShare('已离开房间');
  if (state.micOn) disableMic();
  state.mesh?.closeAll();
  state.remoteStreams.clear();
  state.voiceStreams.clear();
  for (const pid of [...playbackNodes.keys()]) detachRemoteVoice(pid);
  state.members = [];
  state.focused = null;
  ui.clearVideos();
  const wasCloud = state.transport === 'cloud';
  await state.socket?.leaveRoom();
  if (wasCloud) {
    // 云信令连接已随离开关闭：复位传输层，回大厅后按所选方式重新建立
    state.socket = null;
    state.mesh = null;
    state.transport = null;
    state.cloudCode = null;
    connect();
  }
  ui.showScreen('lobby');
}

// ═══════════ 内置共享源选择器（桌面版）═══════════
function wireSourcePicker() {
  if (!window.gvDesktop?.onDisplaySourceList) return;
  ui.setSourcePickHandler((sourceId) => {
    ui.closeModal('#modal-source-picker');
    window.gvDesktop.pickDisplaySource(sourceId);
  });
  ui.$('#btn-source-cancel').addEventListener('click', () => {
    ui.closeModal('#modal-source-picker');
    window.gvDesktop.cancelDisplaySource();
  });
  window.gvDesktop.onDisplaySourceList((list) => {
    ui.renderSourcePicker(list);
    ui.openModal('#modal-source-picker');
  });
}

// ═══════════ Radmin VPN 联机（内嵌）═══════════
function wireRadmin() {
  for (const id of ['#btn-radmin-lobby', '#btn-radmin-room']) {
    ui.$(id)?.addEventListener('click', openRadminModal);
  }
  ui.$('#btn-radmin-cancel').addEventListener('click', () => { ui.$('#modal-radmin').hidden = true; });
  ui.$('#btn-radmin-install').addEventListener('click', async () => {
    ui.$('#radmin-status').textContent = '正在启动安装 Radmin VPN…（如弹出 UAC 请点“是”）';
    const r = await window.gvDesktop?.radminInstall?.();
    ui.$('#radmin-status').textContent = r?.ok ? '安装程序已启动，完成后点「刷新状态」' : (r?.error || '启动安装失败，请查看日志');
  });
  ui.$('#btn-radmin-create').addEventListener('click', () => radminNetwork('create'));
  ui.$('#btn-radmin-join').addEventListener('click', () => radminNetwork('join'));
  ui.$('#btn-radmin-refresh').addEventListener('click', refreshRadminStatus);
  ui.$('#btn-radmin-use-ip').addEventListener('click', useRadminIp);
}

async function openRadminModal() {
  const modal = ui.$('#modal-radmin');
  modal.hidden = false;
  ui.$('#radmin-net-result').hidden = true;
  if (!window.gvDesktop?.radminStatus) {
    ui.$('#radmin-status').textContent = '浏览器版不支持 Radmin 联机，请使用桌面版 exe';
    return;
  }
  await refreshRadminStatus();
}

async function refreshRadminStatus() {
  if (!window.gvDesktop?.radminStatus) return;
  ui.$('#radmin-status').textContent = '正在检测 Radmin VPN…';
  const r = await window.gvDesktop.radminStatus();
  const st = ui.$('#radmin-status');
  if (!r?.ok) { st.textContent = r?.error || '获取状态失败，请查看日志'; return; }
  const parts = [`Radmin VPN：${r.installed ? '已安装' : '未安装'}`];
  if (r.running) parts.push('运行中');
  if (r.ip) parts.push('本机虚拟 IP ' + r.ip);
  st.textContent = parts.join(' · ');
  ui.$('#btn-radmin-install').hidden = !!r.installed;
  ui.$('#btn-radmin-use-ip').disabled = !r.ip;
}

async function radminNetwork(mode) {
  const name = ui.$('#radmin-name').value.trim();
  const pwd = ui.$('#radmin-pwd').value.trim();
  if (!name || !pwd) { ui.toast('请输入网络名称和密码'); return; }
  ui.$('#radmin-net-result').hidden = false;
  ui.$('#radmin-net-result').textContent = mode === 'create' ? '正在创建网络…' : '正在加入网络…';
  const r = await window.gvDesktop?.radminNetwork?.(mode, name, pwd);
  ui.$('#radmin-net-result').textContent = r?.ok
    ? '操作已执行。请确认 Radmin 界面中的网络状态，成功后点「刷新状态」获取虚拟 IP'
    : (r?.error || '操作失败，请查看日志');
}

async function useRadminIp() {
  if (!window.gvDesktop?.getServerConfig) return;
  const cfg = await window.gvDesktop.getServerConfig();
  if (cfg.mode !== 'remote') { ui.toast('请先切到「连接朋友的服务器」再填入 Radmin 虚拟 IP'); return; }
  const r = await window.gvDesktop.radminStatus();
  if (!r?.ip) { ui.toast('未检测到 Radmin 虚拟 IP，请先加入网络'); return; }
  const addr = ui.$('#server-address');
  addr.value = r.ip + ':3000';
  ui.toast('已填入 ' + r.ip + ':3000，点「保存并重启」生效');
}

// ═══════════ 服务器设置 ═══════════
async function openServerSettings() {
  const modal = ui.$('#modal-server');
  modal.hidden = false;
  const localEl = ui.$('#server-local-urls');
  const addrEl = ui.$('#server-address');
  const local = ui.$('#server-mode-local');
  const remote = ui.$('#server-mode-remote');
  local.disabled = false;
  remote.disabled = false;
  if (window.gvDesktop?.getServerConfig) {
    const cfg = await window.gvDesktop.getServerConfig();
    local.checked = cfg.mode !== 'remote';
    remote.checked = cfg.mode === 'remote';
    addrEl.value = cfg.address || '';
    ui.$('#server-port').value = cfg.port || 3000;
    ui.$('#server-address-field').hidden = cfg.mode !== 'remote';
    ui.$('#server-port-field').hidden = cfg.mode === 'remote';
    localEl.innerHTML = cfg.localUrls?.length
      ? cfg.localUrls.map((u) => `<code>${u}</code>`).join('<br>')
      : '（未检测到局域网/组网地址，请先加入 Radmin VPN / 蒲公英等虚拟局域网）';
  } else {
    ui.$('#server-port-field').hidden = true;
    local.checked = true;
    remote.checked = false;
    localEl.innerHTML = `当前服务器：<code>${location.origin}</code><br>浏览器版切换服务器请直接打开目标地址。`;
  }
}

async function saveServerSettings() {
  if (!window.gvDesktop?.setServerConfig) {
    ui.toast('浏览器版无需保存：请直接访问目标服务器地址');
    ui.$('#modal-server').hidden = true;
    return;
  }
  const mode = ui.$('#server-mode-remote').checked ? 'remote' : 'local';
  const address = ui.$('#server-address').value.trim();
  const port = Number(ui.$('#server-port').value) || 3000;
  const nickname = state.username || ui.$('#input-username').value.trim() || '';
  if (mode === 'local' && (port < 1024 || port > 65535)) { ui.toast('请输入有效端口（1024-65535）'); return; }
  if (mode === 'remote' && !address) { ui.toast('请输入服务器地址'); return; }
  const r = await window.gvDesktop.setServerConfig({ mode, address, port, nickname, autoJoin: true });
  if (r?.ok) {
    ui.$('#modal-server').hidden = true;
    ui.toast('设置已保存，正在重启应用…');
  } else {
    ui.toast(r?.error || '保存失败');
  }
}

// ═══════════ 更新 / 关于 / 退出 ═══════════
function wireModals() {
  ui.$('#btn-server-cancel').addEventListener('click', () => { ui.$('#modal-server').hidden = true; });
  ui.$('#btn-server-save').addEventListener('click', saveServerSettings);
  for (const radio of [ui.$('#server-mode-local'), ui.$('#server-mode-remote')]) {
    radio.addEventListener('change', () => {
      const remote = ui.$('#server-mode-remote').checked;
      ui.$('#server-address-field').hidden = !remote;
      ui.$('#server-port-field').hidden = remote;
      if (remote) ui.$('#server-address').focus();
    });
  }
  ui.$('#btn-about-close').addEventListener('click', () => { ui.$('#modal-about').hidden = true; });
  ui.$('#btn-update-cancel').addEventListener('click', () => { ui.$('#modal-update').hidden = true; });
  ui.$('#btn-update-now').addEventListener('click', async () => {
    ui.$('#update-status').textContent = '正在下载并安装…';
    const r = await window.gvDesktop.applyUpdate();
    if (r && !r.ok && r.error) ui.$('#update-status').textContent = r.error;
  });
  ui.$('#modal-server').addEventListener('click', (e) => { if (e.target.id === 'modal-server') ui.$('#modal-server').hidden = true; });
  ui.$('#modal-radmin').addEventListener('click', (e) => { if (e.target.id === 'modal-radmin') ui.$('#modal-radmin').hidden = true; });

  ui.wireHelpDropdown();
  ui.setMenuHandler('check-update', checkUpdate);
  ui.setMenuHandler('open-radmin', openRadminModal);
  ui.setMenuHandler('open-about', () => {
    ui.$('#about-version').textContent = state.config.version || '--';
    ui.openModal('#modal-about');
  });
  ui.setMenuHandler('quit-app', () => window.gvDesktop?.quit());
}

async function checkUpdate() {
  const modal = ui.$('#modal-update');
  ui.openModal('#modal-update');
  ui.$('#update-info').hidden = true;
  ui.$('#btn-update-now').hidden = true;
  if (!window.gvDesktop?.checkUpdate) {
    ui.$('#update-status').textContent = '浏览器版不支持检查更新，请使用桌面版 exe';
    return;
  }
  ui.$('#update-status').textContent = '检查更新中…';
  const r = await window.gvDesktop.checkUpdate();
  if (r?.ok) {
    if (!r.hasUpdate) {
      ui.$('#update-status').textContent = `已是最新版本（v${r.current}）`;
      return;
    }
    ui.$('#update-status').textContent = `发现新版本（${r.source}）`;
    ui.$('#update-cur').textContent = `v${r.current}`;
    ui.$('#update-new').textContent = `v${r.latest}`;
    ui.$('#update-notes').textContent = r.notes || '';
    ui.$('#update-info').hidden = false;
    ui.$('#btn-update-now').hidden = false;
  } else {
    ui.$('#update-status').textContent = r?.error || '检查更新失败';
  }
}

// ═══════════ 错误上报 ═══════════
function wireErrorReport() {
  window.addEventListener('error', (e) => {
    state.socket?.reportError({ message: e.message, stack: e.error?.stack, url: location.href });
  });
  window.addEventListener('unhandledrejection', (e) => {
    state.socket?.reportError({ message: String(e.reason || 'Unknown rejection') });
  });
}

function setConnStatus(ok) {
  const el = ui.$('#conn-status');
  el.textContent = ok ? '● 已连接' : '● 连接中断';
  el.className = 'conn-status ' + (ok ? 'ok' : 'bad');
}

// 深色主题下选择框跟随系统
boot();
