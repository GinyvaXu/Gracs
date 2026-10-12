// screenshare.js — 屏幕采集 + 画质档位 + 发送端参数（WebRTC 最佳实践）
// 设计要点：
//  - 画质档位 = 目标分辨率/帧率/码率上限；「自动」档在此基础上按每个观看者的实时带宽自适应
//  - contentHint: detail（文字/电影）或 motion（游戏/视频）让编码器按内容类型优化
//  - 拥塞策略：电影/文字档 maintain-resolution（宁可掉帧不糊字），游戏档 maintain-framerate
//  - 码率上限按「每观看者」独立计算，自动档还会受总上行预算约束，避免 mesh 上行爆表
export const PRESETS = {
  auto: { key: 'auto', label: '自动（推荐）', width: 0, height: 0, fps: 30, maxFps: 60, bitrate: 9_000_000, minBitrate: 500_000, hint: 'detail', degradation: 'maintain-resolution', adaptive: true },
  movie: { key: 'movie', label: '电影 1080p30', width: 1920, height: 1080, fps: 30, maxFps: 30, bitrate: 10_000_000, minBitrate: 600_000, hint: 'detail', degradation: 'maintain-resolution' },
  game: { key: 'game', label: '游戏 1080p60', width: 1920, height: 1080, fps: 60, maxFps: 60, bitrate: 14_000_000, minBitrate: 800_000, hint: 'motion', degradation: 'maintain-framerate' },
  text: { key: 'text', label: '文字（原生分辨率）', width: 0, height: 0, fps: 15, maxFps: 30, bitrate: 6_000_000, minBitrate: 400_000, hint: 'detail', degradation: 'maintain-resolution' },
  saver: { key: 'saver', label: '省流 720p30', width: 1280, height: 720, fps: 30, maxFps: 30, bitrate: 2_500_000, minBitrate: 300_000, hint: 'detail', degradation: 'maintain-resolution' },
};
export const DEFAULT_PRESET = 'auto';
export const MIN_BITRATE = 300_000;

export function getPreset(key) {
  return PRESETS[key] || PRESETS[DEFAULT_PRESET];
}

/** 判断是否为「系统声音无法启动」错误（部分 Windows 声卡/驱动的 WASAPI 回环不兼容：NotReadableError: Could not start audio source） */
function isAudioStartError(err) {
  return /audio/i.test(String(err?.message || err || ''));
}

/** 采集屏幕（可选系统声音）；Electron 桌面版会走内置源选择器。
 *  audioSource：{ mode: 'system' | 'follow' | 'app', pid?, name? }
 *   - system：整机声音（优先 Chromium 原生回环，失败走 helper 兼容采集，再失败仅画面）
 *   - follow：跟随共享窗口（共享窗口 → 只采该窗口应用的声音；共享整屏 → 整机声音），桌面版走 helper
 *   - app   ：指定应用（只采该应用及其子进程的声音），桌面版走 helper
 *  按应用/跟随模式不会触发「静音其它应用」：语音软件正常出声且不会被采进去（避免朋友听到自己的回音）。 */
export async function startScreenShare({ presetKey = DEFAULT_PRESET, withAudio = false, sourceId = null, audioSource = null } = {}) {
  const preset = getPreset(presetKey);
  const video = {
    frameRate: { ideal: preset.fps, max: preset.maxFps },
  };
  if (preset.width) {
    video.width = { ideal: preset.width, max: preset.width };
    video.height = { ideal: preset.height, max: preset.height };
  } else {
    video.width = { ideal: 2560 };
    video.height = { ideal: 1440 };
  }
  if (window.gvDesktop) video.cursor = 'always';

  // 注意：audio 用布尔 true —— 部分浏览器/Electron 对「带约束的 audio 请求」处理不一致，
  // 先按最稳的方式拿到音轨，再在采集后尝试关闭浏览器音频处理（失败不影响）。
  const constraints = { video, audio: !!withAudio };
  if (sourceId && window.gvDesktop) constraints.video = { ...video, mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } };

  const mode = withAudio ? (audioSource?.mode || 'system') : 'off';
  let stream;
  let audioFallback = false;
  let audioNote = '';
  let audioSourceLabel = '';

  /** 用 helper 采集（pid>0=指定应用；0=整机），失败返回 null */
  const helperTrack = async (pid) => {
    if (!window.gvDesktop?.startSystemAudio) return null;
    try {
      const { startHelperSystemAudio } = await import('./system-audio.js');
      const h = await startHelperSystemAudio({ pid });
      return h?.track ? h : null;
    } catch (e) {
      console.warn('helper 音频采集失败：', e);
      return null;
    }
  };
  const attachHelper = (h) => {
    stream.addTrack(h.track);
    stream._helperStop = h.stop;
  };

  if (mode === 'app' || mode === 'follow') {
    // 「按应用 / 跟随共享窗口」：视频照常选源（不带音频，避免采成整机），声音走 helper
    stream = await navigator.mediaDevices.getDisplayMedia({ ...constraints, audio: false });
    let pid = Number(audioSource?.pid) || 0;
    let label = audioSource?.name || '';
    if (mode === 'follow' && !pid) {
      try {
        const pick = await window.gvDesktop?.getLastDisplayPick?.();
        if (pick && pick.fresh !== false && pick.type === 'window') {
          pid = Number(pick.pid) || 0;
          label = pick.name || '';
        }
      } catch { /* 忽略 */ }
    }
    if (pid > 0) {
      const h = await helperTrack(pid);
      if (h) { attachHelper(h); audioSourceLabel = label || '指定应用'; }
      else if (mode === 'follow') {
        // 窗口声音采不到 → 回退整机声音
        const h2 = await helperTrack(0);
        if (h2) { attachHelper(h2); audioSourceLabel = '整机声音（所选窗口无声音）'; }
        else { audioFallback = true; audioNote = '系统声音采集失败：已自动改为「仅画面」共享'; }
      } else {
        audioFallback = true;
        audioNote = `未能单独采集「${label || '所选应用'}」的声音（应用未在播放或系统不支持）：已改为「仅画面」共享`;
      }
    } else if (mode === 'follow') {
      // 共享的是整个屏幕 → 整机声音（helper；与窗口无关）
      const h = await helperTrack(0);
      if (h) { attachHelper(h); audioSourceLabel = '整机声音'; }
      else { audioFallback = true; audioNote = '系统声音采集失败：已自动改为「仅画面」共享'; }
    } else {
      audioFallback = true;
      audioNote = '未选择要采集的应用：已改为「仅画面」共享（可在共享栏重新选择音频源）';
    }
  } else if (mode === 'system') {
    // 整机声音：优先 Chromium 原生回环，失败走 helper 兼容采集，再失败仅画面
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(constraints);
    } catch (err) {
      if (!withAudio || !isAudioStartError(err)) throw err;
      console.warn('系统声音采集失败，尝试兼容模式：', err);
      audioFallback = true;
      const useHelper = !!window.gvDesktop?.startSystemAudio;
      try { await window.gvDesktop?.notifyAudioFallback?.({ useHelper }); } catch { /* 忽略 */ }
      stream = await navigator.mediaDevices.getDisplayMedia({ ...constraints, audio: false });
      if (useHelper) {
        const h = await helperTrack(0);
        if (h) {
          attachHelper(h);
          audioFallback = false;   // 声音已拿到（兼容模式），不算降级
          console.info('系统声音已通过兼容模式采集（helper 回环）');
        } else {
          try { window.gvDesktop?.restoreWindowAudio?.(); } catch { /* 忽略 */ }
        }
      }
    }
    if (!audioFallback) audioSourceLabel = '整机声音';
  } else {
    stream = await navigator.mediaDevices.getDisplayMedia(constraints);
  }

  const videoTrack = stream.getVideoTracks()[0];
  const settings = videoTrack?.getSettings?.() || {};
  const audioTracks = stream.getAudioTracks();
  if (withAudio && audioTracks.length) {
    for (const track of audioTracks) {
      try { await track.applyConstraints({ echoCancellation: false, noiseSuppression: false, autoGainControl: false }); } catch { /* 不支持则保持默认处理 */ }
    }
  }
  for (const track of stream.getVideoTracks()) {
    track.contentHint = preset.hint;
    track.addEventListener('ended', () => stream.dispatchEvent(new Event('userstopped')), { once: true });
  }
  return {
    stream,
    preset,
    meta: {
      width: settings.width || preset.width || 0,
      height: settings.height || preset.height || 0,
      fps: settings.frameRate ? Math.round(settings.frameRate) : preset.fps,
      title: videoTrack?.label || '屏幕',
      hasAudio: audioTracks.length > 0,
      displaySurface: settings.displaySurface || '',
      audioFallback,
      audioSourceLabel,
      audioNote: audioNote || (audioFallback
        ? fallbackAudioNote(settings, !!window.gvDesktop)
        : (withAudio && !audioTracks.length ? describeMissingAudio(settings) : '')),
    },
  };
}

/** 声音采集失败后的提示：按「共享来源 / 是否桌面版」区分原因与建议 */
function fallbackAudioNote(settings, isDesktop) {
  if (isDesktop) {
    return '系统声音采集失败（原生回环与兼容采集均未成功）：已改为「仅画面」共享；可尝试更新声卡驱动或重启 Gracs';
  }
  const surface = settings?.displaySurface;
  if (surface === 'window') {
    return '浏览器共享「窗口」无法采集声音（Chrome/Edge 限制）：请改选「整个屏幕」并勾选「共享系统音频」；桌面版支持按应用单独采声（语音软件不受影响）';
  }
  if (surface === 'browser') {
    return '共享「标签页」未拿到声音：请在弹窗里勾选「同时共享标签页音频」；桌面版可按应用单独采声';
  }
  return '本机浏览器回环采集不可用（常见于蓝牙耳机/声卡驱动）：已改为「仅画面」共享；下载桌面版可自动修复（内置兼容采集 + 按应用采声），或改选「标签页」共享其声音';
}

/** 未拿到系统声音时，按「共享来源类型」给出可操作的提示 */
function describeMissingAudio(settings) {
  const surface = settings?.displaySurface;
  if (surface === 'browser') return '没有拿到声音：共享的是「标签页」，请在系统弹窗里勾选「同时共享标签页音频」后重试';
  if (surface === 'window') return '没有拿到声音：Windows 上共享「窗口」通常无法采集声音，请改选「整个屏幕」并在系统弹窗里勾选「共享系统音频」';
  return '没有拿到系统声音：请重新共享，并在系统弹窗里勾选「共享系统音频」（Edge/Chrome 仅「整个屏幕 / 标签页」支持）';
}

/** 共享中切换画质：更新采集端约束（分辨率跟随 / 帧率实时生效） */
export async function applyPresetToStream(stream, presetKey) {
  const preset = getPreset(presetKey);
  for (const track of stream.getVideoTracks()) {
    track.contentHint = preset.hint;
    try {
      const constraints = { frameRate: { ideal: preset.fps, max: preset.maxFps } };
      if (preset.width) {
        constraints.width = { ideal: preset.width, max: preset.width };
        constraints.height = { ideal: preset.height, max: preset.height };
      }
      await track.applyConstraints(constraints);
    } catch { /* 浏览器可能拒绝实时改约束，忽略 */ }
  }
  return preset;
}

/** 给单条 PeerConnection 的所有视频发送器应用参数（每观看者可独立传不同码率） */
export async function applySendParams(pc, preset, { bitrate = null } = {}) {
  const target = bitrate ?? preset.bitrate;
  for (const sender of pc.getSenders?.() || []) {
    if (sender.track?.kind !== 'video') continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.degradationPreference = preset.degradation || 'balanced';
      params.encodings[0].maxBitrate = Math.round(target);
      params.encodings[0].maxFramerate = preset.maxFps || preset.fps;
      if ('networkPriority' in params.encodings[0]) params.encodings[0].networkPriority = 'high';
      await sender.setParameters(params);
    } catch { /* 部分浏览器不允许改参数则忽略 */ }
  }
}

/** 请求关键帧（新观看者入房 / 花屏恢复） */
export function requestKeyframe(pc) {
  for (const sender of pc.getSenders?.() || []) {
    if (sender.track?.kind !== 'video') continue;
    try {
      // Chromium：主动生成关键帧；其它浏览器由接收端 PLI 自动触发
      sender.generateKeyFrame?.();
    } catch { /* 忽略 */ }
  }
}

/** 采集端自动降档（窄带宽时）用的档位顺序 */
export const PRESET_LADDER = ['auto', 'movie', 'game', 'saver'];
