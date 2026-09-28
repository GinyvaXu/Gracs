// stats.js — 连接质量采集 + 每观看者独立码率自适应 + 质量面板数据
// 目标：把「画质不稳定」变成可观测、可控制：
//   - 每 2 秒读取 getStats：码率/帧率/分辨率/RTT/丢包/拥塞原因/是否走中继
//   - 自动档按可用带宽与丢包做 AIMD 调节每个观看者的独立码率上限（不互相拖累）
//   - 总上行预算约束 mesh 场景的 N 路上行总和，避免家用宽带上行被打满
import { getPreset, applySendParams } from './screenshare.js';
import { clamp } from './core.js';

const POLL_MS = 2000;

function rateOf(prev, cur, bytesKey) {
  if (!prev) return 0;
  const dt = (cur.timestamp - prev.timestamp) / 1000;
  if (dt <= 0) return 0;
  const dBytes = (cur[bytesKey] || 0) - (prev[bytesKey] || 0);
  return Math.max(0, (dBytes * 8) / dt);
}

export class StatsHub {
  constructor({ mesh, getPresetKey, getBudgetBps, onSample }) {
    this.mesh = mesh;
    this.getPresetKey = getPresetKey;
    this.getBudgetBps = getBudgetBps || (() => 30_000_000);
    this.onSample = onSample;
    this.prevOut = new Map();     // peerId -> raw stats snapshot
    this.prevIn = new Map();
    this.targets = new Map();     // peerId -> 当前生效的码率上限（自动档）
    this.timer = null;
    this.samples = { out: new Map(), in: new Map(), at: 0 };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll().catch(() => {}), POLL_MS);
    this.poll().catch(() => {});
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll() {
    const out = new Map();
    for (const [peerId, pc] of this.mesh.outPcs) {
      out.set(peerId, await this._collect(pc, 'out', peerId));
    }
    const inbound = new Map();
    for (const [peerId, pc] of this.mesh.inPcs) {
      inbound.set(peerId, await this._collect(pc, 'in', peerId));
    }
    this.samples = { out, in: inbound, at: Date.now() };
    await this._adapt();
    this.onSample?.(this.samples);
  }

  async _collect(pc, direction, peerId) {
    const prevMap = direction === 'out' ? this.prevOut : this.prevIn;
    const prev = prevMap.get(peerId) || null;
    let raw;
    try { raw = await pc.getStats(); } catch { return null; }
    const snap = { timestamp: 0, bytes: 0, frames: 0, fps: 0, width: 0, height: 0, loss: 0, rtt: null, availableOutgoingBitrate: null, limit: null, relay: false, codec: '', jitter: null, freezes: 0 };
    const byId = new Map();
    raw.forEach((s) => byId.set(s.id, s));
    let pairId = null;
    raw.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
    });
    let pair = pairId ? byId.get(pairId) : null;
    if (!pair) {
      raw.forEach((s) => { if (!pair && s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
    }
    if (!pair) {
      raw.forEach((s) => { if (!pair && s.type === 'candidate-pair' && s.state === 'succeeded') pair = s; });
    }
    if (pair) {
      snap.rtt = pair.currentRoundTripTime ?? snap.rtt;
      snap.availableOutgoingBitrate = pair.availableOutgoingBitrate ?? null;
      const local = byId.get(pair.localCandidateId);
      if (local?.candidateType) snap.relay = local.candidateType === 'relay';
    }
    const rtpType = direction === 'out' ? 'outbound-rtp' : 'inbound-rtp';
    let rtp = null;
    const remoteInbound = [];
    raw.forEach((s) => {
      if (s.type === rtpType && s.kind === 'video' && !s.isRemote) rtp = rtp || s;
      if (direction === 'out' && s.type === 'remote-inbound-rtp' && s.kind === 'video') remoteInbound.push(s);
    });
    if (rtp) {
      snap.timestamp = rtp.timestamp || Date.now();
      snap.bytes = direction === 'out' ? rtp.bytesSent : rtp.bytesReceived;
      snap.frames = direction === 'out' ? rtp.framesEncoded : rtp.framesDecoded;
      snap.fps = Math.round(rtp.framesPerSecond || 0);
      snap.width = rtp.frameWidth || 0;
      snap.height = rtp.frameHeight || 0;
      snap.limit = rtp.qualityLimitationReason || null;
      snap.jitter = rtp.jitter ?? null;
      snap.freezes = rtp.freezeCount ?? 0;
      snap.codec = rtp.codecId ? (byId.get(rtp.codecId)?.mimeType || '').replace('video/', '') : '';
      const prevRtp = prev?.rtp;
      if (prevRtp && prevRtp.timestamp === snap.timestamp) {
        snap.frames = prevRtp.frames; // 同一采样，避免帧数回退
      }
    } else {
      return null;
    }
    // 丢包：发送端看 remote-inbound-rtp，接收端看 inbound-rtp
    if (direction === 'out') {
      const ri = remoteInbound[0];
      if (ri) {
        snap.loss = Math.round((ri.fractionLost || 0) * 1000) / 10;   // 百分比
        snap.rtt = ri.roundTripTime ?? snap.rtt;
      }
    } else if (rtp) {
      const total = (rtp.packetsReceived || 0) + (rtp.packetsLost || 0);
      snap.loss = total > 0 ? Math.round(((rtp.packetsLost || 0) / total) * 1000) / 10 : 0;
    }
    snap.bitrate = rateOf(prev ? { ...prev.rtp, timestamp: prev.ts } : null, { ...rtp, timestamp: snap.timestamp }, direction === 'out' ? 'bytesSent' : 'bytesReceived');
    if (!snap.bitrate && prev?.bitrate) snap.bitrate = prev.bitrate;
    prevMap.set(peerId, { rtp: { ...rtp, timestamp: snap.timestamp, bytesSent: snap.bytes, bytesReceived: snap.bytes }, ts: snap.timestamp, bitrate: snap.bitrate });
    // 质量评分
    const preset = getPreset(this.getPresetKey());
    const fpsRatio = preset.fps > 0 ? clamp((snap.fps || 0) / preset.fps, 0, 1) : 1;
    const score = clamp(100 - snap.loss * 3.5 - (1 - fpsRatio) * 45 - (snap.limit === 'bandwidth' ? 20 : snap.limit === 'cpu' ? 12 : 0), 0, 100);
    snap.score = Math.round(score);
    snap.level = score >= 78 ? 'good' : score >= 50 ? 'fair' : 'poor';
    return snap;
  }

  /** 自动档：按可用带宽/丢包，为每个观看者单独调节码率上限，并遵守总上行预算 */
  async _adapt() {
    const preset = getPreset(this.getPresetKey());
    if (!preset.adaptive) {
      // 非自动档：仍做「拥塞向下保护」，但不主动升码率
      for (const [peerId, pc] of this.mesh.outPcs) {
        const s = this.samples.out.get(peerId);
        const prevTarget = this.targets.get(peerId) ?? preset.bitrate;
        let target = prevTarget;
        if (s && s.loss > 6) target = Math.max(preset.minBitrate, target * 0.75);
        else if (s?.limit === 'bandwidth') target = Math.max(preset.minBitrate, target * 0.9);
        else target = Math.min(preset.bitrate, target * 1.04);
        target = Math.round(target);
        if (Math.abs(target - prevTarget) / prevTarget > 0.08) {
          this.targets.set(peerId, target);
          await applySendParams(pc, preset, { bitrate: target }).catch(() => {});
        }
      }
      return;
    }

    // 自动档：目标 = 可用带宽的 85%，受丢包与预算约束
    const budget = this.getBudgetBps();
    const peers = [...this.mesh.outPcs.entries()];
    if (!peers.length) return;
    const rawTargets = [];
    for (const [peerId, pc] of peers) {
      const s = this.samples.out.get(peerId);
      const prevTarget = this.targets.get(peerId) ?? Math.min(preset.bitrate, Math.max(preset.minBitrate, budget / peers.length));
      let target = prevTarget;
      if (s) {
        const avail = s.availableOutgoingBitrate;
        if (s.loss > 8) target = prevTarget * 0.7;
        else if (s.loss > 3) target = prevTarget * 0.85;
        else if (avail && avail < prevTarget * 1.15) target = avail * 0.85;
        else target = prevTarget * 1.08;
      }
      target = clamp(target, preset.minBitrate, preset.bitrate);
      rawTargets.push({ peerId, pc, target });
    }
    // 总上行预算：超了就按比例压（每个观看者保留最低码率）
    const sum = rawTargets.reduce((a, b) => a + b.target, 0);
    if (sum > budget) {
      const ratio = budget / sum;
      for (const r of rawTargets) r.target = Math.max(preset.minBitrate * 0.8, r.target * ratio);
    }
    const presetChanged = this._lastPresetKey !== this.getPresetKey();
    this._lastPresetKey = this.getPresetKey();
    for (const r of rawTargets) {
      const prev = this.targets.get(r.peerId) ?? 0;
      r.target = Math.round(r.target);
      if (presetChanged || Math.abs(r.target - prev) / Math.max(prev, 1) > 0.1) {
        this.targets.set(r.peerId, r.target);
        await applySendParams(r.pc, preset, { bitrate: r.target }).catch(() => {});
      }
    }
    for (const key of [...this.targets.keys()]) {
      if (!this.mesh.outPcs.has(key)) this.targets.delete(key);
    }
  }

  /** 观看端：本地渲染表现（丢帧/冻结/抖动） */
  viewerSummary() {
    let worst = null;
    for (const [, s] of this.samples.in) {
      if (!s) continue;
      if (!worst || s.score < worst.score) worst = s;
    }
    return worst;
  }
}

export function describeLimit(limit) {
  switch (limit) {
    case 'bandwidth': return '网络带宽受限';
    case 'cpu': return '本机编码性能受限';
    case 'other': return '其它原因受限';
    default: return '无限制';
  }
}
