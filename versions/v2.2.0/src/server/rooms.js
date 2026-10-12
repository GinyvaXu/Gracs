// rooms.js — 房间 / 成员 / 共享状态（内存态）
// Gracs v2：一个服务器 = 一个房间（默认 "main"）；成员状态只有「屏幕共享」（含链路模式与画质）
// share = null | { mode:'webrtc'|'cinema', preset, title, width, height, fps, bitrate, since, cinema? }
const MAX_USERS_PER_ROOM = 12;
const MAX_TITLE = 40;

function sanitizeShare(share) {
  if (!share || typeof share !== 'object') return null;
  const mode = share.mode === 'cinema' ? 'cinema' : 'webrtc';
  return {
    mode,
    preset: String(share.preset || 'auto').slice(0, 16),
    title: String(share.title || '').slice(0, MAX_TITLE),
    width: clampInt(share.width, 0, 0, 7680),
    height: clampInt(share.height, 0, 0, 4320),
    fps: clampInt(share.fps, 0, 0, 240),
    bitrate: clampInt(share.bitrate, 0, 0, 200_000_000),   // 最高 200 Mbps
    hw: share.hw === true,                                  // 是否硬件编码（影院模式）
    codec: share.codec ? String(share.codec).slice(0, 32) : '',
    since: Number(share.since) || Date.now(),
    audio: share.audio !== false,
  };
}

function clampInt(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.room = null;
  }

  getDefaultRoom() {
    if (!this.room) {
      this.room = { id: 'main', createdAt: Date.now(), users: new Map() };
      this.rooms.set(this.room.id, this.room);
    }
    return this.room;
  }

  joinRoom(socketId, username) {
    const room = this.getDefaultRoom();
    if (room.users.has(socketId)) return { error: '已在该房间中' };
    if (room.users.size >= MAX_USERS_PER_ROOM) return { error: `房间已满（最多 ${MAX_USERS_PER_ROOM} 人）` };
    const user = {
      id: socketId,
      username: String(username || '观众').slice(0, 16) || '观众',
      share: null,
      joinedAt: Date.now(),
    };
    room.users.set(socketId, user);
    return { room, user };
  }

  setShare(room, socketId, share) {
    const user = room.users.get(socketId);
    if (!user) return null;
    user.share = sanitizeShare(share);
    return user;
  }

  /** 影院模式元数据补齐（编码参数确认后回填，供后来者解码） */
  setCinemaMeta(room, socketId, meta) {
    const user = room.users.get(socketId);
    if (!user || user.share?.mode !== 'cinema') return null;
    user.share.cinema = {
      codec: String(meta?.codec || '').slice(0, 64),
      codedWidth: clampInt(meta?.codedWidth, 0, 0, 7680),
      codedHeight: clampInt(meta?.codedHeight, 0, 0, 4320),
      description: typeof meta?.description === 'string' ? meta.description.slice(0, 4096) : null,
      hw: meta?.hw === true,
    };
    return user;
  }

  leaveRoom(socketId) {
    const room = this.getDefaultRoom();
    if (room.users.delete(socketId)) return { room, roomId: room.id };
    return null;
  }

  serialize(room) {
    return {
      id: room.id,
      users: [...room.users.values()].map((u) => ({ ...u, share: u.share ? { ...u.share } : null })),
    };
  }
}

export { MAX_USERS_PER_ROOM };
