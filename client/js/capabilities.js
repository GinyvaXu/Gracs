// capabilities.js — 设备/浏览器能力探测（安全上下文 / 屏幕采集 / 编解码支持）
// 用于：选择最优编码方案、给用户准确的能力提示（而不是「点了没反应」）
export const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
export const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isAndroid = /Android/i.test(navigator.userAgent);
export const isMobile = isIOS || isAndroid || /Mobi/i.test(navigator.userAgent);
export const isElectron = !!window.gvDesktop;

/** 屏幕采集是否可用（需要安全上下文 + getDisplayMedia） */
export function canCaptureScreen() {
  if (!navigator.mediaDevices?.getDisplayMedia) return false;
  if (window.isSecureContext) return true;
  return isElectron;   // 桌面版已把自身来源标记为安全
}

export function captureBlockReason() {
  if (navigator.mediaDevices?.getDisplayMedia && !window.isSecureContext && !isElectron) {
    return '浏览器要求 HTTPS 才能采集屏幕：请用 https:// 地址打开（或使用桌面版 / localhost）';
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    if (isIOS) return 'iPhone/iPad 浏览器不支持采集屏幕，可作为观看端使用';
    if (isAndroid) return '安卓浏览器暂不支持采集屏幕，可作为观看端使用；桌面版可正常共享';
    return '当前浏览器不支持屏幕采集，请使用 Edge / Chrome / 桌面版';
  }
  return '';
}

/** WebRTC 发送/接收能力中的视频编解码器列表 */
export function webrtcCodecs() {
  const codecs = new Set();
  try {
    for (const c of RTCRtpSender.getCapabilities?.('video')?.codecs || []) codecs.add(c.mimeType.toLowerCase());
  } catch { /* 忽略 */ }
  return [...codecs];
}

const CODEC_META = {
  av1: { mime: 'video/av1', label: 'AV1' },
  vp9: { mime: 'video/vp9', label: 'VP9' },
  h264: { mime: 'video/h264', label: 'H.264' },
  vp8: { mime: 'video/vp8', label: 'VP8' },
};

function codecKey(mime) {
  const m = String(mime).toLowerCase();
  if (m.includes('av1')) return 'av1';
  if (m.includes('vp9')) return 'vp9';
  if (m.includes('vp8')) return 'vp8';
  if (m.includes('h264')) return 'h264';
  return null;
}

/** 给 RTCRtpTransceiver.setCodecPreferences 用的排序：画质优先（屏幕内容 AV1/VP9 更省带宽），H.264 兼容兜底 */
export function preferredWebRtcOrder(preference = 'auto') {
  const available = webrtcCodecs();
  const order = preference === 'compat' ? ['h264', 'vp8', 'vp9', 'av1'] : ['av1', 'vp9', 'h264', 'vp8'];
  const byKey = new Map();
  try {
    for (const c of RTCRtpSender.getCapabilities?.('video')?.codecs || []) {
      const key = codecKey(c.mimeType);
      if (key && !byKey.has(key)) byKey.set(key, c);
    }
  } catch { /* 忽略 */ }
  return order.map((key) => byKey.get(key)).filter(Boolean);
}

/** 浏览器实际会用哪个 WebRTC 编解码器（取排序第一名） */
export function webrtcPreferredCodec(preference = 'auto') {
  const first = preferredWebRtcOrder(preference)[0];
  const key = first ? codecKey(first.mimeType) : null;
  return key ? { key, label: CODEC_META[key].label, mime: first.mimeType } : { key: 'vp8', label: 'VP8', mime: 'video/vp8' };
}

// ── WebCodecs（影院模式）能力 ──
function vp9Level(height) {
  if (height <= 480) return '10';
  if (height <= 720) return '30';
  if (height <= 1080) return '40';
  if (height <= 1440) return '50';
  return '51';
}

/** 生成 WebCodecs 编解码器配置（数字等级随分辨率变化） */
export function webCodecsCandidates({ width, height, fps, bitrate, preference = 'auto' }) {
  const list = [];
  const w = Math.max(2, Math.round(width / 2) * 2);
  const h = Math.max(2, Math.round(height / 2) * 2);
  const base = {
    width: w,
    height: h,
    bitrate,
    framerate: fps,
    latencyMode: 'realtime',
    hardwareAcceleration: 'prefer-hardware',
  };
  const avcLevel = h <= 480 ? '1e' : h <= 720 ? '1f' : h <= 1080 ? '2a' : '33'; // 3.0/3.1/4.2/5.1
  const avcCodec = `avc1.4200${avcLevel}`;
  const order = preference === 'compat'
    ? ['h264', 'vp8', 'vp9', 'av1']
    : ['h264', 'vp9', 'av1', 'vp8'];   // 默认：硬件友好的 H.264 优先，其次高压缩率
  for (const key of order) {
    if (key === 'h264') {
      list.push({ key, label: 'H.264', config: { ...base, codec: avcCodec, avc: { format: 'annexb' } }, altConfig: { ...base, codec: avcCodec } });
    } else if (key === 'vp9') {
      list.push({ key, label: 'VP9', config: { ...base, codec: `vp09.00.${vp9Level(h)}.08` } });
    } else if (key === 'av1') {
      list.push({ key, label: 'AV1', config: { ...base, codec: h <= 720 ? 'av01.0.04M.08' : h <= 1080 ? 'av01.0.05M.08' : 'av01.0.08M.08' } });
    } else if (key === 'vp8') {
      list.push({ key, label: 'VP8', config: { ...base, codec: 'vp8' } });
    }
  }
  return list;
}

/** 探测 WebCodecs 编码支持，返回第一个可用候选（含是否硬件加速） */
export async function pickVideoEncoderConfig(opts) {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const cand of webCodecsCandidates(opts)) {
    for (const config of [cand.config, cand.altConfig].filter(Boolean)) {
      try {
        const res = await VideoEncoder.isConfigSupported(config);
        if (res?.supported) {
          const resolved = res.config || config;
          return {
            key: cand.key,
            label: cand.label,
            config: resolved,
            codec: resolved.codec,
            hw: /prefer-hardware/i.test(String(resolved.hardwareAcceleration || config.hardwareAcceleration || '')),
          };
        }
      } catch { /* 尝试下一个 */ }
    }
  }
  return null;
}

/** 观看端：确认解码器支持（用共享者发来的 codec 字符串） */
export async function canDecodeVideo({ codec, codedWidth, codedHeight, description }) {
  if (typeof VideoDecoder === 'undefined') return false;
  const base = { codec, codedWidth: codedWidth || undefined, codedHeight: codedHeight || undefined };
  const configs = [];
  if (description) configs.push({ ...base, description });
  configs.push({ ...base, optimizeForLatency: true });
  if (/^avc1/i.test(codec)) {
    configs.push({ ...base, avc: { format: 'annexb' }, optimizeForLatency: true });
  }
  for (const config of configs) {
    try {
      const res = await VideoDecoder.isConfigSupported(config);
      if (res?.supported) return res.config || config;
    } catch { /* 下一个 */ }
  }
  return false;
}

export function webCodecsSupport() {
  return {
    encode: typeof VideoEncoder !== 'undefined',
    decode: typeof VideoDecoder !== 'undefined',
    trackProcessor: typeof MediaStreamTrackProcessor !== 'undefined',
  };
}

/** 环境摘要（诊断面板展示） */
export function describeEnvironment() {
  return {
    secure: window.isSecureContext,
    capture: canCaptureScreen(),
    blockReason: captureBlockReason(),
    webcodecs: webCodecsSupport(),
    webrtcCodecs: webrtcCodecs(),
    mobile: isMobile,
    ios: isIOS,
    safari: isSafari,
    electron: isElectron,
    hardwareConcurrency: navigator.hardwareConcurrency || 0,
  };
}
