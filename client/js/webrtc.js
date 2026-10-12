// webrtc.js — WebRTC 连接管理（屏幕共享）
// 连接模型（沿用 v1.x 经验：每个对端按方向/用途拆成独立单向连接，避免 SDP 协商冲突）：
//   - outPc / inPc       : 屏幕链路（我发送 / 我接收）
//   - outAudio / inAudio : 影院模式的系统声音（仅音频，复用 WebRTC 的 Opus 通道）
// 共享者收到「新成员加入」→ 主动向该成员发起 offer；观看者被动应答，天然无 glare。
import { applySendParams, requestKeyframe } from './screenshare.js';

export class MeshManager {
  constructor({ socket, getIceServers, myId, onRemoteStream, onPeerState, onLinkStats }) {
    this.socket = socket;
    this.getIceServers = getIceServers || (() => []);
    this.myId = myId;
    this.onRemoteStream = onRemoteStream;
    this.onPeerState = onPeerState;
    this.onLinkStats = onLinkStats;
    this.outPcs = new Map();     // peerId -> RTCPeerConnection（我的屏幕发给对方）
    this.inPcs = new Map();      // peerId -> RTCPeerConnection（对方的屏幕发给我）
    this.outAudio = new Map();   // peerId -> PC（影院模式：我的系统声音发给对方）
    this.inAudio = new Map();    // peerId -> PC（对方的系统声音）
    this.localStream = null;
    this.preset = null;
    this.statsTimer = null;
    this._statsPrev = new Map();
  }

  _isMe(id) {
    return (typeof this.myId === 'function' ? this.myId() : this.myId) === id;
  }

  _newPc(onState, channel, peerId) {
    const pc = new RTCPeerConnection({
      iceServers: this._iceServers(),
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 0,
    });
    pc._pendingRemoteCandidates = [];
    pc.onicecandidate = (e) => {
      if (e.candidate) this.socket.signal(peerId, { type: 'ice', channel, candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => onState?.(pc.connectionState);
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        try { pc.restartIce?.(); } catch { /* 忽略 */ }
      }
    };
    return pc;
  }

  /** 更新 ICE 配置（拿到新 TURN 凭据后生效；已失败/断开的链路自动尝试重建） */
  setIceServers(list) {
    this._iceOverride = list;
    for (const map of [this.outPcs, this.inPcs, this.outAudio, this.inAudio]) {
      for (const pc of map.values()) {
        try {
          pc.setConfiguration({ iceServers: list });
        } catch { /* 忽略 */ }
      }
    }
    // 之前因缺少中继而失败的连接：拿到配置后自动重建
    setTimeout(() => this.reviveStale(), 500);
  }

  /** 重建失败/断开的连接：共享者重新发 offer；观看者请求对方重发 offer */
  reviveStale({ cooldownMs = 8000 } = {}) {
    const now = Date.now();
    this._reviveAt = this._reviveAt || new Map();
    const bad = new Set();
    for (const [peerId, pc] of [...this.outPcs, ...this.inPcs]) {
      const st = pc.connectionState;
      if (st === 'failed' || st === 'disconnected' || (st === 'new' && pc.iceConnectionState === 'failed')) bad.add(peerId);
    }
    for (const peerId of bad) {
      const last = this._reviveAt.get(peerId) || 0;
      if (now - last < cooldownMs) continue;
      this._reviveAt.set(peerId, now);
      this._revive(peerId);
    }
  }

  async _revive(peerId) {
    for (const map of [this.outPcs, this.inPcs]) {
      const pc = map.get(peerId);
      if (pc) { try { pc.close(); } catch { /* 忽略 */ } map.delete(peerId); }
    }
    if (this.localStream) {
      // 我是共享者：重新发起 offer
      await this._outTo(peerId, 'screen');
    } else {
      // 我是观看者：请共享者重新发起
      this.socket.signal(peerId, { type: 'renegotiate', channel: 'screen' });
    }
  }

  _iceServers() {
    return this._iceOverride ?? this.getIceServers();
  }

  // ── 信令入口 ──
  async handleSignal(from, data) {
    try {
      const channel = data.channel === 'cinema-audio' ? 'cinema-audio' : 'screen';
      const isAudio = channel === 'cinema-audio';
      if (data.type === 'offer') {
        await this._answerOffer(from, data, isAudio);
      } else if (data.type === 'renegotiate') {
        // 对方（通常是观看者）请求重建连接：共享者重新发起 offer
        if (this.localStream && !isAudio) {
          const pc = this.outPcs.get(from);
          if (pc) { try { pc.close(); } catch { /* 忽略 */ } this.outPcs.delete(from); }
          await this._outTo(from, 'screen');
        }
      } else if (data.type === 'answer') {
        const pc = (isAudio ? this.outAudio : this.outPcs).get(from);
        if (pc && pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
          this._flushPendingCandidates(pc);
        }
      } else if (data.type === 'ice') {
        const map = isAudio
          ? (this.outAudio.has(from) ? this.outAudio : this.inAudio)
          : (this.outPcs.has(from) ? this.outPcs : this.inPcs);
        const pc = map.get(from);
        if (pc && data.candidate) {
          // 远端描述就绪前到达的候选先缓存，就绪后补交（避免丢候选导致连不上）
          if (!pc.remoteDescription) pc._pendingRemoteCandidates.push(data.candidate);
          else {
            try { await pc.addIceCandidate(data.candidate); } catch { /* 过期候选忽略 */ }
          }
        }
      }
    } catch (err) {
      console.error('[webrtc] handleSignal 失败', err);
    }
  }

  async _answerOffer(from, data, isAudio) {
    const map = isAudio ? this.inAudio : this.inPcs;
    let pc = map.get(from);
    if (!pc) {
      pc = this._newPc(
        (st) => this.onPeerState?.(from, st, isAudio ? 'cinema-audio' : 'screen'),
        isAudio ? 'cinema-audio' : 'screen',
        from,
      );
      map.set(from, pc);
      pc.ontrack = (e) => {
        const stream = e.streams?.[0] || new MediaStream([e.track]);
        this.onRemoteStream?.(from, stream, isAudio ? 'cinema-audio' : 'screen');
      };
    }
    if (pc.signalingState !== 'stable') {
      try { await pc.setLocalDescription({ type: 'rollback' }); } catch { /* 忽略 */ }
    }
    await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
    this._flushPendingCandidates(pc);
    if (!isAudio) this._applyCodecPreferences(pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.socket.signal(from, { type: 'answer', channel: isAudio ? 'cinema-audio' : 'screen', sdp: pc.localDescription.sdp });
  }

  _flushPendingCandidates(pc) {
    const pending = pc._pendingRemoteCandidates || [];
    pc._pendingRemoteCandidates = [];
    for (const candidate of pending) {
      pc.addIceCandidate(candidate).catch(() => { /* 忽略 */ });
    }
  }

  /** 屏幕链路编码器偏好（画质优先顺序） */
  _applyCodecPreferences(pc) {
    try {
      const order = window.__gsCodecOrder;
      if (!order?.length) return;
      for (const tr of pc.getTransceivers()) {
        if (tr.receiver?.track?.kind === 'video' || tr.sender?.track?.kind === 'video' || tr.kind === 'video') {
          tr.setCodecPreferences?.(order);
        }
      }
    } catch { /* 忽略 */ }
  }

  // ── 屏幕共享（发送端）──
  startSharing(stream, members, { preset, audioOnly = false } = {}) {
    if (!audioOnly) {
      this.localStream = stream;
      this.preset = preset;
    }
    const channel = audioOnly ? 'cinema-audio' : 'screen';
    for (const m of members) {
      if (!this._isMe(m.id)) this._outTo(m.id, channel);
    }
  }

  /** 新成员加入：正在共享 → 发起屏幕/声音连接 */
  peerJoined(member) {
    if (this._isMe(member.id)) return;
    if (this.localStream) this._outTo(member.id, 'screen');
    if (this.cinemaAudioStream) this._outTo(member.id, 'cinema-audio');
  }

  async _outTo(peerId, channel = 'screen') {
    const isAudio = channel === 'cinema-audio';
    const map = isAudio ? this.outAudio : this.outPcs;
    const stream = isAudio ? this.cinemaAudioStream : this.localStream;
    if (!stream) return;
    let pc = map.get(peerId);
    if (!pc) {
      pc = this._newPc(
        (st) => this.onPeerState?.(peerId, st, isAudio ? 'cinema-audio' : 'screen'),
        channel,
        peerId,
      );
      map.set(peerId, pc);
      pc.onnegotiationneeded = async () => {
        try {
          if (!isAudio) this._applyCodecPreferences(pc);
          await pc.setLocalDescription(await pc.createOffer());
          this.socket.signal(peerId, { type: 'offer', channel, sdp: pc.localDescription.sdp });
          if (!isAudio && this.preset) await applySendParams(pc, this.preset);
        } catch (err) {
          console.error('[webrtc] offer 失败', err);
        }
      };
    }
    for (const track of stream.getTracks()) {
      if (!pc.getSenders().some((s) => s.track === track)) pc.addTrack(track, stream);
    }
  }

  /** 影院模式：只把系统声音走 WebRTC（画面走 WebCodecs 中继） */
  startCinemaAudio(stream, members) {
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) return;
    this.cinemaAudioStream = new MediaStream(audioTracks);
    for (const m of members) {
      if (!this._isMe(m.id)) this._outTo(m.id, 'cinema-audio');
    }
  }

  stopCinemaAudio() {
    this.cinemaAudioStream = null;
    for (const [peerId, pc] of this.outAudio) {
      try { pc.close(); } catch { /* 忽略 */ }
      this.outAudio.delete(peerId);
    }
    for (const [peerId, pc] of this.inAudio) {
      try { pc.close(); } catch { /* 忽略 */ }
      this.inAudio.delete(peerId);
    }
  }

  outPcsList() {
    return [...this.outPcs.values()];
  }

  /** 共享中切换画质 */
  async applyPresetToAll(preset, { perPeerBitrate } = {}) {
    this.preset = preset;
    for (const [peerId, pc] of this.outPcs) {
      await applySendParams(pc, preset, { bitrate: perPeerBitrate?.get?.(peerId) ?? null });
    }
  }

  requestKeyframes() {
    for (const pc of this.outPcs.values()) requestKeyframe(pc);
  }

  stopSharing() {
    const stream = this.localStream;
    this.localStream = null;
    for (const [peerId, pc] of this.outPcs) {
      try { pc.close(); } catch { /* 忽略 */ }
      this.outPcs.delete(peerId);
    }
    stream?.getTracks().forEach((t) => { try { t.stop(); } catch { /* 忽略 */ } });
  }

  /** 对方停止共享 / 离开 → 关闭入站连接 */
  closeIncoming(peerId) {
    for (const map of [this.inPcs, this.inAudio]) {
      const pc = map.get(peerId);
      if (pc) {
        try { pc.close(); } catch { /* 忽略 */ }
        map.delete(peerId);
      }
    }
  }

  closeAll() {
    for (const map of [this.inPcs, this.outPcs, this.inAudio, this.outAudio]) {
      for (const pc of map.values()) { try { pc.close(); } catch { /* 忽略 */ } }
      map.clear();
    }
    for (const stream of [this.localStream, this.cinemaAudioStream]) {
      stream?.getTracks().forEach((t) => { try { t.stop(); } catch { /* 忽略 */ } });
    }
    this.localStream = null;
    this.cinemaAudioStream = null;
  }
}
