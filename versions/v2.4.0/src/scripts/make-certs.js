// make-certs.js — 生成自签名 HTTPS 证书 (局域网 secure context 用)
// 需要 openssl: Git for Windows 自带 (Program Files\Git\usr\bin\openssl.exe)
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const certDir = join(__dirname, '..', 'temp', 'certs');
const keyPath = join(certDir, 'key.pem');
const certPath = join(certDir, 'cert.pem');

const candidates = ['openssl'];
if (process.platform === 'win32') {
  candidates.push(
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
  );
}

function findOpenssl() {
  for (const cmd of candidates) {
    try {
      execFileSync(cmd, ['version'], { stdio: 'ignore' });
      return cmd;
    } catch {
      /* try next */
    }
  }
  return null;
}

const openssl = findOpenssl();
if (!openssl) {
  console.error('未找到 openssl。请安装 Git for Windows 或 OpenSSL 后重试。');
  process.exit(1);
}

mkdirSync(certDir, { recursive: true });
if (existsSync(keyPath) && existsSync(certPath)) {
  console.log('证书已存在:', certPath);
  process.exit(0);
}

console.log('生成自签名证书（浏览器首次访问需信任）...');
execFileSync(openssl, [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
  '-days', '365',
  '-keyout', keyPath,
  '-out', certPath,
  '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
], { stdio: 'inherit' });
console.log('完成:', certPath);
console.log('启动: HTTPS=1 npm start');
