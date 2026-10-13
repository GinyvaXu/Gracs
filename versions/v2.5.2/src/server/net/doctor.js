// net/doctor.js — 网络诊断（连接医生）
// 把「为什么好友连不上 / 画质为什么差」变成用户能看懂的一页报告 + 明确建议。
import { buildUrls, classifyExternal, globalIPv6List, lanIPv4List, formatHost } from './interfaces.js';
import { probePublicAddress, probeNatType } from './publicip.js';
import { logger } from '../logger.js';

export function createDoctor({ getConfig }) {
  let deepCache = { at: 0, value: null };

  /** 浅层报告：只读当前状态，立即返回（面板打开即可用） */
  function shallow() {
    const cfg = getConfig();
    const protocol = cfg.protocol || 'http';
    const urls = buildUrls({ protocol, port: cfg.port });
    const httpsUrls = cfg.httpsPort ? buildUrls({ protocol: 'https', port: cfg.httpsPort }) : null;
    const lan = lanIPv4List();
    const ipv6 = globalIPv6List();
    const gateway = cfg.gateway
      ? {
          ok: !!cfg.gateway.ok,
          via: cfg.gateway.via || null,
          externalIp: cfg.gateway.externalIp || null,
          mappings: cfg.gateway.mappings || [],
          error: cfg.gateway.error || null,
          publicUrl: null,
        }
      : null;
    if (gateway?.ok && gateway.externalIp) {
      const httpMapping = gateway.mappings.find((m) => m.protocol === 'tcp' && m.externalPort === cfg.port) || gateway.mappings.find((m) => m.protocol === 'tcp');
      const extPort = httpMapping?.externalPort || cfg.port;
      gateway.publicUrl = `${protocol}://${formatHost(gateway.externalIp)}:${extPort}`;
    }
    const turn = cfg.turn
      ? {
          running: !!cfg.turn.running,
          port: cfg.turn.port || null,
          externalIp: cfg.turn.externalIp || null,
          relayRange: cfg.turn.relayRange || null,
          stats: cfg.turn.stats ? cfg.turn.stats() : null,
        }
      : null;

    return {
      version: cfg.version,
      time: Date.now(),
      addresses: { localhost: urls.localhost, lan: urls.lan, ipv6: urls.ipv6, https: httpsUrls },
      gateway,
      turn,
      nat: deepCache.value && Date.now() - deepCache.at < 120_000 ? deepCache.value : null,
      verdict: buildVerdict({ lan, ipv6, gateway, turn, nat: deepCache.value, httpsEnabled: !!cfg.httpsPort, port: cfg.port }),
    };
  }

  /** 深度探测：STUN 公网地址 + NAT 类型（约 3~8 秒，前端点「深度检测」才触发） */
  async function deep() {
    if (deepCache.value && Date.now() - deepCache.at < 60_000) return deepCache.value;
    const [pub, nat] = await Promise.all([
      probePublicAddress({ timeoutMs: 2500 }),
      probeNatType({ timeoutMs: 2500 }),
    ]);
    const kind = pub.ok ? classifyExternal(pub.ip) : 'unknown';
    const value = {
      ok: pub.ok,
      publicIp: pub.ok ? pub.ip : null,
      publicPort: pub.ok ? pub.port : null,
      server: pub.ok ? pub.server : null,
      kind,
      natType: nat.ok ? nat.type : 'unknown',
      natError: nat.ok ? null : nat.error,
      error: pub.ok ? null : pub.error,
      p2pHint: natP2PHint(nat.type, kind),
    };
    deepCache = { at: Date.now(), value };
    logger.work(`[doctor] 深度检测: 公网=${value.publicIp || '无'} (${kind}) NAT=${value.natType}`);
    return value;
  }

  return { shallow, deep };
}

/** 中文结论：NAT 类型 + 公网地址性质 → 打洞成功率提示 */
function natP2PHint(natType, kind) {
  if (kind === 'cgnat') return '宽带被运营商大内网（CGNAT）包住：P2P 打洞困难，建议用 IPv6 或中继';
  if (kind === 'private-upstream') return '上一级还有一层 NAT：优先用 IPv6，或让光猫改桥接';
  switch (natType) {
    case 'full-cone':
      return 'NAT 类型：完全圆锥（full-cone）→ P2P 直连成功率极高';
    case 'restricted-cone':
      return 'NAT 类型：受限圆锥（restricted-cone）→ P2P 打洞通常可用';
    case 'symmetric-or-port-restricted':
      return 'NAT 类型：对称 NAT → 打洞可能失败，将自动改用中继，画面依然加密';
    case 'blocked':
      return '网络屏蔽了 UDP/NAT 探测：可能需改用中继或组网';
    default:
      return 'NAT 类型未知（STUN 探测未完整返回）';
  }
}

/** 生成「人话」判定列表：每条都带状态与下一步动作 */
function buildVerdict({ lan, ipv6, gateway, turn, nat, httpsEnabled, port = 3000 }) {
  const items = [];
  if (lan.length) {
    items.push({
      level: 'ok',
      title: '局域网直连可用',
      detail: `同一 WiFi/网线下的好友可直接访问 ${lan[0]}（无需任何设置）`,
    });
  } else {
    items.push({ level: 'warn', title: '未发现局域网地址', detail: '请检查本机网络连接' });
  }

  if (ipv6.length) {
    items.push({
      level: 'ok',
      title: 'IPv6 公网地址可用（免端口映射）',
      detail: `把 [${ipv6[0]}]:${port} 发给好友（双方都有 IPv6 时）可跨网络直连。`
        + '若对方打不开：常见原因是路由器「IPv6 防火墙」拦截入站（可在路由器放行本机 IPv6，或改用公网 IPv4 / 中继）',
    });
  } else {
    items.push({
      level: 'info',
      title: '未发现公网 IPv6',
      detail: '若宽带支持 IPv6，可在路由器开启后获得免设置的跨网络直连能力',
    });
  }

  if (gateway?.ok && gateway.publicUrl) {
    items.push({
      level: 'ok',
      title: '公网入口已自动打通',
      detail: `已通过 ${String(gateway.via || 'UPnP').toUpperCase()} 把端口映射到公网：${gateway.publicUrl}（把这条链接发给好友即可，无需 VPN/穿透软件）`,
    });
  } else {
    items.push({
      level: 'warn',
      title: '公网端口映射未生效',
      detail: gateway?.error
        ? `${gateway.error}。可在路由器中开启 UPnP/NAT-PMP 后点「重新检测」；或使用 IPv6 / 虚拟组网 / 内网穿透（高级备选）`
        : '路由器未响应端口映射请求：可在路由器开启 UPnP，或改用 IPv6 / 虚拟组网 / 内网穿透',
    });
  }

  if (turn?.running) {
    const relayed = turn.stats?.bytesRelayed ? `已中继 ${Math.round(turn.stats.bytesRelayed / 1024)} KB` : '待命中';
    items.push({
      level: 'ok',
      title: '内嵌中继服务运行中（IPv4 + IPv6 双栈）',
      detail: `严格 NAT/防火墙下自动走中继兜底（端口 ${turn.port}${turn.ipv6 ? `，IPv6 中继 ${turn.ipv6}` : ''}，${relayed}），媒体仍为端到端加密`,
    });
  } else {
    items.push({ level: 'info', title: '中继服务未启用', detail: '如需最稳连通性可检查端口占用' });
  }

  items.push({
    level: 'info',
    title: '连不上时先查本机防火墙',
    detail: `Windows 防火墙需允许 Gracs（或 Node.js）在「专用/公用网络」通信，`
      + `并放行房间端口 ${port} 与中继端口 ${turn?.port || 3478}（UDP/TCP）。首次启动的防火墙弹窗请点「允许访问」`,
  });

  if (nat) {
    items.push({ level: nat.natType === 'symmetric-or-port-restricted' ? 'warn' : 'info', title: '网络属性（深度检测）', detail: nat.p2pHint });
    if (nat.publicIp) {
      items.push({ level: 'info', title: '公网出口地址', detail: `${nat.publicIp}（由 ${nat.server} 探测；类型：${nat.kind}）` });
    }
  }

  if (httpsEnabled) {
    items.push({
      level: 'ok',
      title: 'HTTPS 已开启',
      detail: '好友用 HTTPS 地址打开时也能共享屏幕（浏览器要求安全上下文）',
    });
  } else {
    items.push({
      level: 'info',
      title: 'HTTPS 未开启',
      detail: '开房者本机（localhost）可以正常共享；如要让局域网其他电脑共享屏幕，请开启 HTTPS',
    });
  }
  return items;
}
