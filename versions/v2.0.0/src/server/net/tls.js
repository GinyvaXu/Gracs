// net/tls.js — 自签名证书自动生成（用于局域网/公网 HTTPS：浏览器采集屏幕需要安全上下文）
// 证书 SAN 覆盖本机全部地址；缓存到 temp/certs/auto.*，地址变化或过期自动重签。
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import selfsigned from 'selfsigned';
import { listAddresses } from './interfaces.js';
import { logger } from '../logger.js';

// 证书目录：优先 GV_CERT_DIR（桌面版指向 exe 旁可写目录，asar 内不可写），
// 其次 GV_STATE_DIR/temp/certs，最后项目 temp/certs（CLI 默认）。
const CERT_DIR = process.env.GV_CERT_DIR || join(process.env.GV_STATE_DIR || process.cwd(), 'temp', 'certs');
const CERT_FILE = join(CERT_DIR, 'auto-cert.pem');
const KEY_FILE = join(CERT_DIR, 'auto-key.pem');
const META_FILE = join(CERT_DIR, 'auto-cert.json');
const VALID_DAYS = 825;

/** 收集需要写入证书 SAN 的地址（本机 IP + localhost） */
function collectSanAddresses() {
  const names = new Set(['localhost', 'ginyscreen.local']);
  const ips = new Set(['127.0.0.1', '::1']);
  for (const a of listAddresses()) ips.add(a.address);
  return { names: [...names], ips: [...ips] };
}

/**
 * 确保存在可用的自签名证书；成功返回 { cert, key, created }，失败返回 null（不影响 HTTP 使用）。
 * 注意：selfsigned.generate 是异步的。
 */
export async function ensureSelfSignedCertificate() {
  const { names, ips } = collectSanAddresses();
  const fingerprint = JSON.stringify({ names, ips });

  try {
    if (existsSync(CERT_FILE) && existsSync(KEY_FILE) && existsSync(META_FILE)) {
      const meta = JSON.parse(readFileSync(META_FILE, 'utf8'));
      const age = Date.now() - (meta.createdAt || 0);
      const fresh = age < (VALID_DAYS - 7) * 24 * 3600 * 1000;
      if (fresh && meta.fingerprint === fingerprint) {
        return { cert: readFileSync(CERT_FILE, 'utf8'), key: readFileSync(KEY_FILE, 'utf8'), created: false };
      }
      logger.work('[tls] 证书需要重签（地址变化或临近过期）');
    }
  } catch (err) {
    logger.debug('[tls] 读取缓存证书失败:', err?.message || err);
  }

  try {
    mkdirSync(CERT_DIR, { recursive: true });
    const altNames = [
      ...names.map((value) => ({ type: 2, value })),
      ...ips.map((ip) => ({ type: 7, ip })),
    ];
    const pems = await selfsigned.generate(
      [{ name: 'commonName', value: 'GinyScreen' }, { name: 'organizationName', value: 'GinyScreen' }],
      {
        days: VALID_DAYS,
        keySize: 2048,
        algorithm: 'sha256',
        extensions: [
          { name: 'basicConstraints', cA: false },
          { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
          { name: 'extKeyUsage', serverAuth: true },
          { name: 'subjectAltName', altNames },
        ],
      },
    );
    const cert = pems?.cert;
    const key = pems?.private;
    if (!cert || !key) throw new Error('证书生成结果不完整');
    writeFileSync(CERT_FILE, cert, 'utf8');
    writeFileSync(KEY_FILE, key, 'utf8');
    writeFileSync(META_FILE, JSON.stringify({ createdAt: Date.now(), fingerprint, names, ips }, null, 2), 'utf8');
    logger.work(`[tls] 已生成自签名证书（覆盖 ${ips.length} 个本机地址），HTTPS 可用`);
    return { cert, key, created: true };
  } catch (err) {
    logger.error('[tls] 自签名证书生成失败（HTTPS 不可用，不影响 HTTP）:', err?.message || err);
    return null;
  }
}

/** 读取手动放置的证书（temp/certs/key.pem + cert.pem，npm run certs 生成） */
export function loadManualCertificate() {
  const keyPath = join(CERT_DIR, 'key.pem');
  const certPath = join(CERT_DIR, 'cert.pem');
  try {
    if (existsSync(keyPath) && existsSync(certPath) && statSync(keyPath).size > 0) {
      return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8'), created: false, manual: true };
    }
  } catch { /* 忽略 */ }
  return null;
}

/** 优先手动证书，其次自动生成的自签名证书 */
export async function getCertificate() {
  return loadManualCertificate() || (await ensureSelfSignedCertificate());
}
