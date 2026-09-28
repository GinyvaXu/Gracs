// gen-icon.mjs — 生成应用图标（零依赖）：assets/icon.png(256) + assets/icon.ico + assets/tray.png(32)
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(__dirname, '..', 'assets');
mkdirSync(assetsDir, { recursive: true });

// ── 绘制：深色显示器机身 + 蓝紫渐变屏 + 白色播放键 + 底座 ──
function draw(size) {
  const px = new Float64Array(size * size * 4); // RGBA 0..255
  const put = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size || a <= 0) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const inRoundRect = (x, y, cx, cy, w, h, rad) => {
    const dx = Math.abs(x - cx) - (w / 2 - rad);
    const dy = Math.abs(y - cy) - (h / 2 - rad);
    if (dx <= 0 && dy <= 0) return true;
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) <= rad;
  };
  // 三角形（播放键）点内判断：质心坐标法
  const inTriangle = (x, y, ax, ay, bx, by, cx, cy) => {
    const s1 = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    const s2 = (cx - bx) * (y - by) - (cy - by) * (x - bx);
    const s3 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
    const neg = (s1 < 0) || (s2 < 0) || (s3 < 0);
    const pos = (s1 > 0) || (s2 > 0) || (s3 > 0);
    return !(neg && pos);
  };

  const cx = size / 2;
  const cy = size / 2 + size * 0.02;
  const sw = size * 0.68;   // 屏幕宽
  const sh = size * 0.46;   // 屏幕高
  const sr = size * 0.06;   // 圆角
  const screenTop = cy - sh / 2;
  const screenBottom = cy + sh / 2;

  // 屏幕机身（深色）
  for (let y = Math.floor(screenTop); y <= Math.ceil(screenBottom); y++) {
    for (let x = Math.floor(cx - sw / 2); x <= Math.ceil(cx + sw / 2); x++) {
      if (inRoundRect(x, y, cx, cy, sw, sh, sr)) put(x, y, 26, 32, 46, 255);
    }
  }
  // 机身边框高光
  const edgeW = Math.max(1, size * 0.018);
  for (let y = Math.floor(screenTop); y <= Math.ceil(screenBottom); y++) {
    for (let x = Math.floor(cx - sw / 2); x <= Math.ceil(cx + sw / 2); x++) {
      if (inRoundRect(x, y, cx, cy, sw, sh, sr)) {
        const edge = Math.min(
          Math.abs(x - (cx - sw / 2)), Math.abs(x - (cx + sw / 2)),
          Math.abs(y - screenTop), Math.abs(y - screenBottom)
        );
        if (edge <= edgeW) put(x, y, 84, 97, 122, 255);
      }
    }
  }
  // 内屏（蓝紫渐变）
  const pad = size * 0.045;
  const iw = sw - pad * 2;
  const ih = sh - pad * 2;
  const ir = Math.max(1, sr - pad);
  for (let y = Math.floor(screenTop + pad); y <= Math.ceil(screenBottom - pad); y++) {
    for (let x = Math.floor(cx - iw / 2); x <= Math.ceil(cx + iw / 2); x++) {
      if (!inRoundRect(x, y, cx, cy, iw, ih, ir)) continue;
      const t = (y - (screenTop + pad)) / (ih - 1);
      const r = Math.round(0x2e + (0x1b - 0x2e) * t);
      const g = Math.round(0x44 + (0x26 - 0x44) * t);
      const b = Math.round(0x6e + (0x3a - 0x6e) * t);
      put(x, y, r, g, b, 255);
    }
  }
  // 播放键（白色三角，略向右偏移使其视觉居中）
  const tx = cx + size * 0.015;
  const ty = cy + size * 0.01;
  const half = size * 0.09;
  const apexX = tx + half * 0.62;
  for (let y = Math.floor(ty - half); y <= Math.ceil(ty + half); y++) {
    for (let x = Math.floor(tx - half); x <= Math.ceil(tx + half); x++) {
      if (inTriangle(x, y, tx - half, ty - half, tx - half, ty + half, apexX, ty)) {
        put(x, y, 240, 245, 255, 255);
      }
    }
  }
  // 底座：竖杆 + 圆角横条
  const standW = Math.max(2, size * 0.05);
  const standTop = screenBottom;
  const standBottom = screenBottom + size * 0.09;
  for (let y = Math.floor(standTop); y <= Math.ceil(standBottom); y++) {
    for (let x = Math.floor(cx - standW / 2); x <= Math.ceil(cx + standW / 2); x++) {
      put(x, y, 40, 48, 66, 255);
    }
  }
  const baseW = size * 0.34;
  const baseH = size * 0.045;
  const baseCy = standBottom + size * 0.025;
  for (let y = Math.floor(baseCy - baseH / 2); y <= Math.ceil(baseCy + baseH / 2); y++) {
    for (let x = Math.floor(cx - baseW / 2); x <= Math.ceil(cx + baseW / 2); x++) {
      if (inRoundRect(x, y, cx, baseCy, baseW, baseH, size * 0.02)) put(x, y, 56, 66, 90, 255);
    }
  }

  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.max(0, Math.min(255, Math.round(px[i])));
  }
  return out;
}

// ── PNG 编码（RGBA）──
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(size, rgba) {
  const stride = 1 + size * 4;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = rowStart + 1 + x * 4;
      raw[d] = rgba[s];
      raw[d + 1] = rgba[s + 1];
      raw[d + 2] = rgba[s + 2];
      raw[d + 3] = rgba[s + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── ICO 容器（内嵌 PNG，Windows Vista+ 支持）──
function encodeIco(size, png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count: 1
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry.writeUInt16LE(1, 4);   // planes
  entry.writeUInt16LE(32, 6);  // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12); // offset
  return Buffer.concat([header, entry, png]);
}

const png256 = encodePng(256, draw(256));
writeFileSync(join(assetsDir, 'icon.png'), png256);
writeFileSync(join(assetsDir, 'icon.ico'), encodeIco(256, png256));
writeFileSync(join(assetsDir, 'tray.png'), encodePng(32, draw(32)));

// ── PWA 图标（客户端可直接安装到桌面/主屏）──
const clientAssets = join(__dirname, '..', 'client', 'assets');
mkdirSync(clientAssets, { recursive: true });
writeFileSync(join(clientAssets, 'icon-192.png'), encodePng(192, draw(192)));
writeFileSync(join(clientAssets, 'icon-512.png'), encodePng(512, draw(512)));
// maskable：内容缩到 78% 居中，四周留安全边距（Android 自适应图标要求）
function drawMaskable(size) {
  const inner = Math.round(size * 0.78);
  const rgba = new Uint8Array(size * size * 4);
  const off = Math.round((size - inner) / 2);
  const bg = [11, 13, 20, 255];
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = bg[0]; rgba[i + 1] = bg[1]; rgba[i + 2] = bg[2]; rgba[i + 3] = 255;
  }
  const art = draw(inner);
  for (let y = 0; y < inner; y++) {
    for (let x = 0; x < inner; x++) {
      const s = (y * inner + x) * 4;
      const d = ((y + off) * size + (x + off)) * 4;
      const a = art[s + 3] / 255;
      rgba[d] = Math.round(art[s] * a + rgba[d] * (1 - a));
      rgba[d + 1] = Math.round(art[s + 1] * a + rgba[d + 1] * (1 - a));
      rgba[d + 2] = Math.round(art[s + 2] * a + rgba[d + 2] * (1 - a));
      rgba[d + 3] = 255;
    }
  }
  return rgba;
}
writeFileSync(join(clientAssets, 'icon-maskable-512.png'), encodePng(512, drawMaskable(512)));

console.log('已生成:');
console.log('  assets/icon.png (256x256)');
console.log('  assets/icon.ico');
console.log('  assets/tray.png (32x32)');
console.log('  client/assets/icon-192.png / icon-512.png / icon-maskable-512.png (PWA)');