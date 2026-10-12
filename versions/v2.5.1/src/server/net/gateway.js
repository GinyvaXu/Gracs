// net/gateway.js — 网关端口映射（UPnP-IGD / NAT-PMP / PCP）
// 目标：开房者无需任何外置软件，自动把 信令端口(TCP) 与 中继端口(UDP) 映射到公网。
// 说明：best-effort —— 没有网关 / 未开 UPnP / CGNAT 时如实返回失败原因，不影响本地/局域网使用。
import { upnpNat, pmpNat } from '@achingbrain/nat-port-mapper';
import { exec } from 'node:child_process';
import { logger } from '../logger.js';

const DEFAULT_TTL_MS = 60 * 60 * 1000;      // 映射租约 1 小时
const DISCOVERY_TIMEOUT_MS = 5000;          // 网关发现超时（无网关时快速失败）
const RENEW_INTERVAL_MS = 20 * 60 * 1000;   // 租约续期频率

/**
 * 启动网关端口映射。
 * @param {object} opts
 * @param {Array<{port:number, protocol:'tcp'|'udp', description?:string}>} opts.ports
 * @param {string} [opts.localAddress] 指定映射到哪个本机地址（默认由库决定）
 * @param {number} [opts.ttlMs]
 * @returns {Promise<{ok:boolean, externalIp:string|null, mappings:Array, error:string|null, stop:Function}>}
 */
export async function startGatewayMapping(opts = {}) {
  const ports = Array.isArray(opts.ports) ? opts.ports : [];
  const state = {
    ok: false,
    externalIp: null,
    mappings: [],
    error: null,
    via: null,
    closed: false,
    renewTimer: null,
    gateway: null,
  };
  const stop = async () => {
    state.closed = true;
    if (state.renewTimer) clearInterval(state.renewTimer);
    for (const m of state.mappings) {
      try { await state.gateway?.unmap(m.internalPort); } catch { /* 忽略 */ }
    }
    try { await state.gateway?.stop(); } catch { /* 忽略 */ }
    logger.debug('[gateway] 映射已清理');
  };

  if (!ports.length) return { ...state, stop };

  try {
    const gateway = await discoverGateway();
    if (!gateway) {
      state.error = '未发现支持 UPnP/NAT-PMP 的路由器（可在路由器里开启 UPnP，或改用 IPv6/组网）';
      return { ...state, stop };
    }
    state.gateway = gateway;

    try {
      state.externalIp = await gateway.externalIp();
    } catch (err) {
      logger.debug('[gateway] 获取外部 IP 失败:', err?.message || err);
    }

    for (const p of ports) {
      try {
        const mapping = await gateway.map(p.port, opts.localAddress, {
          protocol: p.protocol,
          description: p.description || 'Gracs',
          ttl: opts.ttlMs || DEFAULT_TTL_MS,
        });
        state.mappings.push({
          internalPort: mapping.internalPort,
          externalPort: mapping.externalPort,
          protocol: p.protocol,
          externalIp: mapping.externalHost || null,
          via: mapping.via || 'upnp',
        });
        logger.work(`[gateway] 端口映射成功 ${p.protocol.toUpperCase()} ${mapping.internalHost || ''}:${mapping.internalPort} ↔ 公网 ${mapping.externalHost || '?'}:${mapping.externalPort} (${mapping.via})`);
      } catch (err) {
        logger.work(`[gateway] 端口映射失败 ${p.protocol.toUpperCase()} ${p.port}: ${err?.message || err}`);
        if (!state.error) state.error = `端口 ${p.port} 映射失败：${err?.message || err}`;
      }
    }

    state.ok = state.mappings.length > 0;
    if (state.ok) {
      state.via = state.mappings[0].via;
      // 租约续期：定期重新映射（保持公网入口不失效）
      state.renewTimer = setInterval(() => { renew(gateway, ports, opts, state); }, RENEW_INTERVAL_MS);
      state.renewTimer.unref?.();
    }
  } catch (err) {
    state.error = err?.message || String(err);
    logger.work('[gateway] 初始化失败:', state.error);
  }
  return { ...state, stop };
}

async function discoverGateway() {
  logger.debug('[gateway] 开始发现路由器…');
  const upnp = upnpNat();
  try {
    for await (const gateway of upnp.findGateways({ signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) })) {
      logger.work('[gateway] 发现 UPnP 网关:', gateway.host || gateway);
      return gateway;
    }
  } catch (err) {
    logger.debug('[gateway] UPnP 发现失败:', err?.message || err);
  }
  // 兜底：NAT-PMP（部分路由器只开 PMP）；网关地址从本机默认路由推断
  try {
    const gwIp = await guessGatewayIPv4();
    if (gwIp) {
      logger.debug('[gateway] 尝试 NAT-PMP:', gwIp);
      return pmpNat(gwIp);
    }
  } catch (err) {
    logger.debug('[gateway] NAT-PMP 初始化失败:', err?.message || err);
  }
  return null;
}

async function renew(gateway, ports, opts, state) {
  if (state.closed) return;
  for (const p of ports) {
    try {
      await gateway.map(p.port, opts.localAddress, {
        protocol: p.protocol,
        description: p.description || 'Gracs',
        ttl: opts.ttlMs || DEFAULT_TTL_MS,
      });
      logger.debug(`[gateway] 已续期 ${p.protocol}/${p.port}`);
    } catch (err) {
      logger.work(`[gateway] 续期失败 ${p.protocol}/${p.port}:`, err?.message || err);
    }
  }
}

/** Windows/Linux 通用：从默认路由推断网关 IPv4（失败返回 null） */
function guessGatewayIPv4() {
  return new Promise((resolve) => {
    try {
      const cmd = process.platform === 'win32' ? 'route print -4' : 'ip route';
      exec(cmd, { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        if (process.platform === 'win32') {
          const m = stdout.match(/0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/);
          resolve(m ? m[1] : null);
        } else {
          const m = stdout.match(/default via (\d+\.\d+\.\d+\.\d+)/);
          resolve(m ? m[1] : null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}
