// net/turn.js — 内嵌 STUN/TURN 中继服务（纯 JS，零外置依赖）
// 作用：对称 NAT / 严格防火墙下媒体自动走中继，保证「一定能看到画面」；中继内容仍是 DTLS-SRTP 加密。
import { createServer } from 'turn-server';
import { createHmac, randomUUID } from 'node:crypto';
import { logger } from '../logger.js';

const DEFAULT_RELAY_RANGE = [42000, 42011];

/**
 * 生成 TURN REST 临时凭据（RFC 草案通用做法：HMAC-SHA1(secret, "expiry:user")）
 * 客户端把它填进 iceServers，过期自动失效，无需固定账号密码。
 */
export function makeTurnCredentials(secret, { ttlSec = 4 * 3600, user = '' } = {}) {
  const expiry = Math.floor(Date.now() / 1000) + ttlSec;
  const username = `${expiry}:${user || randomUUID().slice(0, 8)}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, ttlSec, expiresAt: expiry };
}

/**
 * 启动内嵌 TURN 服务（UDP + TCP，端口被占用时自动顺延）。
 * @returns {Promise<{ok:boolean, port:number|null, error:string|null, stats:Function, stop:Function, relayRange:number[]}>}
 */
export async function startTurnServer(opts = {}) {
  const {
    port = Number(process.env.TURN_PORT || 3478),
    relayPortRange = DEFAULT_RELAY_RANGE,
    externalIp = null,
    lanIp = null,
    secret = null,
    userQuota = 32,
    totalQuota = 128,
  } = opts;
  if (!secret) return { ok: false, port: null, error: '缺少 TURN 密钥', stats: () => ({}), stop: async () => {}, relayRange: relayPortRange };

  let server;
  try {
    server = createServer({
      software: 'Gracs',
      auth: { mechanism: 'long-term', realm: 'gracs', secret },
      // 中继套接字绑定全部网卡（LAN / 本机回环 / NAT 映射都能收到）；
      // 对外通告地址按分配来源自动选择，避免多网卡/虚拟网卡（VPN）环境通告错误地址。
      relay: { ip: '0.0.0.0', externalIp: externalIp || undefined, portRange: relayPortRange },
      // 允许本机回环对端：同一台电脑双开观看（或主机自己观看）时，中继地址就是 127.0.0.1。
      // 这不影响安全模型：中继仍要求 HMAC 临时凭据 + 配额限制，仅服务本房间成员。
      allowLoopback: true,
      relayCallback: (info, cb) => {
        const src = String(info?.source?.ip || '');
        let advertise = externalIp || null;
        if (!advertise) {
          if (src === '127.0.0.1' || src === '::1' || src === '0:0:0:0:0:0:0:1') advertise = '127.0.0.1';
          else if (lanIp) advertise = lanIp;
        }
        cb({ ip: '0.0.0.0', externalIp: advertise || undefined, portRange: relayPortRange });
      },
      userQuota,
      totalQuota,
      idleTimeout: 120_000,
      maxDataSize: 65_535,
    });
  } catch (err) {
    logger.error('[turn] 初始化失败:', err?.message || err);
    return { ok: false, port: null, error: err?.message || String(err), stats: () => ({}), stop: async () => {}, relayRange: relayPortRange };
  }

  server.on('error', (err) => logger.debug('[turn] 服务错误:', err?.message || err));
  server.on('authenticate', (_username, _realm, cb) => cb(null)); // REST 凭据由 secret 校验，无需回调
  server.on('auth:failure', (_sock, info) => logger.debug('[turn] 鉴权失败:', JSON.stringify(info)));
  server.on('allocate', (_sock, allocation) => {
    logger.debug(`[turn] 分配中继 ${allocation?.relayAddress?.ip}:${allocation?.relayAddress?.port} 用户=${allocation?.username || '?'}`);
  });

  // 端口占用时顺延（最多 10 次）
  for (let attempt = 0; attempt < 10; attempt++) {
    const tryPort = port + attempt;
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off?.('error', onError);
          reject(err);
        };
        server.on('error', onError);
        server.listen(
          [
            { port: tryPort, transport: 'udp' },
            { port: tryPort, transport: 'tcp' },
          ],
          () => {
            server.off?.('error', onError);
            resolve();
          },
        );
      });
      logger.work(`[turn] 中继服务已启动 UDP/TCP :${tryPort}（中继端口段 ${relayPortRange[0]}-${relayPortRange[1]}，外部 IP ${externalIp || '未设置'}）`);
      return {
        ok: true,
        port: tryPort,
        error: null,
        relayRange: relayPortRange,
        stats: () => server.getStats(),
        stop: () =>
          new Promise((resolve) => {
            const timer = setTimeout(resolve, 1500);
            try { server.stop(() => { clearTimeout(timer); resolve(); }); } catch { clearTimeout(timer); resolve(); }
          }),
      };
    } catch (err) {
      if (err?.code === 'EADDRINUSE') {
        logger.debug(`[turn] 端口 ${tryPort} 被占用，尝试 ${tryPort + 1}`);
        continue;
      }
      logger.error('[turn] 启动失败:', err?.message || err);
      return { ok: false, port: null, error: err?.message || String(err), stats: () => ({}), stop: async () => {}, relayRange: relayPortRange };
    }
  }
  return { ok: false, port: null, error: 'TURN 端口连续被占用', stats: () => ({}), stop: async () => {}, relayRange: relayPortRange };
}
