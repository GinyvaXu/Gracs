// signaling.js — Socket.IO 客户端封装
// 房间/成员/共享状态 + WebRTC 信令 + 影院模式（码流中继 / 反馈 / 关键帧）
export function connectSignaling(handlers = {}) {
  const socket = io({ transports: ['websocket', 'polling'], reconnectionDelayMax: 4000 });

  socket.on('connect', () => handlers.onConnect?.());
  socket.on('disconnect', (reason) => handlers.onDisconnect?.(reason));
  socket.on('connect_error', (err) => handlers.onConnectError?.(err));
  socket.on('room:state', (s) => handlers.onRoomState?.(s));
  socket.on('member:joined', (p) => handlers.onMemberJoined?.(p.user));
  socket.on('member:left', (p) => handlers.onMemberLeft?.(p.id));
  socket.on('share:update', (p) => handlers.onShareUpdate?.(p.id, p.share));
  socket.on('signal', (p) => handlers.onSignal?.(p.from, p.data));
  socket.on('cinema:meta', (p) => handlers.onCinemaMeta?.(p.id, p.meta));
  socket.on('cinema:chunk', (p) => handlers.onCinemaChunk?.(p.id, p.batch));
  socket.on('cinema:feedback', (p) => handlers.onCinemaFeedback?.(p.id, p.stats));
  socket.on('cinema:keyframe-request', (p) => handlers.onCinemaKeyframeRequest?.(p.id));

  const emitAck = (event, payload = {}, timeoutMs = 8000) =>
    new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve({ error: '服务器无响应' }); } }, timeoutMs);
      socket.emit(event, payload, (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(res || { ok: true });
      });
    });

  return {
    raw: socket,
    id: () => socket.id,
    connected: () => socket.connected,
    join: (username) => emitAck('room:join', { username }),
    leave: () => emitAck('room:leave', {}),
    setShare: (share) => emitAck('share:update', { share }),
    signal: (to, data) => socket.emit('signal', { to, data }),
    cinemaMeta: (meta) => socket.emit('cinema:meta', { meta }),
    /** 影院模式码流批次（二进制，服务端 volatile 转发） */
    cinemaChunk: (batch) => socket.emit('cinema:chunk', batch),
    /** 声明正在观看哪路影院流（反馈/关键帧路由用） */
    cinemaWatch: (id) => socket.emit('cinema:watch', { id }),
    cinemaKeyframe: () => socket.emit('cinema:keyframe', {}),
    cinemaFeedback: (stats) => socket.emit('cinema:feedback', { stats }),
    reportError: (payload) => socket.emit('client:error', payload),
  };
}
