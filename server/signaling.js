// signaling.js — Socket.IO 信令层
// 职责：房间/成员/共享状态 + WebRTC 信令转发 + 影院模式（WebCodecs）码流中继
// 媒体面：WebRTC 走 P2P 不经过服务器；影院模式经服务器转发（仍是端到端可选的加密流）
import { logger } from './logger.js';

const MAX_CHUNK_BYTES = 1_048_576;     // 单批码流上限 1MB（防滥用）
const MAX_SIGNAL_BYTES = 262_144;      // 单条 SDP/ICE 上限

export function setupSignaling(io, rooms, opts = {}) {
  const logStats = opts.logStats !== false;

  io.on('connection', (socket) => {
    logger.work(`client connected ${socket.id} (${io.engine.clientsCount} 在线)`);

    socket.on('client:error', ({ message, stack, url } = {}) => {
      logger.error(`[client:${socket.id}] JS错误: ${message}`, stack ? `\n${stack}` : '', url ? `url=${url}` : '');
    });

    socket.on('room:create', ({ username } = {}, ack) => join(username, ack));
    socket.on('room:join', ({ username } = {}, ack) => join(username, ack));

    function join(username, ack) {
      const res = rooms.joinRoom(socket.id, username);
      if (res.error) return ack?.({ error: res.error });
      socket.join(res.room.id);
      socket.data.roomId = res.room.id;
      const me = res.room.users.get(socket.id);
      // 通知房内已有成员：新成员加入（正在共享的人会向新成员发起连接）
      socket.to(res.room.id).emit('member:joined', {
        user: { id: socket.id, username: me.username, share: null, joinedAt: me.joinedAt },
      });
      io.to(res.room.id).emit('room:state', rooms.serialize(res.room));
      logger.work(`room:join ${res.room.id} user=${me.username} by ${socket.id} (共 ${res.room.users.size} 人)`);
      ack?.({ roomId: res.room.id, roomState: rooms.serialize(res.room) });
    }

    socket.on('room:leave', (_payload, ack) => {
      leaveRoom(socket);
      ack?.({ ok: true });
    });

    // 共享状态切换：share = {mode, preset, title, width, height, fps, bitrate} 或 null
    socket.on('share:update', ({ share } = {}, ack) => {
      const room = rooms.rooms.get(socket.data.roomId);
      if (!room) return ack?.({ ok: false, error: '不在房间中' });
      const user = rooms.setShare(room, socket.id, share);
      if (!user) return ack?.({ ok: false, error: '成员不存在' });
      socket.to(room.id).emit('share:update', { id: socket.id, share: user.share });
      io.to(room.id).emit('room:state', rooms.serialize(room));
      logger.work(`share:update room=${room.id} user=${user.username} ${user.share ? `${user.share.mode}/${user.share.preset} ${user.share.width}x${user.share.height}@${user.share.fps}` : '已停止'}`);
      ack?.({ ok: true, share: user.share });
    });

    // 影院模式：编码参数公告（后来者可据此初始化解码器）
    socket.on('cinema:meta', ({ meta } = {}) => {
      const room = rooms.rooms.get(socket.data.roomId);
      if (!room) return;
      const user = rooms.setCinemaMeta(room, socket.id, meta || {});
      if (!user) return;
      socket.to(room.id).emit('cinema:meta', { id: socket.id, meta: user.share.cinema });
      io.to(room.id).emit('room:state', rooms.serialize(room));
      logger.debug(`cinema:meta ${user.username} codec=${user.share.cinema.codec} ${user.share.cinema.codedWidth}x${user.share.cinema.codedHeight}`);
    });

    // 影院模式：码流批次（二进制，volatile：拥塞时直接丢弃，保证低延迟不积压）
    // 注：这是高频热路径（每十几毫秒一条），默认不逐条写日志，只累计计数。
    socket.on('cinema:chunk', (batch) => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const size = batch?.byteLength || batch?.length || 0;
      if (!size || size > MAX_CHUNK_BYTES) return;
      socket.data.cinemaChunks = (socket.data.cinemaChunks || 0) + 1;
      socket.data.cinemaBytes = (socket.data.cinemaBytes || 0) + size;
      socket.volatile.to(roomId).emit('cinema:chunk', { id: socket.id, batch });
      if (logStats && socket.data.cinemaChunks % 500 === 0) {
        logger.debug(`cinema:chunk ${socket.id} 累计 ${socket.data.cinemaChunks} 批 / ${Math.round(socket.data.cinemaBytes / 1024)} KB`);
      }
    });

    // 影院模式：观看端反馈（丢帧/吞吐）→ 转发给共享者做码率自适应
    socket.on('cinema:feedback', ({ stats } = {}) => {
      const roomId = socket.data.roomId;
      if (!roomId || !socket.data.cinemaShare) return;
      io.to(socket.data.cinemaShare).emit('cinema:feedback', { id: socket.id, stats });
    });

    // 影院模式：请求关键帧（新观看者入房/花屏恢复）
    socket.on('cinema:keyframe', () => {
      const roomId = socket.data.roomId;
      if (!roomId || !socket.data.cinemaShare) return;
      io.to(socket.data.cinemaShare).emit('cinema:keyframe-request', { id: socket.id });
    });

    // 观看端声明自己在看哪路影院流（用于反馈/关键帧路由）
    socket.on('cinema:watch', ({ id } = {}) => {
      socket.data.cinemaShare = typeof id === 'string' ? id : null;
    });

    // 聊天（文字）：广播 + 保留最近记录（新成员在 room:state 里拿到最近 50 条）
    socket.on('chat:send', ({ text } = {}, ack) => {
      const room = rooms.rooms.get(socket.data.roomId);
      if (!room) return ack?.({ ok: false, error: '不在房间中' });
      if (Date.now() - (socket.data.chatAt || 0) < 250) return ack?.({ ok: false, error: '发送太快，稍后再试' });
      socket.data.chatAt = Date.now();
      const msg = rooms.addChat(room, socket.id, text);
      if (!msg) return ack?.({ ok: false, error: '消息为空或过长' });
      io.to(room.id).emit('chat:message', msg);
      ack?.({ ok: true, message: msg });
    });

    // WebRTC 信令转发（offer / answer / ice）
    socket.on('signal', ({ to, data } = {}) => {
      if (typeof to !== 'string' || !data) return;
      const size = JSON.stringify(data).length;
      if (size > MAX_SIGNAL_BYTES) {
        logger.error(`signal 过大被丢弃 ${socket.id} -> ${to} (${size}B)`);
        return;
      }
      logger.debug(`signal relay ${socket.id} -> ${to} (${data?.type || 'ice'}${data?.channel ? '/' + data.channel : ''})`);
      io.to(to).emit('signal', { from: socket.id, data });
    });

    socket.on('disconnect', () => {
      logger.work(`client disconnected ${socket.id} (${io.engine.clientsCount} 在线)`);
      leaveRoom(socket);
    });
  });

  function leaveRoom(socket) {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const left = rooms.leaveRoom(socket.id);
    if (left) {
      socket.leave(roomId);
      socket.to(roomId).emit('member:left', { id: socket.id });
      io.to(roomId).emit('room:state', rooms.serialize(left.room));
    }
    delete socket.data.roomId;
    delete socket.data.cinemaShare;
  }
}
