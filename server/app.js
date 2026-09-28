// app.js — 服务器启动函数（CLI 与 Electron 桌面壳共用）
// v2.0：内置 STUN/TURN 中继 + UPnP/NAT-PMP 自动端口映射 + IPv6/局域网直连 + 网络诊断 + 影院模式中继
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { Server } from 'socket.io';
import qrcode from 'qrcode-generator';
import { RoomManager, MAX_USERS_PER_ROOM } from './rooms.js';
import { setupSignaling } from './signaling.js';
import { logger } from './logger.js';
import { getCertificate } from './net/tls.js';
import { startTurnServer, makeTurnCredentials } from './net/turn.js';
import { startGatewayMapping } from './net/gateway.js';
import { createDoctor } from './net/doctor.js';
import { stunListFromEnv } from './net/publicip.js';
import { lanIPv4List, globalIPv6List, pickPrimaryLanIPv4 } from './net/interfaces.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── 版本号（客户端「关于」显示，读自 VERSION 单一来源）──
let version = '0.0.0';
try { version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim(); } catch { /* 快照缺失时用默认值 */ }

/**
 * 启动 GinyScreen 服务器
 * @param {object} opts
 * @param {number}  [opts.port=3000]           HTTP 监听端口
 * @param {number}  [opts.httpsPort]           HTTPS 监听端口（默认 port+1；null/0 = 不启用）
 * @param {string}  [opts.host='::']           监听地址（默认双栈）
 * @param {boolean} [opts.enableHttps=true]    是否尝试启用 HTTPS（本地自动生成自签名证书）
 * @param {boolean} [opts.enableTurn=true]     是否启用内嵌 TURN 中继
 * @param {number}  [opts.turnPort=3478]       TURN 端口
 * @param {[number,number]} [opts.relayPortRange] TURN 中继端口段
 * @param {boolean} [opts.enableGateway=true]  是否尝试 UPnP/NAT-PMP 端口映射
 * @param {Array}   [opts.iceServers]          额外 ICE 服务器（环境变量注入）
 * @param {boolean} [opts.retryOnBusy=false]   端口占用时自动 +1 重试
 * @param {Function}[opts.onNetworkReady]      网络初始化完成回调（桌面壳可用于刷新状态）
 * @returns {Promise<object>} 服务器句柄 { server, httpsServer, io, app, port, httpsPort, network, doctor, stop }
 */
export async function startGinyScreenServer(opts = {}) {
  const port = opts.port ?? 3000;
  const host = opts.host ?? '::';
  const enableHttps = opts.enableHttps ?? true;
  const enableTurn = opts.enableTurn ?? true;
  const enableGateway = opts.enableGateway ?? true;
  const retryOnBusy = opts.retryOnBusy ?? false;
  const extraIceServers = Array.isArray(opts.iceServers) ? opts.iceServers : [];
  const stunServers = stunListFromEnv();
  const relayPortRange = opts.relayPortRange || [42000, 42011];

  // ── 状态（doctor / 配置接口读取）──
  const network = {
    gateway: null,
    turn: { running: false, port: null, externalIp: null, relayRange: relayPortRange, stats: null },
    turnSecret: loadOrCreateTurnSecret(),
    iceExtra: extraIceServers,
  };

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const isStatic = /^\/(js|css|vendor|assets|favicon|manifest|sw)/.test(req.path);
    res.on('finish', () => {
      if (!isStatic) logger.debug(`HTTP ${req.method} ${req.originalUrl} -> ${res.statusCode}`);
    });
    next();
  });

  // ── 客户端 index.html：注入版本号，避免缓存旧页面 ──
  const indexTemplatePath = join(ROOT, 'client', 'index.html');
  let indexCache = { mtimeMs: 0, html: '' };
  function renderIndex() {
    try {
      const st = statSync(indexTemplatePath);
      if (st.mtimeMs !== indexCache.mtimeMs) {
        indexCache = { mtimeMs: st.mtimeMs, html: readFileSync(indexTemplatePath, 'utf8') };
      }
    } catch { /* 保持旧缓存 */ }
    return indexCache.html.replaceAll('__VERSION__', version);
  }

  app.get(['/', '/index.html'], (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(renderIndex());
  });

  app.use(express.static(join(ROOT, 'client'), { index: false }));
  app.use('/vendor/socket.io', express.static(join(ROOT, 'node_modules', 'socket.io', 'client-dist')));

  // ── 配置：版本 / 能力 / 限制 / STUN 列表 ──
  app.get('/api/config', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.json({
      version,
      room: 'main',
      maxUsers: MAX_USERS_PER_ROOM,
      stunServers,
      turn: { enabled: enableTurn, port: network.turn.port || opts.turnPort || Number(process.env.TURN_PORT || 3478) },
      features: {
        cinema: true,
        webcodecs: true,
        pwa: true,
        gateway: enableGateway,
      },
    });
  });

  // ── ICE 配置：按请求主机拼装（局域网 / IPv6 / 公网自动匹配），TURN 凭据临时签发 ──
  app.get('/api/ice', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(buildIceConfig(req));
  });

  function buildIceConfig(req) {
    const reqHost = hostFromRequest(req);
    const servers = [];
    // 自有 STUN（TURN 同端口）：对观看者而言是「外部」服务器，可探测其公网映射
    if (network.turn.port) servers.push({ urls: `stun:${reqHost}:${network.turn.port}` });
    for (const s of stunServers) servers.push({ urls: /^stun:/i.test(s) ? s : `stun:${s}` });
    if (network.turn.running && network.turn.port) {
      const cred = makeTurnCredentials(network.turnSecret, { user: String(req.query.user || '').slice(0, 24) });
      servers.push({
        urls: [
          `turn:${reqHost}:${network.turn.port}?transport=udp`,
          `turn:${reqHost}:${network.turn.port}?transport=tcp`,
        ],
        username: cred.username,
        credential: cred.credential,
      });
    }
    for (const extra of extraIceServers) servers.push(extra);
    return {
      iceServers: servers,
      ttl: 4 * 3600,
      turn: { enabled: enableTurn, ready: network.turn.running && !!network.turn.port },
    };
  }

  // ── 网络诊断（连接医生）──
  const doctor = createDoctor({
    getConfig: () => ({
      version,
      port: actualPort,
      httpsPort: actualHttpsPort,
      protocol: 'http',
      gateway: network.gateway,
      turn: network.turn,
    }),
  });

  app.get('/api/network', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const base = doctor.shallow();
      if (String(req.query.deep || '') === '1') base.nat = await doctor.deep();
      res.json(base);
    } catch (err) {
      logger.error('[api/network] 诊断失败:', err);
      res.status(500).json({ error: err?.message || '诊断失败' });
    }
  });

  // ── 二维码（分享房间链接用，服务端生成 SVG，零外部依赖）──
  app.get('/api/qr.svg', (req, res) => {
    const text = String(req.query.text || '').slice(0, 512);
    if (!text) return res.status(400).send('missing text');
    try {
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      res.type('image/svg+xml').set('Cache-Control', 'no-store').send(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }));
    } catch (err) {
      res.status(500).send('qr error');
    }
  });

  app.get('/api/health', (_req, res) => {
    const room = rooms.getDefaultRoom();
    res.json({
      ok: true,
      version,
      uptime: Math.round(process.uptime()),
      users: room.users.size,
      turn: network.turn.running ? { running: true, port: network.turn.port, stats: network.turn.stats?.() || null } : { running: false },
      gateway: network.gateway ? { ok: network.gateway.ok, externalIp: network.gateway.externalIp } : null,
    });
  });

  const rooms = new RoomManager();

  // ── HTTP / HTTPS 监听 ──
  const server = createServer(app);
  let httpsServer = null;
  let cert = null;
  if (enableHttps) {
    try {
      cert = await getCertificate();
    } catch (err) {
      logger.work('[https] 证书准备失败:', err?.message || err);
    }
    if (cert) {
      httpsServer = createHttpsServer({ key: cert.key, cert: cert.cert }, app);
    } else {
      logger.work('[https] 未启用（证书不可用，不影响 HTTP / 局域网 / IPv6 / 中继）');
    }
  }

  const io = new Server({
    serveClient: true,
    cors: { origin: true },
    maxHttpBufferSize: 2_000_000,       // 影院模式码流批次上限
    pingInterval: 20_000,
    pingTimeout: 15_000,
  });
  io.attach(server);
  if (httpsServer) io.attach(httpsServer);
  setupSignaling(io, rooms);

  // 监听端口（占用时按需 +1）
  const actualPort = await listen(server, port, host, retryOnBusy);
  let actualHttpsPort = null;
  if (httpsServer) {
    try {
      actualHttpsPort = await listen(httpsServer, Number(opts.httpsPort || actualPort + 1), host, true);
      logger.work(`[https] 已启动 https://<本机地址>:${actualHttpsPort}`);
    } catch (err) {
      logger.work('[https] 启动失败（不影响 HTTP）:', err?.message || err);
      try { httpsServer.close(); } catch { /* 忽略 */ }
      httpsServer = null;
    }
  }

  // ── 网络初始化（异步，不阻塞服务启动）：UPnP 端口映射 → 外部 IP → TURN 中继 ──
  const netInit = initializeNetwork();
  netInit.catch((err) => logger.error('[network] 初始化异常:', err));

  async function initializeNetwork() {
    const ports = [];
    ports.push({ port: actualPort, protocol: 'tcp', description: 'GinyScreen 房间服务(HTTP)' });
    if (actualHttpsPort) ports.push({ port: actualHttpsPort, protocol: 'tcp', description: 'GinyScreen 房间服务(HTTPS)' });

    logger.work('[network] 正在检测路由器（UPnP/NAT-PMP），尝试自动打通公网入口…');
    let gateway = null;
    if (enableGateway) {
      gateway = await withTimeout(startGatewayMapping({ ports, ttlMs: 60 * 60 * 1000 }), 15_000, null);
      if (gateway) {
        network.gateway = {
          ok: gateway.ok,
          via: gateway.via,
          externalIp: gateway.externalIp,
          mappings: gateway.mappings,
          error: gateway.error,
          stop: gateway.stop,
        };
        if (gateway.ok) {
          const httpMap = gateway.mappings.find((m) => m.protocol === 'tcp' && m.internalPort === actualPort);
          logger.work(`[network] 公网入口: ${gateway.externalIp ? `http://${gateway.externalIp}:${httpMap?.externalPort || actualPort}` : '（未取得外部 IP，映射已建立）'}`);
        } else {
          logger.work(`[network] 端口映射未生效：${gateway.error || '未知原因'}`);
        }
      } else {
        logger.work('[network] 端口映射超时（继续使用 IPv6/局域网/中继，可稍后重试）');
      }
    }

    if (enableTurn) {
      // 中继对外通告地址：优先公网映射得到的外部 IP；否则用主局域网 IP（局域网/本机可用）
      const externalIp = gateway?.externalIp || null;
      const turn = await startTurnServer({
        port: Number(opts.turnPort || process.env.TURN_PORT || 3478),
        relayPortRange,
        externalIp,
        lanIp: pickPrimaryLanIPv4(),
        secret: network.turnSecret,
      });
      network.turn = {
        running: turn.ok,
        port: turn.port,
        externalIp,
        relayRange: turn.relayRange,
        stats: turn.stats,
        stop: turn.stop,
        error: turn.error,
      };
      // TURN 的 UDP/TCP 入口 + 中继端口段也尝试映射到公网（best-effort，失败不影响局域网）
      if (turn.ok && gateway?.ok && gateway.gateway) {
        const extraPorts = [
          { port: turn.port, protocol: 'udp', description: 'GinyScreen 中继(UDP)' },
          { port: turn.port, protocol: 'tcp', description: 'GinyScreen 中继(TCP)' },
          ...rangePorts(relayPortRange).slice(0, 12).map((p) => ({ port: p, protocol: 'udp', description: 'GinyScreen 中继端口' })),
        ];
        let mapped = 0;
        for (const p of extraPorts) {
          try {
            await withTimeout(gateway.gateway.map(p.port, undefined, { protocol: p.protocol, description: p.description, ttl: 60 * 60 * 1000 }), 4000, null);
            mapped++;
          } catch { /* 单个端口失败忽略 */ }
        }
        logger.work(`[network] 中继端口已映射 ${mapped}/${extraPorts.length} 条（公网观看更稳）`);
      }
    }
    logger.work(`[network] 初始化完成：公网映射=${network.gateway?.ok ? '成功' : '未生效'}，中继=${network.turn.running ? '运行中 :' + network.turn.port : '未运行'}`);
    try { opts.onNetworkReady?.(); } catch { /* 忽略 */ }
  }

  function stop() {
    return new Promise((resolve) => {
      try { io.close(); } catch { /* 忽略 */ }
      try { server.closeAllConnections?.(); server.close(); } catch { /* 忽略 */ }
      try { httpsServer?.closeAllConnections?.(); httpsServer?.close(); } catch { /* 忽略 */ }
      (async () => {
        try { await network.turn.stop?.(); } catch { /* 忽略 */ }
        try { await network.gateway?.stop?.(); } catch { /* 忽略 */ }
        resolve();
      })();
    });
  }

  return {
    server,
    httpsServer,
    io,
    app,
    rooms,
    port: actualPort,
    httpsPort: actualHttpsPort,
    network,
    doctor,
    cert,
    netInit,
    stop,
    urls: () => buildDisplayUrls(actualPort, actualHttpsPort, network),
  };
}

// ── 工具 ──

/** 给 Promise 加硬超时（超时/失败返回 fallback，避免网络探测挂起阻塞初始化） */
function withTimeout(promise, ms, fallback = null) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    const timer = setTimeout(() => finish(fallback), ms);
    promise.then(
      (value) => { clearTimeout(timer); finish(value); },
      (err) => {
        clearTimeout(timer);
        logger.debug('[network] 探测失败:', err?.message || err);
        finish(fallback);
      },
    );
  });
}

function listen(server, port, host, retryOnBusy) {
  return new Promise((resolve, reject) => {
    const attempt = (p) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && retryOnBusy && p < port + 20) {
          logger.work(`端口 ${p} 被占用，改用 ${p + 1}`);
          attempt(p + 1);
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(server.address().port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, host);
    };
    attempt(port);
  });
}

/** 从请求 Host 头取「客户端实际用来访问的主机名」，IPv6 保留方括号 */
function hostFromRequest(req) {
  const raw = String(req.headers?.host || '').trim();
  if (!raw) return 'localhost';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end > 0 ? raw.slice(0, end + 1) : 'localhost';
  }
  const i = raw.lastIndexOf(':');
  return i > 0 ? raw.slice(0, i) : raw;
}

function rangePorts([from, to]) {
  const out = [];
  for (let p = from; p <= Math.min(to, from + 63); p++) out.push(p);
  return out;
}

/** TURN 密钥持久化（重启后旧凭据仍可用；也可用环境变量固定） */
function loadOrCreateTurnSecret() {
  if (process.env.TURN_SECRET) return process.env.TURN_SECRET;
  const file = join(ROOT, 'temp', 'turn-secret.txt');
  try {
    if (existsSync(file)) {
      const s = readFileSync(file, 'utf8').trim();
      if (s.length >= 16) return s;
    }
    mkdirSync(dirname(file), { recursive: true });
    const secret = randomBytes(24).toString('hex');
    writeFileSync(file, secret, 'utf8');
    return secret;
  } catch {
    return randomBytes(24).toString('hex');
  }
}

/** 展示给用户的地址列表（房间页「邀请」用） */
function buildDisplayUrls(port, httpsPort, network) {
  const lan = lanIPv4List();
  const ipv6 = globalIPv6List();
  const list = [];
  for (const ip of lan) list.push({ url: `http://${ip}:${port}`, kind: 'lan', label: '局域网' });
  for (const ip of ipv6) list.push({ url: `http://[${ip}]:${port}`, kind: 'ipv6', label: 'IPv6' });
  const tcpMap = network.gateway?.mappings?.find((m) => m.protocol === 'tcp' && m.internalPort === port);
  if (network.gateway?.ok && tcpMap?.externalIp) {
    list.push({ url: `http://${tcpMap.externalIp}:${tcpMap.externalPort || port}`, kind: 'public', label: '公网（自动映射）' });
  }
  if (httpsPort && lan.length) {
    list.push({ url: `https://${lan[0]}:${httpsPort}`, kind: 'https-lan', label: '局域网 HTTPS（其他电脑共享屏幕用）' });
  }
  return list;
}
