// net/interfaces.js — 本机网络地址枚举与分类（IPv4/IPv6、局域网、CGNAT 判定）
import { networkInterfaces } from 'node:os';

/** 是否为私有 IPv4 地址（RFC1918） */
export function isPrivateIPv4(ip) {
  const [a, b] = String(ip).split('.').map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** 运营商级 NAT 地址段 100.64.0.0/10 —— 出现在本机侧意味着上游还有一层 NAT */
export function isCGNATIPv4(ip) {
  const [a, b] = String(ip).split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

export function isLinkLocal(ip) {
  return /^fe80:/i.test(ip) || /^169\.254\./.test(ip);
}

export function isLoopback(ip) {
  return ip === '::1' || /^127\./.test(ip);
}

/** 唯一本地地址 fc00::/7（类似 IPv4 私网，跨网络不可达） */
export function isULA(ip) {
  return /^f[cd][0-9a-f]{2}:/i.test(ip);
}

/** 枚举全部非回环、非链路本地地址 */
export function listAddresses() {
  const out = [];
  for (const [iface, list] of Object.entries(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.internal || isLoopback(net.address) || isLinkLocal(net.address)) continue;
      out.push({
        iface,
        address: net.address,
        family: net.family === 'IPv6' ? 6 : 4,
        cidr: net.cidr,
        mac: net.mac,
        private: net.family === 'IPv6' ? isULA(net.address) : isPrivateIPv4(net.address),
        cgnat: net.family === 'IPv6' ? false : isCGNATIPv4(net.address),
      });
    }
  }
  return out;
}

/** 局域网 IPv4（可发给同网段好友的地址），排除虚拟网卡倾向：按接口名排序后返回 */
export function lanIPv4List() {
  return listAddresses()
    .filter((a) => a.family === 4 && !a.cgnat)
    .sort((a, b) => scoreIface(a) - scoreIface(b))
    .map((a) => a.address);
}

function scoreIface(addr) {
  const name = addr.iface.toLowerCase();
  let score = 0;
  if (/wi-?fi|wlan|wireless/.test(name)) score -= 2;   // 无线优先发给同网段朋友
  if (/ethernet|以太网|eth/.test(name)) score -= 1;
  if (/radmin|zerotier|tailscale|tap|tun|vpn|virtual|vmware|hyper-v|loopback|蓝牙|bluetooth/.test(name)) score += 10;
  if (addr.private) score -= 1;
  return score;
}

/** 全球单播 IPv6（可直接给公网好友，运营商普遍已分配） */
export function globalIPv6List() {
  return listAddresses()
    .filter((a) => a.family === 6 && !isULA(a.address))
    .map((a) => a.address);
}

/** 主局域网 IPv4（默认展示给好友） */
export function pickPrimaryLanIPv4() {
  return lanIPv4List()[0] || null;
}

/** IPv6 地址加方括号，用于拼 URL / host:port */
export function formatHost(ip) {
  return String(ip).includes(':') ? `[${ip}]` : ip;
}

/** 组装可访问 URL 列表 */
export function buildUrls({ protocol, port }) {
  const urls = { localhost: [], lan: [], ipv6: [] };
  urls.localhost.push(`${protocol}://localhost:${port}`);
  urls.lan.push(...lanIPv4List().map((ip) => `${protocol}://${ip}:${port}`));
  urls.ipv6.push(...globalIPv6List().map((ip) => `${protocol}://${formatHost(ip)}:${port}`));
  return urls;
}

/** 给定外部 IP，判断它属于哪种情况 */
export function classifyExternal(ip, lanIps = lanIPv4List()) {
  if (!ip) return 'unknown';
  if (lanIps.includes(ip)) return 'same-as-lan';   // 网关回环或本机就是公网
  if (isCGNATIPv4(ip)) return 'cgnat';
  if (isPrivateIPv4(ip)) return 'private-upstream'; // 上层还有一层私网 NAT
  return 'public';
}
