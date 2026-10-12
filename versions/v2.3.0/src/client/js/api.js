// api.js — 服务器接口（配置 / ICE / 网络诊断 / 二维码）
async function getJson(url, { timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function fetchConfig() {
  return getJson('/api/config', { timeoutMs: 5000 });
}

/** 拉取本次会话的 ICE 配置（TURN 凭据临时签发；服务端按请求主机自动匹配可达地址） */
export function fetchIce(user = '') {
  return getJson(`/api/ice${user ? `?user=${encodeURIComponent(user)}` : ''}`, { timeoutMs: 6000 });
}

export function fetchNetworkReport({ deep = false } = {}) {
  return getJson(`/api/network${deep ? '?deep=1' : ''}`, { timeoutMs: deep ? 25_000 : 8000 });
}

export function qrSvgUrl(text) {
  return `/api/qr.svg?text=${encodeURIComponent(text)}`;
}

export function health() {
  return getJson('/api/health', { timeoutMs: 5000 });
}
