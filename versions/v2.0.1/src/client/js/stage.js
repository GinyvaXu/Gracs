// stage.js — 舞台渲染：主画面 + 缩略条，瓦片工具（画中画/全屏/比例/音量/质量）
import { el, $, clamp, storage, toast } from './core.js';

export class Stage {
  constructor({ mainEl, stripEl, onFocus, onAction }) {
    this.mainEl = mainEl;
    this.stripEl = stripEl;
    this.onFocus = onFocus;
    this.onAction = onAction;
    this.tiles = new Map();   // id -> { root, media, audio, badge, kind, view }
    this.focused = null;
    this.aspect = storage.get('aspect', 'auto');
  }

  setAspect(mode) {
    this.aspect = mode;
    storage.set('aspect', mode);
    for (const t of this.tiles.values()) this._applyAspect(t);
  }

  getTile(id) {
    return this.tiles.get(id);
  }

  clear() {
    for (const [id] of this.tiles) this._remove(id);
    this.mainEl.innerHTML = '';
    this.stripEl.innerHTML = '';
  }

  _remove(id) {
    const tile = this.tiles.get(id);
    if (!tile) return;
    try { if (tile.media?.srcObject) tile.media.srcObject = null; } catch { /* 忽略 */ }
    tile.root.remove();
    this.tiles.delete(id);
  }

  /** views: [{ id, kind:'video'|'canvas'|'empty', stream?, canvas?, audioEl?, title, badge:{text,level}, isLocal, note }] */
  render(views, focused) {
    const ids = new Set(views.map((v) => v.id));
    for (const id of [...this.tiles.keys()]) if (!ids.has(id)) this._remove(id);

    if (!views.length) {
      this.mainEl.innerHTML = '';
      this.stripEl.innerHTML = '';
      this.mainEl.append(this._emptyState());
      return;
    }
    const target = focused && ids.has(focused) ? focused : views[0].id;
    this.focused = target;
    const mainView = views.find((v) => v.id === target);
    const others = views.filter((v) => v.id !== target);

    const mainTile = this._ensureTile(mainView, true);
    if (this.mainEl.firstChild !== mainTile.root) this.mainEl.replaceChildren(mainTile.root);

    this.stripEl.innerHTML = '';
    const tiles = others.map((v) => this._ensureTile(v, false));
    // 缩略条按加入顺序稳定排序
    tiles.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const t of tiles) {
      this.stripEl.append(t.root);
      t.root.onclick = () => this.onFocus?.(t.view.id);
    }
  }

  _emptyState() {
    return el('div', { class: 'tile main' },
      el('div', { class: 'tile-empty' },
        el('div', { class: 'big-icon', text: '🖥️' }),
        el('div', { class: 'title', text: '还没有人共享屏幕' }),
        el('div', { text: '点击下方「共享屏幕」，让大家一起看' }),
        el('button', {
          class: 'btn primary big', text: '共享屏幕', style: { marginTop: '10px' },
          onclick: () => this.onAction?.('empty', 'share'),
        }),
      ),
    );
  }

  _ensureTile(view, isMain) {
    let tile = this.tiles.get(view.id);
    if (!tile || tile.kind !== view.kind) {
      if (tile) this._remove(view.id);
      tile = this._createTile(view);
      this.tiles.set(view.id, tile);
    }
    tile.view = view;
    tile.order ??= this.tiles.size;
    this._syncTile(tile, view, isMain);
    return tile;
  }

  _createTile(view) {
    const tile = { root: null, media: null, audio: null, badgeEl: null, badgeText: null, kind: view.kind, view, order: 0 };
    const root = el('div', { class: 'tile' });
    tile.root = root;
    let media = null;
    let audio = null;
    if (view.kind === 'video') {
      media = el('video', { autoplay: '', playsinline: '', muted: view.isLocal });
      media.muted = !!view.isLocal;
      root.append(media);
    } else if (view.kind === 'canvas') {
      media = view.canvas || el('canvas');
      root.append(media);
      if (view.audioEl) { audio = view.audioEl; audio.style.display = 'none'; root.append(audio); }
    }
    tile.media = media;
    tile.audio = audio;

    const top = el('div', { class: 'tile-top' },
      el('span', { class: 'tile-name', text: view.title || '' }),
      el('span', { class: 'tile-badge' }, el('span', { class: 'dot' }), el('span', { class: 'badge-text', text: view.badge?.text || '连接中' })),
    );
    root.append(top);
    tile.badgeEl = top.querySelector('.tile-badge');
    tile.badgeText = top.querySelector('.badge-text');

    // 工具栏（全屏 / 画中画 / 比例 / 音量 / 质量）
    const tools = el('div', { class: 'tile-tools' });
    if (view.kind !== 'empty') {
      const aspect = el('select', { title: '画面比例' },
        el('option', { value: 'auto', text: '自适应' }),
        el('option', { value: '169', text: '16:9' }),
        el('option', { value: 'original', text: '原始' }),
        el('option', { value: 'stretch', text: '拉伸' }),
      );
      aspect.value = this.aspect;
      aspect.addEventListener('change', () => {
        this.setAspect(aspect.value);
        for (const t of this.tiles.values()) { const s = t.root.querySelector('select'); if (s) s.value = aspect.value; }
      });
      aspect.addEventListener('click', (e) => e.stopPropagation());
      tools.append(aspect);

      const pip = view.kind === 'video'
        ? el('button', { class: 'icon-btn', text: '⧉ 画中画', title: '弹出为系统小窗，可置顶', onclick: (e) => { e.stopPropagation(); this._pip(tile); } })
        : null;
      if (pip) tools.append(pip);
      const fs = el('button', { class: 'icon-btn', text: '⛶ 全屏', title: '全屏观看（Esc 退出）', onclick: (e) => { e.stopPropagation(); this._fullscreen(tile); } });
      tools.append(fs);
      const stats = el('button', { class: 'icon-btn', text: '📶', title: '查看该画面的连接质量', onclick: (e) => { e.stopPropagation(); this.onAction?.(view.id, 'stats'); } });
      tools.append(stats);

      const vol = el('div', { class: 'tile-volume' },
        el('span', { text: '🔊' }),
        el('input', {
          type: 'range', min: '0', max: '150', value: '100', title: '音量',
          oninput: (e) => {
            e.stopPropagation();
            const v = Number(e.target.value) / 100;
            const target = tile.audio || tile.media;
            if (target) target.volume = clamp(v, 0, 1.5);
          },
          onclick: (e) => e.stopPropagation(),
        }),
      );
      tools.append(vol);
    }
    root.append(tools);
    root.addEventListener('click', () => {
      if (root.parentElement === this.stripEl) this.onFocus?.(view.id);
      else root.classList.toggle('pinned');
    });
    return tile;
  }

  _syncTile(tile, view, isMain) {
    tile.root.classList.toggle('main', !!isMain);
    const nameEl = tile.root.querySelector('.tile-name');
    if (nameEl && nameEl.textContent !== view.title) nameEl.textContent = view.title || '';
    if (tile.badgeText) tile.badgeText.textContent = view.badge?.text || '连接中';
    if (tile.badgeEl) {
      tile.badgeEl.classList.remove('good', 'fair', 'poor');
      if (view.badge?.level) tile.badgeEl.classList.add(view.badge.level);
    }
    tile.root.classList.toggle('audio-only', view.kind === 'audio');
    if (view.kind === 'video' && tile.media && tile.media.srcObject !== view.stream) {
      tile.media.srcObject = view.stream;
      tile.media.play?.().catch(() => { /* 自动播放被拦时用户手势后恢复 */ });
    }
    // 影院模式：音频由独立的 <audio> 播放（画面是 canvas）
    if (view.audioEl && tile.audio !== view.audioEl) {
      tile.audio = view.audioEl;
      if (!view.audioEl.isConnected) {
        view.audioEl.style.display = 'none';
        tile.root.append(view.audioEl);
      }
    }
    this._applyAspect(tile);
  }

  _applyAspect(tile) {
    if (!tile.media || tile.kind !== 'video') return;
    const mode = this.aspect;
    tile.root.classList.remove('aspect-auto', 'aspect-169', 'aspect-original', 'aspect-stretch');
    tile.root.classList.add('aspect-' + mode);
    if (mode === 'stretch') tile.media.style.objectFit = 'fill';
    else if (mode === 'original') tile.media.style.objectFit = 'none';
    else tile.media.style.objectFit = 'contain';
  }

  async _pip(tile) {
    const media = tile.media;
    if (!media) return;
    try {
      if (document.pictureInPictureElement === media) await document.exitPictureInPicture();
      else if (media.requestPictureInPicture) await media.requestPictureInPicture();
      else toast('当前画面不支持画中画');
    } catch (err) {
      toast('画中画不可用：' + (err?.message || err));
    }
  }

  async _fullscreen(tile) {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await tile.root.requestFullscreen();
    } catch (err) {
      toast('全屏不可用：' + (err?.message || err));
    }
  }

  /** 更新某个瓦片角标（不整体重绘） */
  setBadge(id, badge) {
    const tile = this.tiles.get(id);
    if (!tile?.badgeText) return;
    tile.badgeText.textContent = badge?.text || '连接中';
    tile.badgeEl.classList.remove('good', 'fair', 'poor');
    if (badge?.level) tile.badgeEl.classList.add(badge.level);
  }
}
