# 影院模式设计（WebCodecs + 服务器中继）

> 目标：**画质恒定、弱网平滑**，适合「一起看电影/视频」。
> 代价：比 WebRTC 多约 0.2~0.5 秒缓冲延迟（可调），换来的是不再随网络抖动忽高忽低。

## 一、为什么不用 WebRTC 看电影？

WebRTC 的拥塞控制（GCC）为「实时互动」优化：带宽一波动就立刻降码率/分辨率，恢复慢；
屏幕内容（电影、字幕）对码率变化非常敏感，观感就是「糊一下、清一下、再糊一下」。
影院模式把这条链路换成自己可控的编码器：

- 固定码率目标 + 我们自己决定的降级顺序（先丢帧、后降码率，不轻易降分辨率）
- 显式关键帧（新观看者、花屏恢复、切换画质时立刻出关键帧）
- 明确的发送队列（拥塞时**丢旧帧**而不是排队积压），延迟有上界

## 二、链路

```
共享端                                    服务器                     观看端
getDisplayMedia ──► VideoEncoder ──┐
                                   │ 二进制批次（14ms 聚合）
                                   ├──► Socket.IO ──► volatile 转发 ──► Socket.IO ──► VideoDecoder ──► canvas
   系统声音 ──► WebRTC（Opus 仅音频）└────────── P2P/中继 ────────────► <audio>
```

- **编码**：`VideoEncoder`（优先 H.264：硬件编码普及、兼容性最好；可回退 VP9/AV1/VP8）
- **帧来源**：`MediaStreamTrackProcessor`（主）/ `requestVideoFrameCallback + new VideoFrame(video)`（兜底）
- **传输**：Socket.IO 二进制消息；服务端用 `volatile` 转发（写不出去就丢，不排队）
- **解码**：`VideoDecoder`，渲染到 `<canvas>`，缓冲 2 帧（低延迟）；页面不可见时暂停并在恢复时请求关键帧

## 三、批次协议（客户端 `client/js/cinema.js`）

单条 Socket.IO 二进制消息 = 一个小批次（默认每 14ms 聚合一次，或累计 >192KB 提前发送）：

```
u8  version = 1
u8  frameCount
u16 reserved
每帧:
  u32 seq          // 递增序号（调试/统计）
  f64 timestampUs  // 编码时间戳（微秒）
  u32 durationUs
  u8  type         // 1 = 关键帧
  u8  chunkCount
  u16 reserved
  每个分片:
    u32 length
    bytes...
```

> ⚠️ 改动协议必须同步 `writeBatch` 与 `readBatch`（尤其是**头部长度**：帧头 20 字节 + 分片头 4 字节）。

**元数据**（`cinema:meta`，JSON）：`{ codec, codedWidth, codedHeight, description(base64), hw }`。
后来者可据此初始化解码器；关键帧到来前的分片会被丢弃，因此新观看者会主动请求关键帧。

## 四、码率自适应

- 观看端每 500ms 上报：`{ fps, kbps, dropped, buffer }`（`cinema:feedback`）
- 共享端 AIMD：实际吞吐 < 目标 60% → ×0.8；丢帧 > 3 → ×0.85；达标 → ×1.06
- 调整范围：`[目标×0.25, 目标×1.6]`，改动超过 6% 时 `encoder.configure({...config, bitrate})` 并请求关键帧

## 五、典型参数（画质档位）

| 档位 | 分辨率 | 帧率 | 目标码率 | 适用 |
|------|--------|------|----------|------|
| 自动（推荐） | 1920×1080 | 30 | 9 Mbps | 通用；共享中可随时切换 |
| 电影 | 1920×1080 | 30 | 10 Mbps | 电影/视频，字幕清晰优先 |
| 游戏 | 1920×1080 | 60 | 14 Mbps | 需要流畅度（延迟略高于标准链路） |
| 文字 | 原生分辨率 | 15 | 6 Mbps | 文档/代码演示 |
| 省流 | 1280×720 | 30 | 2.5 Mbps | 上行带宽紧张 |

## 六、已知边界

- 需要浏览器支持 WebCodecs（Chromium 系 / 桌面版内置 Electron 均支持）；不支持时自动回退标准链路并提示。
- 上行为单路（服务器按观看人数转发），服务器带宽 = 上行 × 观看人数；局域网/本机场景几乎无成本。
- 延迟比 WebRTC 高（缓冲 2 帧 + 聚合 14ms + 网络 RTT），互动场景请用标准链路。
