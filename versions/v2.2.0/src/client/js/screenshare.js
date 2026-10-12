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
 *  系统声音启动失败（声卡驱动不兼容回环）时自动降级为「仅画面」，不再让整个共享失败。 */
export async function startScreenShare({ presetKey = DEFAULT_PRESET, withAudio = false, sourceId = null } = {}) {
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

  let stream;
  let audioFallback = false;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(constraints);
  } catch (err) {
    if (!withAudio || !isAudioStartError(err)) throw err;
    // 降级：桌面版先通知主进程按「上次来源」自动重试（不会再弹一次选择器）；浏览器版会重新弹出选择器
    console.warn('系统声音采集失败，自动降级为仅画面：', err);
    audioFallback = true;
    try { await window.gvDesktop?.notifyAudioFallback?.(); } catch { /* 忽略 */ }
    stream = await navigator.mediaDevices.getDisplayMedia({ ...constraints, audio: false });
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
      audioNote: audioFallback
        ? '系统声音采集失败（设备声卡驱动与系统音频回环不兼容）：已自动改为「仅画面」共享；更新声卡驱动后可重试'
        : (withAudio && !audioTracks.length ? describeMissingAudio(settings) : ''),
    },
  };
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
