// core.js — DOM 辅助 / 弹窗 / Toast / 本地存储 / 小工具
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// ── Toast ──
let toastTimer = null;
export function toast(msg, { ms = 3400, kind = 'info' } = {}) {
  const box = $('#toast-box') || document.body;
  const item = el('div', { class: `toast toast-${kind}`, text: msg });
  box.append(item);
  requestAnimationFrame(() => item.classList.add('show'));
  setTimeout(() => {
    item.classList.remove('show');
    setTimeout(() => item.remove(), 240);
  }, ms);
  return item;
}

// ── 弹窗 ──
export function openModal(id) {
  const modal = typeof id === 'string' ? $(id) : id;
  if (!modal) return;
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add('open'));
}
export function closeModal(id) {
  const modal = typeof id === 'string' ? $(id) : id;
  if (!modal) return;
  modal.classList.remove('open');
  setTimeout(() => { modal.hidden = true; }, 160);
}
export function wireModalDismiss(modalId) {
  const modal = $(modalId);
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeModal(modal);
  });
}
export function wireAllModalDismiss() {
  $$('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) closeModal(m); }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $$('.modal.open').forEach((m) => closeModal(m));
  });
}

// ── 本地存储 ──
const PREFIX = 'gs2:';
export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* 忽略 */ }
  },
  del(key) {
    try { localStorage.removeItem(PREFIX + key); } catch { /* 忽略 */ }
  },
};

// ── 格式化 ──
export function fmtBitrate(bps) {
  if (!bps || bps < 0) return '—';
  if (bps >= 1_000_000) return (bps / 1_000_000).toFixed(1) + ' Mbps';
  if (bps >= 1000) return Math.round(bps / 1000) + ' kbps';
  return Math.round(bps) + ' bps';
}
export function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(i ? 1 : 0) + ' ' + units[i];
}
export function fmtDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
export function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

// ── 复制 ──
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const ta = el('textarea', { style: { position: 'fixed', opacity: '0' } });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    return true;
  } catch { return false; }
}

// ── 迷你折线图（统计面板用） ──
export function sparkline(canvas, values, { color = '#6ee7ff', max = null, fill = true } = {}) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 120;
  const h = canvas.clientHeight || 32;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!values?.length) return;
  const peak = max || Math.max(...values, 1);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = i * step;
    const y = h - 2 - (clamp(v / peak, 0, 1) * (h - 6));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.stroke();
  if (fill) {
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, color + '44');
    grad.addColorStop(1, color + '00');
    ctx.fillStyle = grad;
    ctx.fill();
  }
}

// ── URL 参数 ──
export function urlParam(name) {
  return new URLSearchParams(location.search).get(name);
}
export function setUrlParams(params) {
  const url = new URL(location.href);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  }
  history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
}

export function debounce(fn, ms = 200) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
