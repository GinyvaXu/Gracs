# 技术栈 — GinyScreen v2

## 概览

| 维度 | 内容 |
|------|------|
| 语言/运行时 | Node.js ≥ 18（服务端 + Electron 桌面） |
| 信令/房间 | Express + Socket.IO（单服务器单房间，内存态） |
| 媒体-标准链路 | WebRTC（P2P mesh + 内置 TURN 中继兜底） |
| 媒体-影院链路 | WebCodecs（VideoEncoder/Decoder）+ Socket.IO 二进制中继 |
| 联机/穿透 | 内置 STUN/TURN + UPnP-IGD/NAT-PMP 端口映射 + IPv6/局域网直连 |
| 桌面壳 | Electron（内嵌服务器 + 托盘 + 多源自动更新） |
| 前端 | 原生 HTML/CSS/JS 单页（ES Modules，无构建步骤）+ PWA |
| 打包 | electron-builder（便携/NSIS 安装版）+ 自研 Debug 构建脚本 |
| 测试 | `scripts/smoke-test.mjs`（26 项端到端断言） |

运行时依赖：`express`、`socket.io`、`turn-server`（STUN/TURN）、`@achingbrain/nat-port-mapper`（UPnP/NAT-PMP）、`qrcode-generator`（二维码）、`selfsigned`（自签名证书）。

---

## 核心功能实现

### 1. 联机（零外置软件）
- **实现逻辑**：开房即启动服务器；并行尝试四条可达路径，并统一成「邀请地址」：
  1. **局域网 IPv4**（同 WiFi/网线）
  2. **公网 IPv6**（双方都有 IPv6 时免设置直连）
  3. **UPnP/NAT-PMP 公网端口映射**（自动在路由器上打洞，映射信令/HTTPS/中继端口并定期续期）
  4. **内置 TURN 中继兜底**（对称 NAT / 严格防火墙时媒体自动走中继，端到端仍加密）
- **技术手段**：
  - `turn-server`（纯 JS）内嵌 STUN + TURN（UDP/TCP 双通道），REST 临时凭据（HMAC-SHA1，4 小时自动失效）、用户/总量配额、`relayCallback` 按分配来源选择中继通告地址（多网卡/VPN 环境不会通告错地址）
  - `@achingbrain/nat-port-mapper` 做 UPnP-IGD / NAT-PMP 发现与映射，失败静默降级
  - `stun.miwifi.com` / `stun.cloudflare.com` / `stun.l.google.com` 探测公网出口与 NAT 类型（RFC 5780）
  - 客户端 `/api/ice` 按请求 Host 动态拼装 TURN URL（局域网 / IPv6 / 公网自动匹配可达地址）

### 2. 标准链路（WebRTC）
- **实现逻辑**：共享者向每位观看者建立独立出站连接（观看者应答），天然无协商冲突；每个观看者独立调节码率上限。
- **技术手段**：
  - 编解码优选：`RTCRtpSender.getCapabilities` ∩ 对端能力，按 **AV1 → VP9 → H.264 → VP8** 排序（`setCodecPreferences`），H.264 兜底 Safari/硬件编码
  - 屏幕采集最佳实践：`getDisplayMedia` + `contentHint`（detail/motion）+ 分辨率/帧率约束
  - 拥塞策略：电影/文字档 `maintain-resolution`（保清晰度掉帧），游戏档 `maintain-framerate`
  - 自适应码率：每 2 秒 `getStats()` 读取 `availableOutgoingBitrate` / 丢包 / RTT，
    对每位观看者做 AIMD 调节（0.7~1.08 步进），并受**总上行预算**约束（设置项，默认 20 Mbps）
  - 健壮性：远端描述就绪前的 ICE 候选缓存补交；连接 failed 自动重建（共享者重新 offer，观看者发 `renegotiate` 请求）；`restartIce` 兜底
  - 入房即触发关键帧（`RTCRtpSender.generateKeyFrame`）

### 3. 影院模式（WebCodecs + 服务器中继）
- **实现逻辑**：共享端用 `VideoEncoder` 按固定码率编码，把编码帧打成本地二进制批次经 Socket.IO 转发给观看端，
  观看端 `VideoDecoder` 解码后绘制到 canvas。码率/关键帧/缓冲完全可控，弱网平滑，画质不抖动。
- **技术手段**：
  - 帧来源：`MediaStreamTrackProcessor`（主）→ `requestVideoFrameCallback + new VideoFrame(video)`（兜底）
  - 编码优先 H.264（硬件友好、兼容性最好），可回退 VP9/AV1/VP8（`VideoEncoder.isConfigSupported` 探测）
  - 批次协议：`u8 版本 | u8 帧数 | 每帧(seq/timestamp/duration/type/chunkCount) + 分片`，14ms 聚合发送
  - 服务端 `volatile` 转发：拥塞时直接丢弃，不积压、不放大延迟
  - 观看端：解码队列 ≤10 帧、渲染缓冲 2 帧（低延迟优先），**页面不可见时自动暂停**并在恢复时请求关键帧
  - 反馈闭环：观看端每 500ms 上报（fps/kbps/丢帧）→ 共享端 AIMD 调码率 → 重新配置编码器 + 关键帧
  - 声音：仍走 WebRTC（Opus 仅音频连接），无需自研音频编码链路

### 4. 界面与体验
- 原生 ES Modules 模块化（core/api/signaling/capabilities/screenshare/webrtc/cinema/stats/stage/ui/panels），**无构建步骤**
- 深色影院主题 + 响应式（桌面三栏 / 移动单栏 + 侧栏抽屉 + 安全区域适配）
- 舞台：主画面 + 缩略条、点击聚焦、工具栏（比例/画中画/全屏/音量/质量）、画质角标（含「直连/中继」）
- 邀请：多地址（局域网/IPv6/公网/HTTPS）+ 复制 + 服务端生成二维码（`qrcode-generator`）
- PWA：`manifest.webmanifest` + Service Worker（**网络优先**，升级即时生效、离线可打开）
- 资源版本化：`index.html` 注入 `__VERSION__`，CSS/JS 带 `?v=` 查询，避免旧缓存

### 5. 桌面版（Electron）
- 内嵌服务器 + 主窗口 + 系统托盘；日志落盘（work/error/crash）
- 内置屏幕/窗口选择器（`desktopCapturer` + 自绘缩略图网格），窗口声音方案（静音其它应用后回环采集）
- 自动更新：多源清单竞速（raw GitHub / 代理 / jsDelivr / Releases API）+ NSIS 静默升级 + 安装后校验
- 托盘「复制访问地址」优先公网入口；「设置 → 服务器」可切换本机开房 / 连接朋友

### 6. 数据与状态
- 无持久化：房间/成员/共享状态为内存态（单房间 `main`，最多 12 人）
- 客户端本地存储：昵称、画质档位、链路偏好、上行预算、画面比例、音量等

---

## 关键取舍

| 决策 | 原因 |
|------|------|
| 保留 mesh（而非上 SFU） | 小圈子开黑（2~4 人）下 P2P 延迟最低、服务器零媒体成本；内置 TURN 兜底连通性 |
| 新增影院模式 | 用户核心场景是「一起看电影」：WebRTC 拥塞控制会让画质忽高忽低，自控编码链路更稳 |
| 无构建步骤 | 自托管友好（改完刷新即生效）、Electron 打包简单、Debug 方便 |
| 内嵌 TURN 而非 coturn | 零外置依赖、跨平台、可随桌面版分发；纯 JS 实现对小规模场景足够 |
| 移除内置语音 | v1.4.0 实测无法正常使用，且产品定位是「专注屏幕共享」（用户明确要求） |
