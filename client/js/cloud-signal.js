// cloud-signal.js — 「云房间」传输层（Project4 云信令：JSON over WebSocket）
// 与 signaling.js 保持完全相同的接口，main.js 可无感切换「本机服务器 / 云房间」两种连接方式。
// 协议：{ t: "room:create" | "room:join" | "signal" | "share:update" | "voice:update" | "leave", ... }
// 服务端：Project4（Cloudflare Workers + Durable Objects，gracs.ginyva.site）
// 保活：客户端发纯文本 "ping"，服务端 WebSocket 自动回 "pong"（不唤醒计费）。

export function connectCloudSignaling(options) {
  const {
    getUrl,
    onState, onSignal, onMemberJoined, onMemberLeft, onShareUpdate, onVoiceUpdate, onError,
  } = options;

  let ws = null;
  let selfId = null;
  let closedByUser = false;
  let connectPromise = null;
  let currentCode = "";
  let ridSeq = 0;
  const pending = new Map();
  let pingTimer = null;

  function relayUrl() {
    return typeof getUrl === "function" ? getUrl() : getUrl;
  }
  function httpBase() {
    const u = new URL(relayUrl());
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    return u.origin;
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  function request(obj) {
    return new Promise((resolve) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return resolve({ error: "云信令未连接" });
      const rid = ++ridSeq;
      obj.rid = rid;
      pending.set(rid, resolve);
      send(obj);
      setTimeout(() => {
        if (pending.has(rid)) { pending.delete(rid); resolve({ error: "云信令响应超时" }); }
      }, 12000);
    });
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send("ping"); }, 25000);
  }
  function stopPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  function handle(msg) {
    switch (msg.t) {
      case "welcome":
        selfId = msg.selfId;
        break;
      case "room:state":
        if (msg.room) onState?.(msg.room);
        break;
      case "member:joined": onMemberJoined?.(msg.user); break;
      case "member:left": onMemberLeft?.(msg.id); break;
      case "share:update": onShareUpdate?.(msg.id, msg.share); break;
      case "voice:update": onVoiceUpdate?.(msg.id, msg.voice); break;
      case "signal": onSignal?.({ from: msg.from, data: msg.data }); break;
      case "ack": {
        const r = pending.get(msg.rid);
        if (r) { pending.delete(msg.rid); r(msg); }
        break;
      }
      case "err": {
        const r = pending.get(msg.rid);
        if (r) { pending.delete(msg.rid); r({ error: msg.message || "云信令错误" }); }
        else onError?.(msg.message || "云信令错误");
        break;
      }
      default: break;
    }
  }

  // 建立连接（code 会拼进 /ws?code= 供服务端路由到对应房间）
  function connectWithCode(code) {
    const url = relayUrl() + (relayUrl().includes("?") ? "&" : "?") + "code=" + encodeURIComponent(code);
    ws = new WebSocket(url);
    ws.onmessage = (ev) => {
      if (ev.data === "pong") return;
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      handle(msg);
    };
    ws.onclose = () => {
      stopPing();
      connectPromise = null;
      pending.forEach((r) => r({ error: "与云信令的连接已断开" }));
      pending.clear();
      if (!closedByUser) onError?.("与云信令的连接已断开");
    };
    ws.onerror = () => { /* onclose 兜底 */ };
    return new Promise((resolve, reject) => {
      ws.onopen = () => { startPing(); resolve(); };
      setTimeout(() => {
        if (ws && ws.readyState !== WebSocket.OPEN) reject(new Error("连接云信令超时"));
      }, 12000);
    });
  }

  async function ensureConnected(code) {
    if (ws && ws.readyState === WebSocket.OPEN && code === currentCode) return;
    if (connectPromise) { await connectPromise; return; }
    if (ws) { try { closedByUser = true; ws.close(); } catch { /* 忽略 */ } closedByUser = false; ws = null; }
    currentCode = code;
    connectPromise = connectWithCode(code);
    try {
      await connectPromise;
    } finally {
      connectPromise = null;
    }
  }

  async function createRoom(username) {
    // 服务端分配一个空闲房间码（/api/room/new），再拉起到该房间的 WS
    const resp = await fetch(httpBase() + "/api/room/new", { method: "GET" });
    const d = await resp.json().catch(() => null);
    if (!d || !d.ok || !d.code) return { error: (d && d.error) || "获取云房间码失败" };
    await ensureConnected(d.code);
    const res = await request({ t: "room:create", username, code: d.code });
    if (res.error) return res;
    return Object.assign({ code: d.code }, res);
  }

  async function joinRoom(username, code) {
    const roomCode = String(code || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(roomCode)) return { error: "请输入 4-8 位房间码" };
    await ensureConnected(roomCode);
    const res = await request({ t: "room:join", username, code: roomCode });
    if (res.error) return res;
    return Object.assign({ code: roomCode }, res);
  }

  return {
    isCloud: true,
    id: () => selfId,
    createRoom: (username) => createRoom(username).catch((e) => ({ error: "创建云房间失败：" + (e?.message || e) })),
    joinRoom: (username, code) => joinRoom(username, code).catch((e) => ({ error: "加入云房间失败：" + (e?.message || e) })),
    leaveRoom: () => {
      closedByUser = true;
      stopPing();
      try { ws?.close(1000, "leave"); } catch { /* 忽略 */ }
      ws = null;
      return Promise.resolve({ ok: true });
    },
    setShare: (share) => request({ t: "share:update", share }),
    setVoice: (voice) => request({ t: "voice:update", voice }),
    signal: (to, data) => send({ t: "signal", to, data }),
    reportError: () => {},
  };
}
