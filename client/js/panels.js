// panels.js — 邀请/二维码 / 网络诊断 / 连接质量面板 / 共享源选择
import { $, el, toast, copyText, sparkline, fmtBitrate } from './core.js';
import { qrSvgUrl } from './api.js';
import { linkRow } from './ui.js';
import { describeLimit } from './stats.js';

// ── 邀请（地址列表 + 二维码）──
export function renderInvite({ urls, primary }) {
  const box = $('#invite-links');
  box.innerHTML = '';
  if (!urls.length) {
    box.append(linkRow('当前', location.origin));
  } else {
    for (const item of urls) box.append(linkRow(item.label || item.kind, item.url));
  }
  const qr = $('#invite-qr');
  qr.src = qrSvgUrl(primary || urls[0]?.url || location.origin);
  $('#invite-qr').alt = '扫码加入 ' + (primary || '');
}

export function renderQrModal(url) {
  $('#room-qr').src = qrSvgUrl(url);
  $('#qr-room-url').textContent = url;
  $('#btn-qr-copy').onclick = async () => {
    const ok = await copyText(url);
    toast(ok ? '链接已复制' : '复制失败', { kind: ok ? 'ok' : 'error' });
  };
}

// ── 网络诊断 ──
const LEVEL_ICON = { ok: '✅', warn: '⚠️', bad: '⛔', info: 'ℹ️' };

export function renderNetworkReport(report, { onDeep, onRefresh } = {}) {
  const verdictBox = $('#network-verdict');
  verdictBox.innerHTML = '';
  for (const item of report.verdict || []) {
    verdictBox.append(el('div', { class: `verdict ${item.level}` },
      el('span', { class: 'icon', text: LEVEL_ICON[item.level] || 'ℹ️' }),
      el('div', {},
        el('div', { class: 'title', text: item.title }),
        el('div', { class: 'detail', text: item.detail }),
      ),
    ));
  }
  const detail = $('#network-detail');
  detail.innerHTML = '';
  const rows = [];
  const addrs = report.addresses || {};
  if (addrs.lan?.length) rows.push(['局域网地址', addrs.lan.join(' , ')]);
  if (addrs.ipv6?.length) rows.push(['IPv6 地址', addrs.ipv6.slice(0, 2).join(' , ')]);
  if (addrs.https?.lan?.length) rows.push(['HTTPS 地址', addrs.https.lan[0]]);
  if (report.gateway) {
    rows.push(['路由器映射', report.gateway.ok ? `成功（${report.gateway.via || 'UPnP'}）→ ${report.gateway.publicUrl || '已建立'}` : `未生效：${report.gateway.error || '未知原因'}`]);
  }
  if (report.turn) {
    rows.push(['内嵌中继', report.turn.running ? `运行中 :${report.turn.port}（中继端口段 ${report.turn.relayRange?.join('-') || '—'}）` : '未运行']);
  }
  if (report.nat) {
    rows.push(['公网出口', report.nat.publicIp ? `${report.nat.publicIp}（${report.nat.natType}）` : (report.nat.error || '未探测')]);
  }
  for (const [k, v] of rows) detail.append(el('div', {}, el('span', { text: k + '：' }), el('b', { text: v })));
  if (onDeep) $('#btn-network-deep').onclick = onDeep;
  if (onRefresh) $('#btn-network-refresh').onclick = onRefresh;
}

// ── 连接质量面板 ──
const history = new Map();   // id -> { bitrate: [], fps: [] }

function pushHistory(id, sample) {
  const h = history.get(id) || { bitrate: [], fps: [] };
  if (sample.bitrate) h.bitrate.push(sample.bitrate);
  if (sample.fps) h.fps.push(sample.fps);
  while (h.bitrate.length > 48) h.bitrate.shift();
  while (h.fps.length > 48) h.fps.shift();
  history.set(id, h);
  return h;
}

export function renderStats(samples, { names = new Map(), sharing = false, encoder = null, cinema = [] } = {}) {
  const body = $('#stats-body');
  if (!body) return;
  body.innerHTML = '';

  if (sharing && encoder) {
    body.append(el('div', { class: 'stat-card' },
      el('h4', {}, el('span', { text: '📤 我正在共享' })),
      el('div', { class: 'stat-rows' },
        el('span', { text: '链路模式' }), el('b', { text: encoder.mode === 'cinema' ? '影院（WebCodecs）' : '标准（WebRTC）' }),
        el('span', { text: '编码器' }), el('b', { text: `${encoder.codec || '—'}${encoder.hw ? ' · 硬件' : ''}` }),
        el('span', { text: '实际输出' }), el('b', { text: `${encoder.kbps || 0} kbps · ${encoder.fps || 0} fps` }),
        ...(encoder.targetKbps ? [el('span', { text: '当前目标' }), el('b', { text: `${encoder.targetKbps} kbps` })] : []),
        ...(encoder.dropped ? [el('span', { text: '累计丢帧' }), el('b', { text: String(encoder.dropped) })] : []),
      ),
    ));
  }

  // 影院模式（WebSocket 中继）观看卡片
  for (const item of cinema) {
    const s = item.stats || {};
    body.append(el('div', { class: 'stat-card' },
      el('h4', {},
        el('span', { text: `🎬 ${item.name}（影院）` }),
        el('span', { class: 'badge ' + ((s.fps || 0) > 20 ? 'live' : ''), text: (s.fps || 0) > 20 ? '流畅' : (s.fps || 0) > 0 ? '受限' : '等待中' }),
      ),
      el('div', { class: 'stat-rows' },
        el('span', { text: '分辨率' }), el('b', { text: s.width && s.height ? `${s.width}×${s.height}` : '—' }),
        el('span', { text: '帧率' }), el('b', { text: s.fps ? s.fps + ' fps' : '—' }),
        el('span', { text: '码率' }), el('b', { text: s.kbps ? s.kbps + ' kbps' : '—' }),
        el('span', { text: '解码耗时' }), el('b', { text: s.decodeMs != null ? s.decodeMs + ' ms' : '—' }),
        el('span', { text: '已显示帧' }), el('b', { text: String(s.displayed ?? s.decoded ?? 0) }),
        el('span', { text: '丢帧' }), el('b', { text: String(s.dropped ?? 0) }),
        el('span', { text: '缓冲' }), el('b', { text: s.buffer != null ? s.buffer + ' 帧' : (s.suspended ? '暂停（页面不可见）' : '—') }),
      ),
    ));
  }

  const outEntries = [...(samples?.out || new Map()).entries()];
  const inEntries = [...(samples?.in || new Map()).entries()];
  const entries = sharing ? outEntries : inEntries;

  if (!entries.length) {
    body.append(el('div', { class: 'dim', style: { padding: '6px 2px' } },
      sharing ? '还没有观看者接入，共享开始后这里会显示每位观看者的实时质量。' : '等待画面接入…'));
    return;
  }

  for (const [id, s] of entries) {
    if (!s) continue;
    const h = pushHistory(id, s);
    const name = names.get(id) || (sharing ? '观看者' : '好友');
    const card = el('div', { class: 'stat-card' },
      el('h4', {},
        el('span', { text: (sharing ? '👁 ' : '🖥 ') + name }),
        el('span', { class: 'badge ' + (s.level === 'good' ? 'live' : ''), text: s.level === 'good' ? '良好' : s.level === 'fair' ? '一般' : '受限' }),
      ),
      el('div', { class: 'stat-rows' },
        el('span', { text: '分辨率' }), el('b', { text: s.width && s.height ? `${s.width}×${s.height}` : '—' }),
        el('span', { text: '帧率' }), el('b', { text: s.fps ? s.fps + ' fps' : '—' }),
        el('span', { text: '码率' }), el('b', { text: fmtBitrate(s.bitrate) }),
        el('span', { text: '延迟 RTT' }), el('b', { text: s.rtt != null ? Math.round(s.rtt * 1000) + ' ms' : '—' }),
        el('span', { text: '丢包' }), el('b', { text: (s.loss ?? 0).toFixed(1) + ' %' }),
        el('span', { text: '链路' }), el('b', { text: s.relay ? '中继（TURN）' : 'P2P 直连' }),
        el('span', { text: '拥塞原因' }), el('b', { text: describeLimit(s.limit) }),
        el('span', { text: '编码' }), el('b', { text: s.codec || '—' }),
      ),
    );
    const canvas = el('canvas', { class: 'spark' });
    card.append(canvas);
    body.append(card);
    requestAnimationFrame(() => sparkline(canvas, h.bitrate, { color: s.level === 'poor' ? '#f4645f' : s.level === 'fair' ? '#f0b429' : '#4dd4c8' }));
  }
  if (samples?.at) {
    body.append(el('div', { class: 'dim', style: { fontSize: '11px', textAlign: 'right' } }, `更新于 ${new Date(samples.at).toLocaleTimeString()}`));
  }
}

export function clearStatsHistory() {
  history.clear();
}

// ── 共享源选择（桌面版内置选择器）──
export function renderSourcePicker(list, onPick) {
  const grid = $('#source-picker-grid');
  grid.innerHTML = '';
  for (const s of list) {
    const card = el('button', {
      class: 'source-card',
      onclick: () => onPick?.(s.id),
    },
      el('div', { class: 'source-thumb' }, s.thumbnail ? el('img', { src: s.thumbnail, alt: '' }) : (s.type === 'screen' ? '🖥️' : '🪟')),
      el('span', { class: 'source-name', text: s.name }),
      el('span', { class: 'source-type', text: s.type === 'screen' ? '整个屏幕' : '窗口' }),
    );
    grid.append(card);
  }
}
