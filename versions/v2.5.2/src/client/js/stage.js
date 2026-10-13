// stage.js — 舞台渲染：主画面 + 缩略条，瓦片工具（画中画/全屏/比例/音量/质量）
import { el, $, clamp, storage, toast } from './core.js';

export class Stage {
  constructor({ mainEl, stripEl, onFocus, onAction, onFullscreenChange }) {
    this.mainEl = mainEl;
    this.stripEl = stripEl;
    this.onFocus = onFocus;
    this.onAction = onAction;
    this.onFullscreenChange = onFullscreenChange;
    this.tiles = new Map();   // id -> { root, media, audio, badge, kind, view }
    this.focused = null;
    this.aspect = storage.get('aspect', 'auto');
    this._bindMediaStateEvents();
  }

  /** 监听原生全屏/画中画的进出，保证按钮与状态始终同步 */
  _bindMediaStateEvents() {
    this._onFsChange = () => this._syncFullscreenUi();
    document.addEventListener('fullscreenchange', this._onFsChange);
    document.addEventListener('webkitfullscreenchange', this._onFsChange);
    this._onPipChange = () => this._syncPipUi();
    document.addEventListener('enterpictureinpicture', this._onPipChange);
    document.addEventListener('leavepictureinpicture', this._onPipChange);
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
    // 正在全屏/画中画的瓦片：先退出对应状态，避免“幽灵全屏”
    try {
      if (document.pictureInPictureElement && tile.media === document.pictureInPictureElement) {
        document.exitPictureInPicture?.().catch?.(() => { /* 忽略 */ });
      }
    } catch { /* 忽略 */ }
    if ((document.fullscreenElement || document.webkitFullscreenElement) === tile.root) {
      this.exitFullscreen();
    }
    if (this._pseudoTile === tile) this.exitPseudoFullscreen();
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
      if (pip) { tile._pipBtn = pip; tools.append(pip); }
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
    if (media.tagName !== 'VIDEO') { toast('该画面不支持画中画（影院模式请用全屏）'); return; }
    try {
      if (document.pictureInPictureElement === media) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureElement) {
        // 已有其它画面在小窗：先退出再切换（避免误以为没反应）
        await document.exitPictureInPicture().catch(() => { /* 忽略 */ });
        if (media.requestPictureInPicture) await media.requestPictureInPicture();
      } else if (media.requestPictureInPicture) {
        await media.requestPictureInPicture();
      } else {
        toast('当前浏览器不支持画中画，可改用全屏');
      }
    } catch (err) {
      toast('画中画不可用：' + (err?.message || err) + '（可改用全屏）');
    }
    this._syncPipUi();
  }

  /** 同步各瓦片的画中画按钮状态（当前在小窗的画面显示「退出画中画」） */
  _syncPipUi() {
    const pipMedia = document.pictureInPictureElement || null;
    for (const tile of this.tiles.values()) {
      const btn = tile._pipBtn;
      if (!btn) continue;
      const active = !!pipMedia && tile.media === pipMedia;
      btn.textContent = active ? '⧉ 退出小窗' : '⧉ 画中画';
      btn.title = active ? '关闭系统小窗' : '弹出为系统小窗，可置顶';
      tile.root.classList.toggle('pip-active', active);
    }
  }

  /** 是否处于全屏（原生或 CSS 伪全屏） */
  isFullscreen() {
    return !!this._pseudoTile || !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  /** 退出全屏（原生优先，其次伪全屏） */
  async exitFullscreen() {
    if (this._pseudoTile) { this.exitPseudoFullscreen(); return; }
    const elFs = document.fullscreenElement || document.webkitFullscreenElement;
    if (elFs) {
      try {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      } catch { /* 忽略 */ }
    }
    this._syncFullscreenUi();
  }

  /** 同步原生全屏 UI：全屏瓦片加「✕ 退出全屏」按钮，并通知外部更新按钮文案 */
  _syncFullscreenUi() {
    const elFs = document.fullscreenElement || document.webkitFullscreenElement || null;
    const tile = elFs ? [...this.tiles.values()].find((t) => t.root === elFs) : null;
    if (this._nativeFsTile && this._nativeFsTile !== tile) {
      try { this._nativeFsTile._fsExitBtn?.remove(); } catch { /* 忽略 */ }
      if (this._nativeFsTile) this._nativeFsTile._fsExitBtn = null;
    }
    if (tile) {
      if (!tile._fsExitBtn) {
        tile._fsExitBtn = el('button', {
          class: 'pseudo-exit', text: '✕ 退出全屏', title: '退出全屏（也可按 Esc）',
          onclick: (e) => { e.stopPropagation(); this.exitFullscreen(); },
        });
        tile.root.append(tile._fsExitBtn);
      }
      this._nativeFsTile = tile;
    } else {
      this._nativeFsTile = null;
    }
    this.onFullscreenChange?.(this.isFullscreen());
  }

  /** 全屏：优先原生 Fullscreen API；iOS 用 <video> 原生全屏；都不可用时用 CSS 覆盖（任何设备都能用） */
  async _fullscreen(tile) {
    // 已是全屏状态 → 再点即退出（底部「全屏」按钮与画面按钮行为一致）
    if (this.isFullscreen()) { await this.exitFullscreen(); return; }
    const media = tile.media;
    const isVideo = media?.tagName === 'VIDEO';
    const canApi = Boolean(document.fullscreenEnabled && (tile.root.requestFullscreen || tile.root.webkitRequestFullscreen));
    if (canApi) {
      try {
        const req = tile.root.requestFullscreen || tile.root.webkitRequestFullscreen || tile.root.msRequestFullscreen;
        await req.call(tile.root);
        this._syncFullscreenUi();
        toast('已进入全屏（点右上角「✕ 退出全屏」或按 Esc 结束）');
        return;
      } catch { /* 继续尝试其它方式 */ }
    }
    // iOS Safari：只有 <video> 支持原生全屏
    if (isVideo && typeof media.webkitEnterFullscreen === 'function') {
      try { media.webkitEnterFullscreen(); toast('已进入原生全屏（再次点击屏幕可退出）'); return; } catch { /* 忽略 */ }
    }
    // 兜底：CSS 伪全屏（固定覆盖视口，Esc/按钮退出；手机浏览器同样可用）
    this.enterPseudoFullscreen(tile);
  }

  enterPseudoFullscreen(tile) {
    this.exitPseudoFullscreen();
    this._pseudoTile = tile;
    tile.root.classList.add('pseudo-fullscreen');
    document.body.classList.add('pseudo-fullscreen-active');
    if (!this._pseudoExitBtn) {
      this._pseudoExitBtn = el('button', { class: 'pseudo-exit', text: '✕ 退出全屏', onclick: (e) => { e.stopPropagation(); this.exitPseudoFullscreen(); } });
    }
    tile.root.append(this._pseudoExitBtn);
    if (!this._pseudoKeyHandler) {
      this._pseudoKeyHandler = (e) => { if (e.key === 'Escape') this.exitPseudoFullscreen(); };
    }
    document.addEventListener('keydown', this._pseudoKeyHandler);
    toast('已进入全屏（按 Esc 或点右上角退出）');
    this.onFullscreenChange?.(true);
  }

  exitPseudoFullscreen() {
    const tile = this._pseudoTile;
    this._pseudoTile = null;
    if (tile) {
      tile.root.classList.remove('pseudo-fullscreen');
      try { this._pseudoExitBtn?.remove(); } catch { /* 忽略 */ }
    }
    document.body.classList.remove('pseudo-fullscreen-active');
    if (this._pseudoKeyHandler) document.removeEventListener('keydown', this._pseudoKeyHandler);
    this.onFullscreenChange?.(false);
  }

  /** 更新某个瓦片角标（不整体重绘） */
  setBadge(id, badge) {
    const tile = this.tiles.get(id);
    if (!tile?.badgeText) return;
    tile.badgeText.textContent = badge?.text || '连接中';
    tile.badgeEl.classList.remove('good', 'fair', 'poor');
    if (badge?.level) tile.badgeEl.classList.add(badge.level);
  }

  /** 全屏当前聚焦画面（底部工具栏用，桌面/手机都更易发现） */
  fullscreenFocused() {
    const tile = this.tiles.get(this.focused)
      || [...this.tiles.values()].find((t) => t.root.classList.contains('main'))
      || [...this.tiles.values()][0];
    if (tile) this._fullscreen(tile);
    else toast('还没有可全屏的画面');
  }
}
