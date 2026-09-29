// index.js — Gracs 服务器 CLI 入口（浏览器版：npm start）
import { startGracsServer } from './app.js';
import { logger } from './logger.js';
import { lanIPv4List, globalIPv6List } from './net/interfaces.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '::';              // 双栈监听（IPv4 + IPv6）
const NO_TURN = process.env.NO_TURN === '1';
const NO_GATEWAY = process.env.NO_GATEWAY === '1';

// 外部 TURN（可选）：TURN_URL / TURN_USER / TURN_PASS，与内置中继并存
const extraIceServers = [];
if (process.env.TURN_URL && process.env.TURN_USER && process.env.TURN_PASS) {
  extraIceServers.push({ urls: process.env.TURN_URL, username: process.env.TURN_USER, credential: process.env.TURN_PASS });
}

let handle;
try {
  handle = await startGracsServer({
    port: PORT,
    host: HOST,
    enableTurn: !NO_TURN,
    enableGateway: !NO_GATEWAY,
    iceServers: extraIceServers,
    retryOnBusy: false,
  });
} catch (err) {
  logger.error('服务器启动失败:', err);
  process.exit(1);
}

const { port, httpsPort } = handle;
logger.work('══════════════════════════════════════════');
logger.work('  🖥️ Gracs 屏幕共享服务器已启动');
logger.work(`  日志目录: ${process.env.LOG_DIR || `${process.cwd()}\\temp\\logs`}`);
logger.work(`  本机访问: http://localhost:${port}`);
const lan = lanIPv4List();
for (const ip of lan) logger.work(`  局域网:   http://${ip}:${port}`);
const ipv6 = globalIPv6List();
for (const ip of ipv6.slice(0, 3)) logger.work(`  IPv6:     http://[${ip}]:${port}`);
if (httpsPort) logger.work(`  HTTPS:    https://localhost:${httpsPort}（局域网其他电脑共享屏幕需用它）`);
logger.work('  正在打通公网入口与中继服务（异步，稍后见诊断信息）…');
logger.work('══════════════════════════════════════════');
logger.work('  💡 把上面的地址发给好友即可加入；打开「🌐 网络」可查看完整诊断');

// 网络初始化完成后打印公网入口
handle.netInit.then(() => {
  const g = handle.network.gateway;
  if (g?.ok && g.externalIp) {
    const tcp = (g.mappings || []).find((m) => m.protocol === 'tcp' && m.internalPort === port);
    logger.work(`  ✅ 公网入口: http://${g.externalIp}:${tcp?.externalPort || port}（已自动映射，好友无需安装任何软件）`);
  } else if (g && !g.ok) {
    logger.work(`  ⚠️  公网端口映射未生效：${g.error || '路由器未开启 UPnP'}`);
    logger.work('      → 可用 IPv6 直连，或在路由器开启 UPnP/NAT-PMP；高级备选见「网络」面板');
  }
  const t = handle.network.turn;
  if (t?.running) logger.work(`  ✅ 中继服务: UDP/TCP ${t.port}（严格网络自动兜底）`);
});

async function shutdown(signal) {
  logger.work(`收到 ${signal}，正在退出…`);
  try { await handle.stop(); } catch { /* 忽略 */ }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// 未捕获异常/拒绝 → 写入报错日志（Debug 版重点）
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException:', err);
  logger.error('服务器将退出，请查看报错日志');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection:', reason);
});
