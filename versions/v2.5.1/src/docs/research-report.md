> 📦 本文档为 **GinyVoC（v0.6.0 及以前）** 时代的调研/分析存档。Gracs v2.0.0 已转向「零外置软件联机 + 双链路共享」，内容仅供参考。
> 最新的技术选型与决策记录见 [tech-alternatives.md](tech-alternatives.md)。

---

# Gracs 调研报告 — 联机游戏语音 + 屏幕共享

> 结论先行：本项目采用 **WebRTC(Opus) 语音 + P2P mesh 组网 + Node.js(Socket.IO) 信令** 的架构，
> 是社区里"小规模开黑语音"最主流、成本最低、上手最快的方案；同时保留升级到 SFU（mediasoup/LiveKit）的路径。

---

## 一、现有语音软件对比（产品层面）

| 软件 | 形态 | 语音架构 | 屏幕共享 | 语音频道 | 开源 | 适合场景 |
|------|------|----------|----------|----------|------|----------|
| Discord | 桌面/网页 | 自研 Opus + 自研基础设施 | ✅ | ✅ 服务器-频道树 | ❌ | 游戏开黑标杆，闭源 |
| TeamSpeak 3 | 桌面 | 客户端-服务器，Opus | ✅ | ✅ 频道树 | ❌(协议闭源) | 低延迟开黑 |
| Mumble | 桌面 | 客户端-服务器(Murmur)，Opus，客户端混音 | ❌ | ✅ 频道树 + 链接频道 | ✅ GPL | 极低延迟语音标杆 |
| Kook/开黑啦 | 桌面 | 客户端-服务器 | ✅ | ✅ | ❌ | 国内游戏语音 |
| YY语音 | 桌面 | 客户端-服务器 | ✅ | ✅ 频道/马甲 | ❌ | 国内大型频道 |
| 腾讯会议/Zoom | 桌面 | SFU | ✅ | 会议(非频道) | ❌ | 会议，非游戏向 |
| 本项目 Gracs | 网页(可打包桌面) | WebRTC mesh（可升级 SFU） | ✅ | ✅ 房间-语音频道 | ✅ | 小圈子开黑，自托管 |

**从产品上借鉴**：Discord/Mumble 的"房间 → 语音频道 → 成员状态"模型；Mumble 的 PTT/按键说话、
语音检测(VAD)；Discord 的说话光环/音量表、频道内成员列表、房间邀请码。

---

## 二、开源参考项目与库（技术层面）

### 直接参考的开源软件
- **Mumble / Murmur**（mumble-voip/mumble，C++）— 游戏语音的经典开源实现：
  Opus 编码、低延迟、频道树、PTT/VAD、whisper 定向语音。我们借鉴其"频道 + PTT/VAD"交互模型。
- **Galène**（jech/galene，Go）— 轻量自托管 WebRTC 视频会议，代码量小、架构清晰，是"自托管语音"的参照。
- **harmony-server**（tartine-studio，Go + Pion）— 自托管 Discord 替代品，内置 Pion WebRTC SFU，
  单二进制即可跑，验证了"小型自托管语音"可行性。
- **backspace**（TheZwiss，TypeScript）— 自托管 Discord 替代：语音、HD 视频、屏幕共享、联邦。
- **gitcord**（opticraftsu，Electron + Socket.IO + WebRTC）— Discord 克隆教学项目，
  与我们同栈（Socket.IO 信令 + WebRTC P2P + 屏幕共享），UI/流程可对标。
- **IceVox**（bjorehag）— P2P 语音 + 变声，WebRTC mesh（≤6人），印证 mesh 在小规模下的可行性。
- **Squawk**（shynsec）— 自托管游戏语音，WebRTC P2P，强调"语音不经过服务器"。

### 可复用的开源组件/库
| 组件 | 项目 | 用途 | 是否采用 |
|------|------|------|----------|
| 浏览器 WebRTC | 浏览器内置 API | 语音采集/编码/传输、屏幕采集 | ✅ 直接使用 |
| 信令 | Socket.IO | 房间/频道/状态同步 + SDP/ICE 转发 | ✅ 直接使用 |
| SFU 媒体转发 | mediasoup（Node）、LiveKit（Go）、Janus（C）、Galène | 大规模频道（>8人）时由 mesh 升级 | ⏳ 预留 |
| 音频处理 | Web Audio API（AnalyserNode/GainNode） | VAD、音量表、静音 | ✅ 直接使用 |
| 降噪 | RNNoise、LiveKit 内置降噪 | 麦克风降噪增强 | ⏳ 后续 |
| 屏幕共享 | getDisplayMedia | 共享屏幕/窗口/标签页 | ✅ 直接使用 |

---

## 三、关键技术决策

### 1. 为什么 WebRTC
- 浏览器原生支持，**零安装、跨平台**（含游戏本/网吧机），可直接打包成 Electron 桌面端。
- 内置 **Opus 音频编码**（专为语音优化，低延迟高音质）+ 前向纠错 + 回声消除/降噪。
- 内置 **ICE/STUN/TURN** NAT 穿透，局域网/公网都能连，无需自研打洞。
- 官方免费无授权费；自托管后数据不出自己服务器。

### 2. mesh P2P vs SFU
- **mesh（当前）**：同频道每人互相建一条 P2P 连接，语音直连不经服务器。
  - 优点：服务器只做信令，媒体带宽成本为 0；部署简单；隐私好（语音不经服务器）。
  - 缺点：上行带宽随人数线性增长，适合 **2~8 人开黑**。
- **SFU（升级路径）**：频道超过 8 人时，用 mediasoup/LiveKit 做媒体转发（每人一条上行）。
  - 本项目已在架构上隔离"信令房间"与"媒体组网"两层，后续可平滑替换。

### 3. 语音频道模型（借鉴 Mumble/Discord）
- 房间（room）：5 位邀请码，一房间一个服务器实例可开多个。
- 频道（channel）：房间内多个语音频道（大厅/开黑/观战），成员同频道即互通语音。
- 状态：麦克风 / 闭麦 / 共享屏幕 / 正在说话（本地 VAD + 远端音量检测）。

### 4. 交互细节
- **三种说话模式**：VAD（语音检测，带迟滞与保持时间）、PTT（按住说话）、自由麦。
- **音量表**：本地用 AnalyserNode 的 RMS；远端按每个流独立分析。
- **屏幕共享**：getDisplayMedia 采集 → 对每个对端 addTrack/replaceTrack → 触发 WebRTC 重协商；
  停止共享用 replaceTrack(null)，无需重新建房。

---

## 四、协议与数据流（当前实现）

```
浏览器A ══Socket.IO(信令: 房间/频道/状态/SDP/ICE)══▶ Node 服务器 ◀══Socket.IO══ 浏览器B
   │                                                        │
   └────────────── WebRTC P2P (Opus 语音 + 屏幕视频) ◀─────────┘
```

客户端事件：`room:create/join/leave`、`channel:join/leave`、`signal`、`media:update`、`chat:send`
服务端事件：`room:state`、`user:joined`、`signal`、`chat:message`

---

## 五、与目标差距 / 后续路线图

- [ ] TURN 服务器部署指南（严格 NAT 环境必须）
- [ ] SFU 模式（mediasoup）支持 >8 人频道
- [ ] RNNoise / LiveKit 降噪接入
- [ ] 语音加密（WebRTC DTLS-SRTP 已内置，无需额外）
- [ ] Electron 桌面封装（托盘、开机自启、全局快捷键）
- [ ] 账号体系、好友、频道权限（管理员/踢人/锁定频道）
- [ ] 录制（服务端混音或客户端录制）
