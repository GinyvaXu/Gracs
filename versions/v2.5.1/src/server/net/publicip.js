// net/publicip.js — 公网地址探测（STUN）与 NAT 类型判断
// 用途：① 诊断面板告诉用户「你是否有公网入口」；② TURN 中继把外部 IP 告诉对端。
import { getPublicIP, detectNAT } from 'turn-server';
import { classifyExternal, lanIPv4List } from './interfaces.js';
import { logger } from '../logger.js';

// 默认 STUN 服务器：优先国内可达（小米 / 腾讯），再兜底国际（Cloudflare / Google）
export const DEFAULT_STUN_SERVERS = [
  'stun.miwifi.com:3478',
  'stun.cloudflare.com:3478',
  'stun.l.google.com:19302',
];

export function stunListFromEnv() {
  const env = process.env.STUN_SERVERS;
  if (!env) return DEFAULT_STUN_SERVERS;
  return env.split(',').map((s) => s.trim()).filter(Boolean);
}

/** 通过 STUN 探测本机在公网侧的映射地址（失败返回 null，不抛异常） */
export function probePublicAddress({ servers = stunListFromEnv(), timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    let idx = 0;
    const tryNext = () => {
      if (idx >= servers.length) return resolve({ ok: false, error: '所有 STUN 服务器均不可达（UDP 可能被网络屏蔽）' });
      const server = servers[idx++];
      const url = /^stun:/i.test(server) ? server : `stun:${server}`;
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        tryNext();
      }, timeoutMs + 500);
      try {
        getPublicIP(url, { timeout: timeoutMs }, (err, address) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (err || !address?.ip) {
            logger.debug(`[publicip] ${server} 失败:`, err?.message || 'no address');
            return tryNext();
          }
          resolve({
            ok: true,
            ip: address.ip,
            port: address.port,
            family: address.family === 2 ? 6 : 4,
            server,
            kind: address.family === 2 ? 'ipv6' : classifyExternal(address.ip, lanIPv4List()),
          });
        });
      } catch (err) {
        done = true;
        clearTimeout(timer);
        logger.debug(`[publicip] ${server} 异常:`, err?.message || err);
        tryNext();
      }
    };
    tryNext();
  });
}

/** NAT 行为类型（RFC 5780，需要 STUN 服务器支持 CHANGE-REQUEST；失败返回 unknown） */
export function probeNatType({ servers = stunListFromEnv(), timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const server = servers.find((s) => /google|cloudflare|miwifi/i.test(s)) || servers[0];
    const url = /^stun:/i.test(server) ? server : `stun:${server}`;
    try {
      const timer = setTimeout(() => resolve({ ok: false, type: 'unknown', error: '超时' }), timeoutMs + 1500);
      detectNAT(url, { timeout: timeoutMs }, (err, result) => {
        clearTimeout(timer);
        if (err || !result) return resolve({ ok: false, type: 'unknown', error: err?.message || '无结果' });
        resolve({ ok: true, type: result.type, mapped: result.mappedAddress, other: result.otherAddress });
      });
    } catch (err) {
      resolve({ ok: false, type: 'unknown', error: err?.message || String(err) });
    }
  });
}
