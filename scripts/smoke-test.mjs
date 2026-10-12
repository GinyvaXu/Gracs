// smoke-test.mjs — Gracs v2 端到端冒烟测试（信令 + 影院模式中继 + HTTP 接口）
// 用法：终端 1 `npm start`，终端 2 `npm test`（可用 TEST_URL 指向其它地址）
import { io } from 'socket.io-client';

const URL = process.env.TEST_URL || 'http://localhost:3000';
const results = [];
const assert = (name, cond, extra = '') => {
  results.push([name, !!cond, extra]);
  console.log(`${cond ? '[OK]  ' : '[FAIL]'} ${name}${extra ? ' — ' + extra : ''}`);
};
const timeout = setTimeout(() => {
  console.log('\n⏰ 全局超时');
  process.exit(2);
}, 30_000);

function connect(name) {
  return new Promise((resolve, reject) => {
    const s = io(URL, { transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (err) => reject(new Error(`${name}: ${err.message}`)));
  });
}
const emitAck = (socket, event, payload = {}) =>
  new Promise((resolve) => socket.emit(event, payload, (res) => resolve(res || { ok: true })));
const waitEvent = (socket, event, ms = 5000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${event} 超时`)), ms);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
/** 等一个满足条件的特定事件（用于多成员场景，避免消费到别人的同类事件） */
const waitEventWhere = (socket, event, pred, ms = 5000) =>
  new Promise((resolve, reject) => {
    const onEvt = (payload) => {
      if (!pred || pred(payload)) { clearTimeout(timer); socket.off(event, onEvt); resolve(payload); }
    };
    const timer = setTimeout(() => { socket.off(event, onEvt); reject(new Error(`等待 ${event} 超时`)); }, ms);
    socket.on(event, onEvt);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── HTTP 接口 ──
console.log(`\n▶ HTTP 接口 (${URL})`);
try {
  const cfg = await (await fetch(`${URL}/api/config`)).json();
  assert('GET /api/config 返回版本与能力', !!cfg.version && cfg.features?.cinema === true, `v${cfg.version}`);
  assert('config 含 STUN 列表', Array.isArray(cfg.stunServers) && cfg.stunServers.length > 0, cfg.stunServers?.join(','));
} catch (err) { assert('GET /api/config', false, String(err.message)); }

try {
  const ice = await (await fetch(`${URL}/api/ice?user=smoke`)).json();
  assert('GET /api/ice 返回 iceServers', Array.isArray(ice.iceServers) && ice.iceServers.length > 0, `共 ${ice.iceServers?.length} 项`);
  assert('ICE 含 TURN 状态字段', ice.turn && typeof ice.turn.enabled === 'boolean', ice.turn ? `enabled=${ice.turn.enabled} ready=${ice.turn.ready}` : '缺失');
  if (ice.iceServers.some((s) => String(s.urls).includes('turn:'))) {
    const turn = ice.iceServers.find((s) => String(s.urls).includes('turn:'));
    assert('TURN 含临时凭据', !!turn.username && !!turn.credential);
  }
} catch (err) { assert('GET /api/ice', false, String(err.message)); }

try {
  const net = await (await fetch(`${URL}/api/network`)).json();
  assert('GET /api/network 返回诊断判定', Array.isArray(net.verdict) && net.verdict.length > 0, `共 ${net.verdict?.length} 条`);
  assert('诊断含地址列表', !!net.addresses?.lan, (net.addresses?.lan || []).join(' '));
} catch (err) { assert('GET /api/network', false, String(err.message)); }

try {
  const qr = await fetch(`${URL}/api/qr.svg?text=${encodeURIComponent(URL + '?autojoin=1')}`);
  const svg = await qr.text();
  assert('GET /api/qr.svg 返回二维码', qr.ok && svg.includes('<svg'), `${svg.length} 字节`);
} catch (err) { assert('GET /api/qr.svg', false, String(err.message)); }

// ── 信令 + 房间 ──
console.log('\n▶ 信令 / 房间 / 共享状态');
const A = await connect('A');
const B = await connect('B');
console.log('已连接两个测试客户端');

const created = await emitAck(A, 'room:create', { username: 'Alice' });
assert('A 创建房间（默认 main）', created.roomId === 'main', created.roomId);
assert('A 获得房间状态（含自己）', created.roomState?.users?.some((u) => u.username === 'Alice'));

const memberJoinedA = waitEvent(A, 'member:joined');
const joined = await emitAck(B, 'room:join', { username: 'Bob' });
assert('B 加入房间', !joined.error && joined.roomId === 'main');
assert('B 收到房间状态（含 A/B）', joined.roomState?.users?.some((u) => u.username === 'Alice') && joined.roomState?.users?.some((u) => u.username === 'Bob'));
const mj = await memberJoinedA;
assert('A 收到 member:joined(B)', mj.user?.username === 'Bob' && mj.user?.share === null);

// 共享状态（标准链路）
const shareUpdateB = waitEvent(B, 'share:update');
const shareRes = await emitAck(A, 'share:update', { share: { mode: 'webrtc', preset: 'auto', width: 1920, height: 1080, fps: 30, bitrate: 8_000_000 } });
assert('A 设置共享状态成功', shareRes.ok && shareRes.share?.mode === 'webrtc');
const su = await shareUpdateB;
assert('B 收到 share:update', su.id === A.id && su.share?.mode === 'webrtc', JSON.stringify(su.share));

// WebRTC 信令转发
const signalB = waitEvent(B, 'signal');
A.emit('signal', { to: B.id, data: { type: 'offer', channel: 'screen', sdp: 'FAKE_OFFER' } });
const got = await signalB;
assert('信令转发 A→B(offer)', got.from === A.id && got.data.type === 'offer' && got.data.channel === 'screen');
const signalA = waitEvent(A, 'signal');
B.emit('signal', { to: A.id, data: { type: 'answer', channel: 'screen', sdp: 'FAKE_ANSWER' } });
const got2 = await signalA;
assert('信令转发 B→A(answer)', got2.from === B.id && got2.data.type === 'answer');
const iceSignalA = waitEvent(A, 'signal');
B.emit('signal', { to: A.id, data: { type: 'ice', channel: 'screen', candidate: { candidate: 'candidate:1' } } });
const got3 = await iceSignalA;
assert('信令转发 B→A(ice)', got3.data.type === 'ice');

// ── 影院模式 ──
console.log('\n▶ 影院模式（WebCodecs 码流中继）');
const metaRes = await emitAck(A, 'share:update', { share: { mode: 'cinema', preset: 'movie', width: 1920, height: 1080, fps: 30, bitrate: 8_000_000 } });
assert('A 切换影院模式共享', metaRes.ok && metaRes.share?.mode === 'cinema');
const metaB = waitEvent(B, 'cinema:meta', 4000).catch(() => null);
A.emit('cinema:meta', { meta: { codec: 'avc1.42002A', codedWidth: 1920, codedHeight: 1080, description: null, hw: true } });
const meta = await metaB;
assert('B 收到 cinema:meta', meta?.meta?.codec === 'avc1.42002A', meta ? meta.meta.codec : '未收到');

// 码流批次转发（二进制保持字节一致）
const chunkB = waitEvent(B, 'cinema:chunk', 4000).catch(() => null);
const payload = new Uint8Array([1, 2, 1, 0, ...new Array(64).fill(7)]);
A.emit('cinema:chunk', payload);
const chunk = await chunkB;
assert('B 收到 cinema:chunk 二进制批次', chunk && Buffer.from(chunk.batch).length === payload.length, chunk ? `${Buffer.from(chunk.batch).length} 字节` : '未收到');
assert('码流字节一致', chunk && Buffer.compare(Buffer.from(chunk.batch), Buffer.from(payload)) === 0);

// 关键帧请求 / 反馈 路由
B.emit('cinema:watch', { id: A.id });
await sleep(150);
const kfA = waitEvent(A, 'cinema:keyframe-request', 4000).catch(() => null);
B.emit('cinema:keyframe', {});
const kf = await kfA;
assert('A 收到观看端关键帧请求', kf?.id === B.id);

const fbA = waitEvent(A, 'cinema:feedback', 4000).catch(() => null);
B.emit('cinema:feedback', { stats: { fps: 29, kbps: 6200, dropped: 0 } });
const fb = await fbA;
assert('A 收到观看端质量反馈', fb?.stats?.kbps === 6200);

// 共享停止
const stopB = waitEvent(B, 'share:update', 4000);
await emitAck(A, 'share:update', { share: null });
const stop = await stopB;
assert('停止共享广播 share=null', stop.id === A.id && stop.share === null);

// ── 聊天 ──
console.log('\n▶ 聊天');
const chatMsgB = waitEvent(B, 'chat:message', 4000).catch(() => null);
const chatRes = await emitAck(A, 'chat:send', { text: ' 大家好，一起看电影  ' });
const cm = await chatMsgB;
assert('A 发送聊天，B 收到广播', !!cm && cm.username === 'Alice' && cm.text === '大家好，一起看电影', cm ? `${cm.username}: ${cm.text}` : '未收到');
assert('聊天 ack 返回消息', chatRes.ok && !!chatRes.message?.id);
await sleep(350);   // 越过 250ms 限速，验证空消息拒绝
const emptyRes = await emitAck(A, 'chat:send', { text: '   ' });
assert('空消息被拒绝', !emptyRes.ok && !!emptyRes.error, emptyRes.error);
const C = await connect('C');
const joinedC = await emitAck(C, 'room:join', { username: 'Carol' });
assert('新成员拿到最近聊天记录', Array.isArray(joinedC.roomState?.chat) && joinedC.roomState.chat.some((m) => m.text.includes('一起看电影')), `共 ${joinedC.roomState?.chat?.length ?? 0} 条`);
C.emit('room:leave');

// ── 离开清理 ──
console.log('\n▶ 离开与清理');
const memberLeftA = waitEventWhere(A, 'member:left', (p) => p?.id === B.id);
await emitAck(B, 'room:leave');
const ml = await memberLeftA;
assert('A 收到 member:left(B)', ml.id === B.id);

A.emit('room:leave');
await sleep(300);

const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) console.log('失败项：\n' + failed.map((f) => `  ❌ ${f[0]} ${f[2]}`).join('\n'));
clearTimeout(timeout);
process.exit(failed.length ? 1 : 0);
