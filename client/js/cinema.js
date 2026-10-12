// cinema.js — 影院模式：WebCodecs 编码 → Socket.IO 中继转发 → 解码渲染
// 与 WebRTC 链路的区别：码率/关键帧/缓冲完全由我们控制，画质恒定、弱网平滑（代价是延迟略高 ~0.2-0.5s），
// 专为「一起看电影」设计；声音仍走 WebRTC（Opus）。
//
// 批次格式（小端，单条 Socket.IO 二进制消息）：
//   u8 version | u8 frameCount | u16 reserved
//   每帧: u32 seq | f64 timestampUs | u32 durationUs | u8 type(1=key) | u8 chunkCount | u16 reserved
//         分片: u32 length | bytes...
export const CINEMA_BATCH_VERSION = 1;

const FLUSH_MS = 14;             // 批次聚合窗口（约等于一帧）
const MAX_BATCH_BYTES = 192 * 1024;
const MAX_QUEUE_FRAMES = 10;     // 解码队列上限（超过丢旧帧，保证低延迟）

function writeBatch(frames) {
  let size = 4;
  for (const f of frames) {
    size += 20;   // seq(4) + timestamp(8) + duration(4) + type(1) + chunkCount(1) + reserved(2)
    for (const c of f.chunks) size += 4 + c.length;
  }
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let o = 0;
  dv.setUint8(o, CINEMA_BATCH_VERSION); o += 1;
  dv.setUint8(o, Math.min(255, frames.length)); o += 1;
  dv.setUint16(o, 0, true); o += 2;
  for (const f of frames) {
    dv.setUint32(o, f.seq, true); o += 4;
    dv.setFloat64(o, f.timestamp, true); o += 8;
    dv.setUint32(o, f.duration || 0, true); o += 4;
    dv.setUint8(o, f.type === 'key' ? 1 : 0); o += 1;
    dv.setUint8(o, Math.min(255, f.chunks.length)); o += 1;
    dv.setUint16(o, 0, true); o += 2;
    for (const c of f.chunks) {
      dv.setUint32(o, c.length, true); o += 4;
      bytes.set(c, o); o += c.length;
    }
  }
  return buf;
}

export function readBatch(buffer) {
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  let o = 0;
  const version = dv.getUint8(o); o += 1;
  if (version !== CINEMA_BATCH_VERSION) return null;
  const frameCount = dv.getUint8(o); o += 1;
  o += 2;
  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    if (o + 20 > buffer.byteLength) break;
    const seq = dv.getUint32(o, true); o += 4;
    const timestamp = dv.getFloat64(o, true); o += 8;
    const duration = dv.getUint32(o, true); o += 4;
    const type = dv.getUint8(o) === 1 ? 'key' : 'delta'; o += 1;
    const chunkCount = dv.getUint8(o); o += 1;
    o += 2;
    const chunks = [];
    for (let c = 0; c < chunkCount; c++) {
      if (o + 4 > buffer.byteLength) break;
      const len = dv.getUint32(o, true); o += 4;
      if (o + len > buffer.byteLength) break;
      chunks.push(u8.slice(o, o + len));   // 拷贝，解码器可能持有
      o += len;
    }
    frames.push({ seq, timestamp, duration, type, chunks });
  }
  return frames;
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ═══════════ 发送端（共享者）═══════════
export class CinemaSender {
  constructor({ stream, socket, codecPreference = 'auto' }) {
    this.stream = stream;
    this.socket = socket;
    this.codecPreference = codecPreference;
    this.encoder = null;
    this.codecInfo = null;
    this.seq = 0;
    this.pendingFrames = [];
    this.flushTimer = null;
    this.needKeyframe = true;
    this.running = false;
    this.reader = null;
    this.videoEl = null;
    this.rvfcHandle = null;
    this.bitrate = 0;
    this.targetBitrate = 0;
    this.minBitrate = 0;
    this.maxBitrate = 0;
    this.stats = { sentFrames: 0, sentBytes: 0, keyframes: 0, encoderQueue: 0, fps: 0, lastFlushAt: Date.now(), lastSentBytes: 0 };
    this.onStats = null;
  }

  /** @returns {Promise<{ok:boolean, codec?:string, label?:string, hw?:boolean, width?:number, height?:number, error?:string}>} */
  async start({ width, height, fps, bitrate }) {
    const { pickVideoEncoderConfig } = await import('./capabilities.js');
    const pick = await pickVideoEncoderConfig({ width, height, fps, bitrate, preference: this.codecPreference });
    if (!pick) return { ok: false, error: '当前浏览器不支持影院模式（WebCodecs 编码不可用），请改用标准链路' };
    this.codecInfo = pick;
    this.targetBitrate = bitrate;
    this.bitrate = bitrate;
    this.minBitrate = Math.max(600_000, Math.round(bitrate * 0.25));
    this.maxBitrate = Math.round(bitrate * 1.6);
    const config = { ...pick.config, bitrate };
    try {
      this.encoder = new VideoEncoder({
        output: (chunk, metadata) => this._onChunk(chunk, metadata),
        error: (err) => { console.error('[cinema] 编码器错误', err); this._fail(err); },
      });
      this.encoder.configure(config);
    } catch (err) {
      return { ok: false, error: '编码器初始化失败：' + (err?.message || err) };
    }
    this.running = true;
    this._startFlushTimer();
    const sourceOk = await this._startFrameSource();
    if (!sourceOk) {
      await this.stop();
      return { ok: false, error: '无法读取屏幕帧（浏览器过旧），请改用标准链路' };
    }
    this.config = config;
    return {
      ok: true,
      codec: config.codec,
      label: pick.label,
      hw: pick.hw,
      width: config.width,
      height: config.height,
      decoderConfig: { codec: config.codec, codedWidth: config.width, codedHeight: config.height },
    };
  }

  async _startFrameSource() {
    const track = this.stream.getVideoTracks()[0];
    if (typeof MediaStreamTrackProcessor !== 'undefined') {
      const processor = new MediaStreamTrackProcessor({ track });
      this.reader = processor.readable.getReader();
      this._pumpReader();
      return true;
    }
    // 兜底：隐藏 video + requestVideoFrameCallback
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return false;
    this.videoEl = document.createElement('video');
    this.videoEl.muted = true;
    this.videoEl.playsInline = true;
    this.videoEl.srcObject = new MediaStream([track]);
    await this.videoEl.play().catch(() => {});
    const pump = () => {
      if (!this.running || !this.videoEl) return;
      try {
        if (this.videoEl.videoWidth) {
          const frame = new VideoFrame(this.videoEl, { timestamp: performance.now() * 1000 });
          this._pushFrame(frame);
        }
      } catch { /* video 未就绪时跳过 */ }
      this.rvfcHandle = this.videoEl.requestVideoFrameCallback(pump);
    };
    this.rvfcHandle = this.videoEl.requestVideoFrameCallback(pump);
    return true;
  }

  async _pumpReader() {
    try {
      while (this.running && this.reader) {
        const { done, value: frame } = await this.reader.read();
        if (done) break;
        this._pushFrame(frame);
      }
    } catch (err) {
      if (this.running) console.error('[cinema] 帧读取中断', err);
    }
  }

  _pushFrame(frame) {
    if (!this.running || !this.encoder) { try { frame.close(); } catch { /* 忽略 */ } return; }
    try {
      if (this.encoder.encodeQueueSize > 6) { frame.close(); return; }   // 编码跟不上就丢帧
      const keyFrame = this.needKeyframe;
      this.needKeyframe = false;
      this.encoder.encode(frame, { keyFrame });
      if (keyFrame) this.stats.keyframes++;
      this.stats.encoderQueue = this.encoder.encodeQueueSize;
    } catch (err) {
      console.error('[cinema] 编码失败', err);
    } finally {
      try { frame.close(); } catch { /* 忽略 */ }
    }
  }

  _onChunk(chunk, metadata) {
    if (!this.running) return;
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.pendingFrames.push({
      seq: this.seq++,
      timestamp: chunk.timestamp,
      duration: chunk.duration || 0,
      type: chunk.type,
      chunks: [data],
    });
    this.stats.sentFrames++;
    this.stats.sentBytes += data.length;
    // 解码器配置更新（部分编码器在关键帧时才给出 description）
    if (metadata?.decoderConfig) {
      const dc = metadata.decoderConfig;
      const meta = {
        codec: dc.codec || this.config?.codec,
        codedWidth: dc.codedWidth || this.config?.width,
        codedHeight: dc.codedHeight || this.config?.height,
        description: dc.description ? bytesToBase64(new Uint8Array(dc.description)) : null,
        hw: this.codecInfo?.hw === true,
      };
      this._sendMeta(meta);
    }
    const bytes = this.pendingBytes();
    if (bytes >= MAX_BATCH_BYTES) this._flush();
  }

  pendingBytes() {
    let n = 0;
    for (const f of this.pendingFrames) for (const c of f.chunks) n += c.length;
    return n;
  }

  _startFlushTimer() {
    const tick = () => {
      if (!this.running) return;
      this._flush();
      this.flushTimer = setTimeout(tick, FLUSH_MS);
    };
    this.flushTimer = setTimeout(tick, FLUSH_MS);
  }

  _flush() {
    if (!this.pendingFrames.length) return;
    const frames = this.pendingFrames;
    this.pendingFrames = [];
    try {
      this.socket.cinemaChunk(writeBatch(frames));
    } catch (err) {
      console.error('[cinema] 发送失败', err);
    }
    this.stats.sentFramesInWindow = (this.stats.sentFramesInWindow || 0) + frames.length;
    const now = Date.now();
    const dt = (now - this.stats.lastFlushAt) / 1000;
    if (dt >= 1) {
      this.stats.fps = Math.round((this.stats.sentFramesInWindow || 0) / dt);
      this.stats.kbps = Math.round(((this.stats.sentBytes - this.stats.lastSentBytes) * 8) / dt / 1000);
      this.stats.sentFramesInWindow = 0;
      this.stats.lastSentBytes = this.stats.sentBytes;
      this.stats.lastFlushAt = now;
      this.onStats?.({ ...this.stats, targetKbps: Math.round(this.bitrate / 1000) });
    }
  }

  _sendMeta(meta) {
    this.meta = meta;
    try { this.socket.cinemaMeta(meta); } catch { /* 忽略 */ }
  }

  sendInitialMeta(meta) {
    this._sendMeta(meta);
  }

  requestKeyframe() {
    this.needKeyframe = true;
  }

  /** 观看端反馈 → AIMD 码率调整 */
  onFeedback(stats) {
    if (!this.encoder || !this.running || !stats) return;
    const targetKbps = this.bitrate / 1000;
    const gotKbps = Number(stats.kbps) || 0;
    const dropped = Number(stats.dropped) || 0;
    let next = this.bitrate;
    if (gotKbps > 0 && gotKbps < targetKbps * 0.6) next = this.bitrate * 0.8;
    else if (dropped > 3) next = this.bitrate * 0.85;
    else if (gotKbps >= targetKbps * 0.95) next = this.bitrate * 1.06;
    next = Math.round(Math.min(this.maxBitrate, Math.max(this.minBitrate, next)));
    if (Math.abs(next - this.bitrate) / this.bitrate > 0.06) {
      this.bitrate = next;
      try {
        this.encoder.configure({ ...this.config, bitrate: next });
      } catch { /* 忽略 */ }
      this.requestKeyframe();
    }
  }

  _fail(err) {
    this.onError?.(err);
  }

  async stop() {
    this.running = false;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this._flush();
    try { await this.reader?.cancel?.(); } catch { /* 忽略 */ }
    this.reader = null;
    if (this.videoEl) {
      try { this.videoEl.pause(); this.videoEl.srcObject = null; this.videoEl.remove(); } catch { /* 忽略 */ }
      this.videoEl = null;
    }
    if (this.encoder) {
      try { if (this.encoder.state !== 'closed') { this.encoder.flush?.(); this.encoder.close(); } } catch { /* 忽略 */ }
      this.encoder = null;
    }
    this.pendingFrames = [];
  }
}

// ═══════════ 接收端（观看者）═══════════
export class CinemaReceiver {
  constructor({ canvas, onStats, onNeedKeyframe }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.onStats = onStats;
    this.onNeedKeyframe = onNeedKeyframe;
    this.decoder = null;
    this.meta = null;
    this.queue = [];
    this.renderHandle = null;
    this.lastDecodedAt = 0;
    this.stats = { decoded: 0, displayed: 0, dropped: 0, bytes: 0, fps: 0, kbps: 0, lastAt: Date.now(), lastBytes: 0, lastDecoded: 0, decodeMs: 0 };
    this.dead = false;
    this.needKeyframeSentAt = 0;
    this.lastFrameAt = 0;
    // 页面不可见时（切后台/最小化）暂停渲染与解码：既省 CPU，也避免丢帧统计失真；恢复时请求关键帧。
    this.suspended = document.hidden === true;
    this._onVisibility = () => {
      if (this.dead) return;
      if (document.hidden) {
        this.suspended = true;
        this._clearPending();
      } else {
        this.suspended = false;
        this._requestKeyframe(true);
        this._startRenderLoop();
      }
    };
    document.addEventListener('visibilitychange', this._onVisibility);
  }

  _clearPending() {
    for (const f of this.frameQueue || []) { try { f.close(); } catch { /* 忽略 */ } }
    this.frameQueue = [];
    this.queue = [];
  }

  /** 设置/更新解码器配置（来自 cinema:meta 或房间状态里的 share.cinema） */
  async setMeta(meta) {
    if (!meta?.codec) return false;
    if (this.meta && this.meta.codec === meta.codec && this.meta.codedWidth === meta.codedWidth && this.meta.codedHeight === meta.codedHeight && this.meta.description === meta.description) {
      return true;
    }
    this.meta = meta;
    await this._ensureDecoder();
    return true;
  }

  async _ensureDecoder() {
    const { canDecodeVideo } = await import('./capabilities.js');
    const meta = this.meta;
    if (!meta?.codec) return;
    if (this.decoder) {
      try { if (this.decoder.state !== 'closed') this.decoder.close(); } catch { /* 忽略 */ }
      this.decoder = null;
    }
    const description = meta.description ? base64ToBytes(meta.description) : null;
    const config = await canDecodeVideo({ codec: meta.codec, codedWidth: meta.codedWidth, codedHeight: meta.codedHeight, description });
    if (!config) {
      this.onStats?.({ error: '当前浏览器无法解码该编码（' + meta.codec + '），请联系共享者改用标准链路' });
      return;
    }
    const finalConfig = { ...config, optimizeForLatency: true };
    if (!finalConfig.description && description) finalConfig.description = description;
    try {
      this.decoder = new VideoDecoder({
        output: (frame) => this._onFrame(frame),
        error: (err) => {
          console.warn('[cinema] 解码错误', err);
          this._requestKeyframe(true);
        },
      });
      this.decoder.configure(finalConfig);
      this.configuredCodec = meta.codec;
    } catch (err) {
      console.error('[cinema] 解码器初始化失败', err);
      this.onStats?.({ error: '解码器初始化失败：' + (err?.message || err) });
    }
  }

  pushBatch(buffer) {
    if (this.dead) return;
    this.stats.bytes += buffer.byteLength;
    if (this.suspended) return;   // 页面不可见时不解码（恢复时请求关键帧）
    const frames = readBatch(buffer);
    if (!frames) return;
    for (const f of frames) {
      if (this.queue.length > MAX_QUEUE_FRAMES) {
        this.queue.shift();
        this.stats.dropped++;
      }
      this.queue.push(f);
    }
    this.lastFrameAt = performance.now();
    if (!this.decoder && frames.some((f) => f.type === 'key')) {
      this._ensureDecoder().then(() => this._drainQueue());
    } else {
      this._drainQueue();
    }
    this._startRenderLoop();
  }

  _drainQueue() {
    if (!this.decoder || this.decoder.state !== 'configured') return;
    while (this.queue.length) {
      const f = this.queue.shift();
      try {
        for (const chunk of f.chunks) {
          this.decoder.decode(new EncodedVideoChunk({
            type: f.type,
            timestamp: f.timestamp,
            duration: f.duration || undefined,
            data: chunk,
          }));
        }
      } catch (err) {
        console.warn('[cinema] 解码提交失败', err);
        this._requestKeyframe(true);
        break;
      }
    }
    if (this.decoder.decodeQueueSize > 6) this._requestKeyframe(false);
  }

  _onFrame(frame) {
    if (this.dead || this.suspended) { try { frame.close(); } catch { /* 忽略 */ } return; }
    this.frameQueue = this.frameQueue || [];
    if (this.frameQueue.length > 2) {
      const old = this.frameQueue.shift();
      try { old.close(); } catch { /* 忽略 */ }
      this.stats.dropped++;
    }
    this.frameQueue.push(frame);
    this.stats.decoded++;
  }

  _startRenderLoop() {
    if (this.renderHandle || this.dead || this.suspended) return;
    const loop = () => {
      if (this.dead) return;
      if (document.hidden) { this.renderHandle = null; return; }   // 隐藏时停表，恢复时由 visibilitychange 重启
      this._render();
      this._tickStats();
      this.renderHandle = requestAnimationFrame(loop);
    };
    this.renderHandle = requestAnimationFrame(loop);
  }

  _render() {
    const q = this.frameQueue;
    if (!q?.length) return;
    // 保持 ~2 帧缓冲：多余的直接丢旧帧（低延迟优先）
    while (q.length > 2) {
      const old = q.shift();
      try { old.close(); } catch { /* 忽略 */ }
      this.stats.dropped++;
    }
    const frame = q.shift();
    try {
      const w = frame.displayWidth || frame.codedWidth;
      const h = frame.displayHeight || frame.codedHeight;
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      const t0 = performance.now();
      this.ctx.drawImage(frame, 0, 0, w, h);
      this.stats.decodeMs = Math.round(performance.now() - t0);
      this.stats.displayed = (this.stats.displayed || 0) + 1;
      this.stats.width = w;
      this.stats.height = h;
      this.lastDecodedAt = Date.now();
    } catch (err) {
      console.warn('[cinema] 绘制失败', err);
    } finally {
      try { frame.close(); } catch { /* 忽略 */ }
    }
  }

  _tickStats() {
    const now = Date.now();
    if (now - this.stats.lastAt < 1000) return;
    const dt = (now - this.stats.lastAt) / 1000;
    this.stats.fps = Math.round((this.stats.decoded - this.stats.lastDecoded) / dt);
    this.stats.kbps = Math.round(((this.stats.bytes - this.stats.lastBytes) * 8) / dt / 1000);
    this.stats.lastAt = now;
    this.stats.lastBytes = this.stats.bytes;
    this.stats.lastDecoded = this.stats.decoded;
    this.onStats?.({ ...this.stats, buffer: (this.frameQueue?.length || 0), stale: this.lastFrameAt ? now - this.lastFrameAt : null });
  }

  _requestKeyframe(force) {
    const now = Date.now();
    if (!force && now - this.needKeyframeSentAt < 1500) return;
    this.needKeyframeSentAt = now;
    this.onNeedKeyframe?.();
  }

  destroy() {
    this.dead = true;
    try { document.removeEventListener('visibilitychange', this._onVisibility); } catch { /* 忽略 */ }
    if (this.renderHandle) cancelAnimationFrame(this.renderHandle);
    this.renderHandle = null;
    this._clearPending();
    this.queue = [];
    try { if (this.decoder && this.decoder.state !== 'closed') this.decoder.close(); } catch { /* 忽略 */ }
    this.decoder = null;
  }
}
