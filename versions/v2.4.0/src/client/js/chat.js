// chat.js — 房间文字聊天（侧栏「成员 / 聊天」页签；桌面与手机共用）
// 对应传输层接口：socket.chatSend(text) / onChatMessage(msg) / room:state.chat 历史
import { $, el, toast } from './core.js';

const MAX_KEEP = 300;   // 客户端最多保留的消息条数
const state = {
  messages: [],
  ids: new Set(),
  unread: 0,
  active: false,        // 聊天页签是否激活
  onSend: null,
};

function fmtTime(ts) {
  const d = new Date(ts || Date.now());
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function updateUnread() {
  const n = state.unread;
  for (const id of ['#chat-unread', '#chat-unread-mobile']) {
    const b = $(id);
    if (!b) continue;
    b.textContent = n > 99 ? '99+' : String(n);
    b.hidden = !n;
  }
}

function renderMessage(msg, selfId) {
  const list = $('#chat-list');
  if (!list) return;
  const mine = !!(msg.userId && selfId && msg.userId === selfId);
  const row = el('div', { class: 'chat-msg' + (mine ? ' mine' : '') },
    el('div', { class: 'chat-meta' },
      el('span', { class: 'chat-name', text: mine ? '我' : (msg.username || '好友') }),
      el('span', { class: 'chat-time', text: fmtTime(msg.ts) }),
    ),
    el('div', { class: 'chat-text', text: msg.text || '' }),
  );
  list.append(row);
  while (list.children.length > MAX_KEEP) list.removeChild(list.firstChild);
  if (state.active || mine) list.scrollTop = list.scrollHeight;
}

function renderAll(selfId) {
  const box = $('#chat-list');
  if (!box) return;
  box.innerHTML = '';
  for (const m of state.messages.slice(-MAX_KEEP)) renderMessage(m, selfId);
  box.scrollTop = box.scrollHeight;
}

export function initChat({ onSend } = {}) {
  state.onSend = onSend || null;
  const tabMembers = $('#tab-members');
  const tabChat = $('#tab-chat');
  const paneMembers = $('#pane-members');
  const paneChat = $('#pane-chat');

  const setTab = (chatOn) => {
    state.active = chatOn;
    tabChat?.classList.toggle('active', chatOn);
    tabMembers?.classList.toggle('active', !chatOn);
    if (paneChat) paneChat.hidden = !chatOn;
    if (paneMembers) paneMembers.hidden = chatOn;
    if (chatOn) {
      state.unread = 0;
      updateUnread();
      const list = $('#chat-list');
      if (list) list.scrollTop = list.scrollHeight;
      setTimeout(() => $('#chat-input')?.focus?.(), 60);
    }
  };
  tabMembers?.addEventListener('click', () => setTab(false));
  tabChat?.addEventListener('click', () => setTab(true));

  $('#chat-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = (input?.value || '').trim();
    if (!text) return;
    input.value = '';
    try {
      const res = await state.onSend?.(text.slice(0, 500));
      if (res?.error) toast(res.error, { kind: 'error', ms: 4000 });
    } catch (err) {
      toast('消息发送失败：' + (err?.message || err), { kind: 'error' });
    }
  });
}

/** 收到一条聊天消息 */
export function addChatMessage(msg, selfId) {
  if (!msg || !msg.id || state.ids.has(msg.id)) return;
  state.ids.add(msg.id);
  state.messages.push(msg);
  if (state.messages.length > MAX_KEEP) state.messages.shift();
  renderMessage(msg, selfId);
  const mine = !!(msg.userId && selfId && msg.userId === selfId);
  if (!state.active && !mine) {
    state.unread += 1;
    updateUnread();
  }
}

/** 合并房间状态里的历史消息（去重；用于刚进房 / 断线重连） */
export function mergeChatHistory(list, selfId) {
  if (!Array.isArray(list) || !list.length) return;
  let added = 0;
  for (const m of list) {
    if (!m || !m.id || state.ids.has(m.id)) continue;
    state.ids.add(m.id);
    state.messages.push(m);
    added += 1;
  }
  if (!added) return;
  state.messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  renderAll(selfId);
}

/** 离开房间时清空 */
export function clearChat() {
  state.messages = [];
  state.ids = new Set();
  state.unread = 0;
  const box = $('#chat-list');
  if (box) box.innerHTML = '';
  updateUnread();
}
