// ui.js — 界面骨架：进入页 / 房间顶栏 / 成员列表 / 共享控制 / 设置与关于等弹窗
import { $, $$, el, toast, copyText, storage, fmtDuration } from './core.js';
import { PRESETS } from './screenshare.js';

export function showScreen(name) {
  $('#screen-lobby').hidden = name !== 'lobby';
  $('#screen-room').hidden = name !== 'room';
}

export function setConnStatus(ok, text) {
  const node = $('#conn-status');
  node.textContent = ok ? '● 已连接' : '● 连接中断';
  node.className = 'conn-status ' + (ok ? 'ok' : 'bad');
  if (text) node.textContent = text;
}

export function renderLobbyServer(text) {
  const node = $('#lobby-server');
  if (node) node.textContent = text;
}

export function showLobbyError(msg) {
  const node = $('#lobby-error');
  node.textContent = msg || '';
  node.hidden = !msg;
}

// ── 成员列表 ──
export function renderMembers(members, meId, focused, onFocus) {
  const list = $('#member-list');
  if (!list) return;
  $('#member-count').textContent = members.length;
  list.innerHTML = '';
  for (const m of members) {
    const isMe = m.id === meId;
    const li = el('li', {
      class: 'member-item' + (isMe ? ' me' : '') + (focused === m.id ? ' focused' : ''),
      onclick: () => onFocus?.(m.id),
      title: isMe ? '我' : '点击聚焦该成员的画面',
    },
      el('span', { class: 'member-avatar', text: (m.username || '?').slice(0, 1).toUpperCase() }),
      el('span', { class: 'member-name', text: m.username + (isMe ? '（我）' : '') }),
    );
    if (m.share) {
      const cinema = m.share.mode === 'cinema';
      li.append(el('span', {
        class: 'badge ' + (cinema ? 'cinema' : 'live'),
        text: cinema ? '影院' : '共享中',
      }));
    }
    list.append(li);
  }
}

// ── 共享控制 ──
export function initPresetOptions() {
  const sel = $('#preset-select');
  const saved = storage.get('preset', 'auto');
  sel.innerHTML = '';
  for (const [key, p] of Object.entries(PRESETS)) {
    sel.append(el('option', { value: key, text: p.label }));
  }
  sel.value = PRESETS[saved] ? saved : 'auto';
  return sel;
}

export function shareControlState({ sharing, pending, mode, preset, statusText }) {
  const btn = $('#btn-share');
  if (btn) {
    btn.disabled = !!pending;
    btn.classList.toggle('sharing', !!sharing);
    btn.textContent = pending ? '⏳ 准备中…' : sharing ? '⏹ 停止共享' : '🖥️ 共享屏幕';
  }
  const link = $('#link-mode');
  if (link) link.disabled = !!sharing;
  const presetSel = $('#preset-select');
  if (presetSel) presetSel.disabled = !!pending;
  const audio = $('#share-audio');
  if (audio) audio.disabled = !!sharing;
  const status = $('#share-status');
  if (status) status.textContent = statusText || '';
}

export function setUplinkInfo(text) {
  const node = $('#uplink-info');
  if (node) node.textContent = text || '';
}

export function renderRoomInfo({ version, mode, code }) {
  const where = mode === 'cloud'
    ? `☁️ 云房间${code ? ' · ' + code : ''}`
    : (mode === 'remote' ? '连接朋友的房间' : '本机房间');
  $('#room-info').textContent = `v${version} · ${where} · 画面端到端加密`;
}

// ── 帮助下拉 ──
export function wireHelpDropdown(handlers) {
  const wrap = document.querySelector('.dropdown-wrap');
  const btn = $('#btn-help');
  const menu = $('#menu-help');
  btn?.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', () => { if (menu) menu.hidden = true; });
  menu?.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    menu.hidden = true;
    handlers[b.dataset.action]?.();
  });
}

// ── 设置弹窗 ──
export function loadSettingsIntoForm(settings) {
  $('#set-link-mode').value = settings.linkMode === 'cinema' ? 'cinema' : 'webrtc';
  $('#set-codec').value = settings.codecPreference === 'compat' ? 'compat' : 'auto';
  $('#set-uplink').value = String(settings.uplinkMbps);
  $('#set-aspect').value = settings.aspect || 'auto';
}

export function readSettingsForm() {
  return {
    linkMode: $('#set-link-mode').value === 'cinema' ? 'cinema' : 'webrtc',
    codecPreference: $('#set-codec').value === 'compat' ? 'compat' : 'auto',
    uplinkMbps: Number($('#set-uplink').value) || 0,
    aspect: $('#set-aspect').value || 'auto',
  };
}

export function renderEnvInfo(env) {
  const node = $('#about-env');
  if (!node) return;
  const rows = [
    ['安全上下文', env.secure ? '是' : '否'],
    ['屏幕采集', env.capture ? '可用' : `不可用${env.blockReason ? ' — ' + env.blockReason : ''}`],
    ['WebCodecs 影院模式', env.webcodecs?.encode && env.webcodecs?.decode ? '可用' : '不可用'],
    ['WebRTC 编码器', (env.webrtcCodecs || []).map((c) => c.replace('video/', '')).join(' / ') || '未知'],
    ['设备形态', env.electron ? '桌面版' : env.mobile ? (env.ios ? 'iOS' : '移动端') : '桌面浏览器'],
    ['逻辑核心', String(env.hardwareConcurrency || '—')],
  ];
  node.innerHTML = '';
  for (const [k, v] of rows) {
    node.append(el('div', {}, el('span', { text: k + '：' }), el('b', { text: v })));
  }
}

// ── 服务器设置（桌面版）──
export function fillServerForm(cfg, isDesktop) {
  const local = $('#server-mode-local');
  const remote = $('#server-mode-remote');
  $('#server-port').value = cfg.port || 3000;
  $('#server-address').value = cfg.address || '';
  if (!isDesktop) {
    local.checked = true;
    remote.disabled = true;
    $('#server-port-field').hidden = true;
    $('#server-address-field').hidden = true;
    $('#server-local-urls').textContent = `当前服务器：${location.origin}（浏览器版直接访问目标地址即可）`;
    return;
  }
  local.checked = cfg.mode !== 'remote';
  remote.checked = cfg.mode === 'remote';
  $('#server-port-field').hidden = cfg.mode === 'remote';
  $('#server-address-field').hidden = cfg.mode !== 'remote';
  const urls = cfg.localUrls || [];
  const box = $('#server-local-urls');
  box.innerHTML = '';
  if (!urls.length) box.textContent = '（未检测到可访问地址）';
  for (const u of urls) box.append(linkRow('本机', u));
}

export function readServerForm() {
  const mode = $('#server-mode-remote').checked ? 'remote' : 'local';
  return { mode, address: $('#server-address').value.trim(), port: Number($('#server-port').value) || 3000 };
}

export function linkRow(kind, url, { onCopy } = {}) {
  const row = el('div', { class: 'link-row' },
    el('span', { class: 'link-kind', text: kind }),
    el('span', { class: 'link-url', text: url }),
    el('button', {
      class: 'btn small',
      text: '复制',
      onclick: async () => {
        const ok = await copyText(url);
        toast(ok ? '已复制：' + url : '复制失败，请手动复制', { kind: ok ? 'ok' : 'error' });
        onCopy?.(url);
      },
    }),
  );
  return row;
}
