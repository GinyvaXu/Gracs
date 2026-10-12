// system-audio.js — 桌面版「兼容模式」系统声音（helper 采集回环 PCM → WebAudio 合成音轨）
// 使用场景：Chromium/Electron 自带回环采集在部分声卡驱动上失败
// （NotReadableError: Could not start audio source）时，改用内置 gv-helper 的 NAudio 回环采集，
// 由主进程把裸 PCM 流经 IPC 送进渲染进程，这里合成一条可用于 WebRTC 的音频轨。
// 仅桌面版可用（window.gvDesktop.startSystemAudio）。
// opts.pid > 0：只采集该进程及其子进程的声音（按应用采声）；0/省略：整机混音
export async function startHelperSystemAudio({ pid = 0 } = {}) {
  const api = window.gvDesktop;
  if (!api?.startSystemAudio) throw new Error('当前环境不支持兼容模式采集');

  let onFormat;
  let formatTimer = null;
  const formatP = new Promise((resolve, reject) => {
    formatTimer = setTimeout(() => reject(new Error('等待采集格式超时')), 8000);
    onFormat = (f) => { clearTimeout(formatTimer); resolve(f); };
  });
  formatP.catch(() => { /* 已在下面 await / 或用 res.format，避免未处理 rejection */ });
  const offFormat = api.onSystemAudioFormat?.(onFormat) || null;

  let queue = [];          // Float32 交错（L,R,L,R,…）
  let ended = false;
  const offChunk = api.onSystemAudioChunk?.((raw) => {
    try {
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const frames = Math.floor(bytes.byteLength / 4);
      for (let i = 0; i < frames; i++) {
        queue.push(view.getInt16(i * 4, true) / 32768, view.getInt16(i * 4 + 2, true) / 32768);
      }
      const max = 96000 * 4;   // 上限 ≈2 秒，防止积压膨胀
      if (queue.length > max) queue = queue.slice(queue.length - max);
    } catch { /* 忽略坏块 */ }
  }) || null;
  const offEnd = api.onSystemAudioEnd?.(() => { ended = true; }) || null;

  const cleanup = () => {
    try { offFormat?.(); } catch { /* 忽略 */ }
    try { offChunk?.(); } catch { /* 忽略 */ }
    try { offEnd?.(); } catch { /* 忽略 */ }
    try { api.stopSystemAudio?.(); } catch { /* 忽略 */ }
  };

  try {
    const res = await api.startSystemAudio({ pid: Number(pid) || 0 });
    if (!res || res.ok === false) throw new Error(res?.error || '启动失败');
    if (res.format && formatTimer) clearTimeout(formatTimer);
    const format = res.format || await formatP;
    if (!format?.rate) throw new Error('未获取到采集格式');

    const ac = new AudioContext({ sampleRate: format.rate });
    await ac.resume().catch(() => { /* 已有用户手势时无需 */ });
    const dest = ac.createMediaStreamDestination();
    const processor = ac.createScriptProcessor(4096, 2, 2);
    processor.onaudioprocess = (e) => {
      const outL = e.outputBuffer.getChannelData(0);
      const outR = e.outputBuffer.getChannelData(1);
      const n = Math.min(outL.length, Math.floor(queue.length / 2));
      if (n > 0) {
        for (let i = 0; i < n; i++) { outL[i] = queue[i * 2]; outR[i] = queue[i * 2 + 1]; }
        queue.splice(0, n * 2);
        if (n < outL.length) { outL.fill(0, n); outR.fill(0, n); }
      } else {
        outL.fill(0); outR.fill(0);   // 欠载静音
      }
    };
    // ScriptProcessor 需要连到正在运行的音频图才会回调；用 0 增益节点避免把系统声音再放一遍（回声）
    const mute = ac.createGain();
    mute.gain.value = 0;
    processor.connect(mute);
    mute.connect(ac.destination);
    processor.connect(dest);

    if (ended) throw new Error('采集进程已结束');
    const track = dest.stream.getAudioTracks()[0];
    if (!track) throw new Error('未能创建音轨');

    const stop = () => {
      try { processor.disconnect(); } catch { /* 忽略 */ }
      try { mute.disconnect(); } catch { /* 忽略 */ }
      try { dest.disconnect(); } catch { /* 忽略 */ }
      try { ac.close(); } catch { /* 忽略 */ }
      cleanup();
    };
    return { track, format, stop };
  } catch (err) {
    cleanup();
    throw err;
  }
}
