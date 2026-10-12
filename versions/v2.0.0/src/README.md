# 🖥️ GinyScreen — 一起看屏幕

> **自托管屏幕共享工具**：房间里谁都能开播，其他人跟着看 —— 一起看视频、电影、游戏画面。
> **零外置联机软件**：局域网 / IPv6 / 公网端口自动打通，内置中继兜底，好友用浏览器打开地址即可加入。
> 桌面版为 **Windows exe**（内嵌服务器，无需安装 Node.js）；浏览器版直连即可。

![形态](https://img.shields.io/badge/形态-Web%20%2B%20Electron-blue) ![平台](https://img.shields.io/badge/平台-Windows%20%2F%20macOS%20%2F%20Linux%20%2F%20手机-lightgrey) ![版本](https://img.shields.io/badge/版本-v2.0.0-green) ![技术](https://img.shields.io/badge/技术-WebRTC%20%2B%20WebCodecs%20%2B%20Node.js-orange)

---

## ✨ 这个版本（v2.0.0）做了什么

| 主题 | 能力 |
|------|------|
| 🌐 **零外置联机软件** | 内置 **STUN/TURN 中继** + **UPnP/NAT-PMP 自动端口映射** + **IPv6 / 局域网自动直连**；开房即得可分享地址，**不再需要 Radmin / ZeroTier / 蒲公英 / 内网穿透** |
| 🎞️ **双链路共享** | **标准链路**（WebRTC，低延迟，适合游戏/互动）与 **影院模式**（WebCodecs + 服务器中继，画质恒定不抖动，适合看电影），一键切换 |
| 📶 **画质可控可观测** | 编解码智能优选（AV1→VP9→H.264→VP8）、**每位观看者独立码率自适应**、实时质量面板（码率/帧率/RTT/丢包/直连还是中继/拥塞原因） |
| 🩺 **网络诊断** | 一页看懂：局域网 / IPv6 / 公网映射 / NAT 类型 / 中继状态，每条结论都带「怎么办」；支持深度检测 |
| 📱 **全设备** | 响应式 UI，手机/平板可扫码进入观看（全屏、触摸操作、安全区域适配）；PWA 可安装到桌面/主屏 |
| 🔇 **专注共享** | 只共享画面 + 可选系统声音；v2.0 移除了无法正常使用的内置麦克风语音 |

---

## 🚀 快速开始

### 方式一：桌面版 exe（推荐，Windows）

1. 从 [GitHub Releases](https://github.com/GinyvaXu/GinyScreen/releases) 下载 **GinyScreen-Setup-v2.0.0.exe**（或便携版）
2. 双击打开 → 输入昵称 → 进入房间
3. 点顶栏 **🔗 邀请** → 把地址（局域网 / IPv6 / 公网任选）发给好友；也可以直接让好友**扫码进入**
4. 点底部 **🖥️ 共享屏幕** → 选屏幕/窗口 → 大家就能看到

> 开房者不用做任何网络设置：软件启动时会自动尝试在路由器上打通公网端口（UPnP/NAT-PMP），
> 成功后「邀请」里会多出一条**公网地址**；若路由器关闭了 UPnP，还能用 **IPv6 地址**（国内宽带大多已支持）。

### 方式二：浏览器版（有 Node.js 的机器开房）

```bash
npm install
npm start
```

打开 `http://localhost:3000` 进入房间，把「邀请」里的地址发给好友。

> **好友需要什么？** 只需要一个浏览器（Edge / Chrome / Safari）。不需要安装任何软件，也不需要联机工具。

---

## 🎥 两种共享链路怎么选

| | 标准链路（WebRTC） | 影院模式（WebCodecs） |
|---|---|---|
| 延迟 | 最低（P2P 直连，通常 <100ms） | 略高（约 0.2~0.5s 缓冲，画面更稳） |
| 画质稳定性 | 随网络波动，拥塞时自动降码率 | 码率恒定，弱网平滑，**画质不抖动** |
| 传输路径 | P2P 直连优先，严格网络自动走中继 | 经房间服务器转发（仍可端到端加密传输） |
| 适合 | 游戏、演示、需要互动的场景 | **一起看电影 / 看视频**（推荐） |
| 声音 | WebRTC（Opus）随画面 | WebRTC（Opus）随画面 |

底部工具栏的「链路」下拉即可切换，设置里可改默认值。画质档位：
**自动（推荐）/ 电影 1080p30 / 游戏 1080p60 / 文字（原生分辨率）/ 省流 720p30**。

---

## 🌐 联机原理（为什么不需要外置软件）

```
                    ┌─────────────────────────────┐
  好友浏览器 ◄──────┤  ① 局域网直连（同一 WiFi）    │
                    │  ② IPv6 直连（双方都有 IPv6）  │
  好友浏览器 ◄──────┤  ③ UPnP 公网端口自动映射      ├──────► 开房者电脑
                    │  ④ 内置 TURN 中继兜底         │        （跑着 GinyScreen）
  好友浏览器 ◄──────┤  ⑤ 传统组网/穿透（高级备选）   │
                    └─────────────────────────────┘
```

- **信令 + 影院码流**：走开房者的 GinyScreen 服务器（Socket.IO）
- **标准链路画面/声音**：WebRTC 端到端加密，P2P 直连优先；打洞失败自动走**开房者电脑上的内置中继**（依然加密）
- **端口映射**：启动时自动通过 UPnP-IGD / NAT-PMP 映射 信令端口、HTTPS 端口、中继端口，并定期续期
- **自签名 HTTPS**：自动生成（覆盖本机所有地址），让局域网其他电脑也能共享屏幕（浏览器要求安全上下文）
- **最后的备选**：Radmin VPN / 蒲公英 / SakuraFrp 仍然保留在「🌐 网络 → 高级备选」里

### 打不开/连不上怎么办？

打开软件里的 **🌐 网络**（网络诊断），它会逐项告诉你：
局域网是否可用、IPv6 是否可用、公网映射是否成功、NAT 类型是什么（完全圆锥/受限/对称）、中继是否正常，
以及每种情况该怎么处理。把这一页截图发给朋友，对方也能秒懂。

常见情况：

| 现象 | 处理 |
|------|------|
| 公网映射未生效 | 在路由器里开启 **UPnP/NAT-PMP**（多数路由器默认开启）；或直接用 IPv6 地址 |
| 对方是校园网/公司网 | 让**对方**点开「网络诊断」，通常会显示「中继」已生效；仍不行时用高级备选（组网/穿透） |
| 手机扫不出二维码 | 确认扫码的手机和主机在同一 WiFi，或改用 IPv6 地址 |
| 想让局域网另一台电脑共享屏幕 | 用「邀请」里的 **HTTPS 地址**（首次需信任自签名证书） |

---

## 📶 画质与质量面板

底部 **📶 质量** 面板会实时显示每一位观看者（共享者视角）或每一路画面（观看者视角）：

- 分辨率 / 帧率 / 码率 / RTT / 丢包率
- **链路**：P2P 直连 还是 中继（TURN）
- **拥塞原因**：带宽受限 / 本机编码性能受限 / 无限制
- 迷你趋势图（码率历史）

共享者可以在「设置 → 上行带宽预算」里填入自己的上行宽带（默认 20 Mbps），
自动档会把预算按观看人数分配，避免多人观看时上行被打满导致卡顿。

---

## 🖥️ 桌面版（Windows exe）

| 形态 | 文件 | 说明 |
|------|------|------|
| 🐞 Debug 版 | `GinyScreen-Debug-vX.Y.Z.exe` | 每次迭代发布，带实时日志控制台 + DevTools，用于试用/报障 |
| 🧳 便携版 | `GinyScreen-Portable-vX.Y.Z.exe` | 免安装，双击即用 |
| 📦 安装版 | `GinyScreen-Setup-vX.Y.Z.exe` | NSIS 安装器，支持自动更新 |

- **日志**：exe 旁 `logs\`（工作日志 / 报错日志 / 崩溃报告）
- **托盘**：关闭窗口最小化到托盘；托盘菜单可「打开主界面 / 复制访问地址（优先公网入口）/ 返回服务器设置 / 退出」
- **自动更新**：安装版内置多源更新（raw GitHub + 国内加速代理 + jsDelivr + Releases API）

---

## 📱 手机 / 平板

- 手机浏览器（iOS Safari / Android Chrome）**观看体验已适配**：竖屏布局、全屏、触摸操作、安全区域
- 通过「邀请」的**二维码**扫码即可进入，也可以把链接发到微信/QQ 打开
- 手机**不能采集屏幕**（iOS/Android 浏览器限制），但可以正常观看；共享请用电脑

---

## 🔨 构建与发布

版本号**唯一来源**是根目录 `VERSION` 文件，构建脚本自动同步到 package.json。

| 命令 | 产物 | 用途 |
|------|------|------|
| `npm run dist:debug` | `build/debug/GinyScreen-Debug-vX.Y.Z.exe` | **每次迭代必出**，供试用/报障 |
| `npm run dist:portable` | `build/GinyScreen-Portable-vX.Y.Z.exe` | 功能验证通过后发布 |
| `npm run dist:installer` | `build/GinyScreen-Setup-vX.Y.Z.exe` | 功能验证通过后发布 |
| `npm run finalize` | 复制 exe 到 `installer\` | 交付归档 |
| `npm run archive` | 归档到 `versions/vX.Y.Z/` | 版本归档（源码快照 + 产物） |
| `npm run icon` | 重新生成图标（含 PWA 图标） | 换肤时使用 |

```bash
npm install
npm run icon            # 生成 assets 图标 + client/assets PWA 图标
npm run dist:debug      # 构建 Debug 版 → build/debug/
```

> 构建需要 `resources/`（Radmin 安装包、gv-helper.exe、NAudio DLL）——
> 这些二进制**不入 git 仓库**，全新克隆后需从上一版本归档或本机拷贝 `resources/` 才能打包 exe。

分支模型：日常开发在 `develop`，`main` 只接受 `develop` 的合并（--no-ff），每个节点对应一个已发布版本。

---

## 📁 项目结构

```
GinyScreen/
├── server/                     # 信令服务器 + 网络能力层
│   ├── index.js                # CLI 入口（npm start）
│   ├── app.js                  # 可嵌入启动（HTTP/HTTPS + Socket.IO + API + 网络初始化）
│   ├── rooms.js                # 房间/成员/共享状态（内存态）
│   ├── signaling.js            # 信令 + 影院模式码流中继
│   ├── logger.js               # Debug 版日志（work/error 落盘）
│   └── net/                    # 网络能力层
│       ├── interfaces.js       # 本机地址枚举（局域网/IPv6/CGNAT 判定）
│       ├── gateway.js          # UPnP-IGD / NAT-PMP 自动端口映射（含租约续期）
│       ├── publicip.js         # STUN 公网地址探测 + NAT 类型（RFC 5780）
│       ├── turn.js             # 内置 STUN/TURN 中继（临时凭据/配额/多网卡适配）
│       ├── tls.js              # 自签名证书自动生成（覆盖本机全部地址）
│       └── doctor.js           # 网络诊断「连接医生」报告
├── client/                     # Web 客户端（原生 ES Modules，无构建步骤）
│   ├── index.html              # 界面骨架（进入页 / 房间 / 弹窗 / 移动端）
│   ├── css/style.css           # 深色影院主题 + 响应式
│   ├── sw.js / manifest.webmanifest / assets/  # PWA
│   └── js/
│       ├── main.js             # 应用编排
│       ├── core.js             # DOM/Toast/弹窗/存储/迷你图表
│       ├── api.js              # 服务器接口（config/ice/network/qr/health）
│       ├── signaling.js        # Socket.IO 封装
│       ├── capabilities.js     # 设备与编解码能力探测
│       ├── screenshare.js      # 采集 + 画质档位 + 发送端参数
│       ├── webrtc.js           # WebRTC 连接管理（含失败自动重建）
│       ├── cinema.js           # 影院模式（WebCodecs 编码/解码/批次协议）
│       ├── stats.js            # 质量采集 + 每观看者自适应码率
│       ├── stage.js            # 舞台渲染（瓦片/工具/全屏/画中画）
│       ├── ui.js / panels.js   # 界面骨架与面板（诊断/邀请/质量/源选择）
├── desktop/                    # Electron 桌面壳（内嵌服务器 + 托盘 + 自动更新）
├── scripts/                    # 构建/测试/图标/证书/归档脚本
├── docs/                       # 文档（网络架构 / 影院模式 / 联机 / 技术路线 / 调研）
├── source/                     # 需求文档
├── VERSION                     # 版本号唯一来源
└── update.json                 # 自动更新清单
```

---

## 🧪 测试

```bash
# 终端 1：启动服务器
npm start

# 终端 2：信令 + 影院模式 + HTTP 接口冒烟测试（26 项断言）
npm test
```

---

## 🧭 已知限制与路线图

- **规模**：mesh 适合 2~4 人共享/观看；更多人需 SFU（见 [docs/tech-alternatives.md](docs/tech-alternatives.md)）
- **手机**：可观看，不可采集屏幕（系统限制）
- **持久化**：房间/状态为内存态，服务器重启即清空
- **权限**：暂无房主权限体系（踢人、锁房间为路线图项）
- **影院模式**：需要浏览器支持 WebCodecs（Chromium 系浏览器 / 桌面版已内置；不可用时自动回退标准链路）

---

## 📚 文档

- [技术栈](TECHSTACK.md) · [网络架构与联机原理](docs/network-architecture.md) · [影院模式设计](docs/cinema-mode.md)
- [联机方案（含高级备选）](docs/fri-network.md) · [技术路线对比](docs/tech-alternatives.md) · [调研报告（存档）](docs/research-report.md)

## 📜 版本历史

| 版本 | 说明 |
|------|------|
| v2.0.0 | **完全重建**：零外置软件联机（内置中继 + UPnP + IPv6）；双链路共享（WebRTC 优化 + 影院模式）；质量面板 + 网络诊断；响应式 UI 与 PWA；移除内置语音 |
| v1.5.1 | Radmin 联机自动启动与指引优化（自动更新清单） |
| v1.4.0 | 内置语音（麦克风+说话指示+独立音量+AEC）、Radmin VPN 内嵌联机、全屏/画中画/画面比例、更新链路加固 |
| v1.3.0 | 取消房间号：单服务器单房间；首页直接填 IP:端口加入 |
| v1.0.0 | 全面重做 GinyScreen：移除语音通话，专注屏幕共享；影院式 UI |
| v0.x | 早期版本（GinyVoC 时代，语音频道 + 屏幕共享） |
