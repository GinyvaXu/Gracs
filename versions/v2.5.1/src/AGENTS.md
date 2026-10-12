# AGENTS.md — Gracs 项目规则与状态（v2.2.0）

## 项目简介
自托管的**屏幕共享**工具：房间 + 多人轮流共享 + 系统声音，一起看视频/电影/游戏画面。
- 浏览器版：Node.js + Express + Socket.IO 信令服务器，媒体走 WebRTC P2P（标准链路）或 WebCodecs 服务器中继（影院模式）
- 桌面版：Electron 壳（`desktop/main.js`）内嵌信令服务器，Windows 便携版/安装版 exe
- **联机零外置软件**：内置 STUN/TURN 中继 + UPnP/NAT-PMP 端口映射 + IPv6/局域网直连（Radmin 等仅作高级备选）
- **☁️ 云房间**（v2.2.0）：信令托管在 Cloudflare Workers + Durable Objects（独立仓库 `GinyvaXu/Project4`，
  域名 `gracs.ginyva.site`），房间码进出、免组网；同站还托管「云网页版」客户端（邀请链接/扫码即用）

## 目录结构
```
server/           信令服务器
  index.js        CLI 入口；app.js 可嵌入启动函数；rooms.js 状态；signaling.js 信令+影院中继；logger.js 日志
  net/            网络能力层：interfaces(地址枚举) / gateway(UPnP/NAT-PMP) / publicip(STUN/NAT类型)
                  / turn(内置中继) / tls(自签证书) / doctor(网络诊断)
client/           Web 客户端（原生 ES Modules，无构建步骤）
  index.html + css/style.css + js/*（main/core/api/signaling/cloud-signal/capabilities/screenshare/
  webrtc/cinema/stats/stage/ui/panels）+ vendor/(qrcode-generator) + sw.js + manifest.webmanifest + assets/(PWA 图标)
desktop/          Electron 桌面壳（main.js / preload.cjs / updater.js / helpers/gv-helper.cs）
assets/           应用图标（icon.png / icon.ico / tray.png，scripts/gen-icon.mjs 生成）
scripts/          构建/测试/导出/归档脚本（build-debug.mjs、smoke-test.mjs、gen-icon.mjs…）
docs/             网络架构 / 影院模式 / 联机方案(fri-network) / 技术路线 / 调研 / 差距分析
source/           需求文档
build/ installer/ release/ versions/ logs/ temp/   构建/交付/归档/日志/中间文件（均不入库，除 versions 源码快照）
update.json       自动更新清单（版本/下载地址/更新说明，随 git 推送）
```

## 常用命令
```bash
npm start               # 浏览器版：启动服务器（http://localhost:3000，自动开 HTTPS :3001）
npm run electron        # 桌面版开发运行
npm test                # 端到端冒烟测试（30 项断言，需先 npm start）
npm run icon            # 从 assets/design-*/ 设计素材同步图标（桌面/PWA/favicon；不再程序化绘制）
npm run helper          # 从源码编译 resources/gv-helper.exe（.NET Framework csc，需要 NAudio DLL 已就位）
npm run dist:debug      # 构建 Debug 版 exe（控制台+日志+DevTools，每次迭代必出）
npm run dist:portable   # 构建便携版 exe（构建前自动从 VERSION 同步版本号）
npm run dist:installer  # 构建安装版 exe
npm run finalize        # 复制 build\ 下的 exe 到 installer\
npm run archive         # 发布归档：产物/源码快照到 versions/vX.Y.Z/
```

## 云信令 / 云网页版（独立仓库 Project4）
```bash
# 目录：<Project7>\Project4（GitHub GinyvaXu/Project4；部署到 gracs.ginyva.site）
node scripts/sync-client.mjs "<本仓库>/client"   # 同步云网页版客户端到 Project4/public（部署前必跑）
npx wrangler deploy                              # 部署 Worker+静态资源（首次需 npx wrangler login）
RELAY=wss://gracs.ginyva.site node tests/protocol-test.mjs   # 线上协议测试（17 项）
```
- 客户端 `cloud-signal.js` 与 `signaling.js` 同接口；云房间暂不支持影院模式（码流中继依赖本机服务器）
- 云邀请链接 = `https://gracs.ginyva.site/?cloud=房间码`（可用 `?web=` 覆盖；桌面版 localhost 邀请必须走公网网页版）
- 云网页版检测：`/api/config` 返回 `cloud` 字段时，客户端进入页只保留「云房间」并隐藏本机网络诊断

## 版本与发布（遵循 project-git-mgmt）
- 分支模型：`main` 只接受来自 `develop` 的合并（--no-ff）；日常开发在 `develop`，不额外建 feature 分支
- 版本号单一来源：只改 `VERSION` 文件；构建脚本（sync-version.mjs）自动同步到 package.json，禁止手写
- 提交规范：`feat:` / `fix:` / `release:` / `build:` / `chore:` / `refactor:` / `docs:` / `test:`，一个 commit 只做一件事
- 发布流程：改 VERSION → 构建 Debug 版试用（`npm run dist:debug`）→ 功能验证后构建便携版/安装版 → `npm run archive` 归档
  → `release:` 提交源码、`build:` 提交归档 → 合并 main → 打 tag + 上传 installer 到 GitHub Releases → 更新 update.json → 清理旧二进制
- 变更记录写 CHANGELOG.md；版本管理规范见 VERSIONING.md
- **发布前检查**：update.json 的版本/下载地址必须与实际上传的 Release 资产一致（先传 exe，再更新清单）

## 架构要点（改代码前必读）
- **联机四条路径**：局域网 / IPv6 / UPnP 公网映射 / 内置 TURN 中继。新增联机能力时优先接入 `server/net/` 并在 `doctor.js` 中给出人话结论。
- **TURN 中继**：`server/net/turn.js`（`turn-server` 纯 JS）；凭据是 HMAC 临时凭据（`TURN_SECRET` 或 `temp/turn-secret.txt`，默认 4h 有效）。
  `relayCallback` 按分配来源选择通告地址（回环 → 127.0.0.1；否则公网 IP 或主局域网 IP）；`allowLoopback: true` 是有意为之（同机双开观看）。
- **WebRTC 连接模型**：每个对端两条单向连接（outPcs 我发送 / inPcs 我接收），避免 SDP 协商冲突；
  影院模式的系统声音单独走 `cinema-audio` 通道（仅音频）。
- **影院模式协议**：客户端 `client/js/cinema.js` 负责批次打包/解析（改协议必须同步 `readBatch`/`writeBatch` 的头部长度），
  服务端只做 `volatile` 转发 + 反馈/关键帧路由，不解析内容。
- **自适应码率**：`client/js/stats.js`（每位观看者独立 AIMD + 总上行预算），依赖 `availableOutgoingBitrate` 与丢包，改动需双端实测。
- **画质档位**：`client/js/screenshare.js` 的 `PRESETS`（自动/电影/游戏/文字/省流），是分辨率+帧率+码率上限+拥塞策略的唯一来源。
- **页面不可见时**：影院解码自动暂停并在恢复时请求关键帧（避免后台空转）；WebRTC 不需要类似处理。
- **Service Worker 必须网络优先**：否则「改了代码刷新还是旧版」（历史踩坑）。`/js`、`/css`、`/assets` 都走网络优先 + 缓存兜底。
- **无语音（有文字聊天）**：客户端媒体面只有屏幕画面 + 可选系统声音，**不要加回麦克风语音**（v1.4.0 语音因无法正常使用已于 v2.0.0 移除）；
  文字聊天（v2.3.0）是用户明确要求的轻量功能：`chat:send/chat:message`、最近记录随 `room:state.chat` 下发（本地服务器与云 DO 双实现）。
- **停止共享以服务器状态为准**（不要依赖 track mute，窗口最小化也会触发）；桌面版停止时恢复被静音的其它应用
- **系统声音三模式（v2.4.0）**：共享栏「音频源」= 整机声音（默认，优先 Chromium 原生回环，失败走 helper 兼容采集）/
  跟随共享窗口 / 指定应用。后两者走 **进程回环**（`gv-helper audio capture --pid N`，Win10 2004+/11；
  自备 PCM 格式 + AUTOCONVERTPCM，GetMixFormat 对进程回环不可用）——只采目标进程树的声音，
  **不会采集/静音语音软件**（避免朋友听到自己的回音）；helper 失败回退整机声音，再失败仅画面。
  回调需实现 IAgileObject（否则 E_ILLEGAL_METHOD_CALL）；`audio list` 为 UTF-8 输出。
- **云房间（v2.2.0）**：信令走 Cloudflare DO（`gracs.ginyva.site`），媒体仍 P2P；`client/js/cloud-signal.js` 与 `signaling.js` 同接口；
  云房间下影院模式自动回退标准链路；云网页版由 Project4 同站托管（邀请链接无需主机可被连接）
- **安全基线（v2.5.0）**：信令 Origin 校验（穿透域名需 `GRACS_ALLOWED_ORIGINS` 放行；`GRACS_ALLOW_ANY_ORIGIN=1` 关闭）；
  Electron 主窗口禁止导航第三方页面（外链走系统浏览器）；自动更新安装包下载域名白名单（updater.js）；用户名/聊天过滤控制字符 + 限速与长度上限。
- **二维码在客户端生成**（`client/vendor/qrcode-generator.mjs`）：`/api/qr.svg` 仅作回退，不再是必需接口。

## 注意事项
- 项目路径含 `&`：npm scripts 一律用 `node node_modules/electron-builder/cli.js` 直调 CLI，不要用 `.bin` 的 .cmd 垫片（cmd 会把路径按 `&` 截断）
- **构建依赖 `resources/`（不入库）可本地重建**：
  - `npm run helper` 用系统自带 csc.exe 从 `desktop/helpers/gv-helper.cs` 编译 `gv-helper.exe`；
    唯一的第三方依赖是 NAudio 的两个 DLL，从 NuGet 下载 `NAudio.Core` / `NAudio.Wasapi`（netstandard2.0）后
    放到 `resources/`（或 `%TEMP%\naudio\{core,wasapi}\lib\netstandard2.0\` 由脚本自动复制）
  - `resources/Radmin_VPN_2.0.4899.9.exe` 为可选（高级备选联机）；缺失时 `scripts/electron-builder.mjs`
    会自动从打包清单过滤并打印警告，不影响构建
- **打包走 `scripts/electron-builder.mjs`**（自动过滤缺失的可选资源 + 默认 npmmirror 镜像加速）；
  不要直接调用 `node_modules/electron-builder/cli.js`，否则缺资源会直接构建失败
- npm 默认拦截安装脚本时，electron 二进制可能缺失：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js` 补齐
- Electron 主进程：`session.defaultSession` 必须在 `app.whenReady()` 之后使用，否则启动会静默失败
- 日志：Debug 版双写 work-日期.log / error-日期.log，目录由 LOG_DIR 控制；桌面版写在 exe 旁 logs\
- 前端要求安全上下文才能采集屏幕：localhost 与桌面版天然满足；局域网其它电脑需用 HTTPS（自动生成的自签名证书，端口 = 端口+1）
- mesh 适合 2~4 人共享/观看；更大规模需 SFU（mediasoup/LiveKit，见 docs/tech-alternatives.md）
- **图标**：以 `assets/design-*/` 设计素材为唯一来源（交接单见 docs/图标交接-*.md）；换图标 = 放入新素材目录 → `npm run icon`（同步桌面/PWA/favicon，禁止改回程序化绘制）
- **包名**：构建产物一律英文命名（Gracs-Debug/Portable/Setup-vX.Y.Z.exe）；目录不含中文

## 当前状态
- 版本：v2.5.0（**安全加固 + 启动动画与全流程体验优化**）
  - v2.5.0：启动加载动画（桌面品牌启动画面 + 页内动画，见 `#boot-loader` / `createSplash`）；
    屏间过渡/弹窗弹出/按钮手感/聚焦光晕等交互细节（适配 prefers-reduced-motion）；
    安全整改：信令 Origin 校验、Electron 导航防护、更新下载白名单、用户名控制字符过滤
  - v2.4.1：系统声音失败提示按共享来源区分（窗口/整屏/桌面版）
  - v2.4.0：音频源可选「整机声音 / 跟随共享窗口 / 指定应用」——按应用采声（Windows 进程回环）只采该应用声音，
    语音软件不被采集也不被静音（解决"朋友听到自己"的回音）；失败自动回退整机/仅画面；共享状态栏显示音频源
  - v2.3.0：房间文字聊天（页面「成员 / 聊天」页签、未读徽标、历史下发；本地与云双端）；
    系统声音「兼容模式」采集（Chromium 回环失败的机器改走 helper/NAudio 采集）；
    全屏/画中画交互完善（右上角退出按钮、底部按钮状态开关、PiP 状态同步）
  - v2.2.0：云房间连接模式（Project4 云信令：Cloudflare Workers + Durable Objects，`gracs.ginyva.site`，
    房间码进出、免组网）+ **云网页版同站托管**（`https://gracs.ginyva.site/?cloud=房间码`，邀请/扫码即用，手机可直接加入）；
    云房间暂不支持影院模式（自动回退标准链路）；二维码改客户端本地生成；Socket.IO 按需加载
  - v2.1.1：全屏三级兜底 + 手机端适配 + IPv6 中继双栈与诊断
  - v2.1.0：**更名 Gracs / GRACS / 格瑞克斯**（原名 GinyScreen；产物名与 appId 变更，迁移说明见 CHANGELOG）
  - v2.0.1：修复全屏/画中画/音量按钮失效；系统声音采集改稳 + 质量面板显示声音状态
  - v2.0.0（完全重建）：零外置软件联机（内置 STUN/TURN + UPnP/NAT-PMP + IPv6/局域网直连 + 网络诊断）；
    双链路共享（标准 WebRTC 优化 / 影院模式 WebCodecs 中继）；质量面板；响应式 UI + PWA + 二维码邀请；移除内置麦克风语音。
- 品牌：Gracs = Ginyva Remote Access Cross-network Screen-sharing Solution；缩写 GRACS；读音 /ɡræks/；中文「格瑞克斯」
- 分支：main（稳定，v1.5.1）/ develop（v2.x 开发）
- 远程：https://github.com/GinyvaXu/Gracs（公开；更名前为 GinyvaXu/GinyScreen，updater 同时保留旧仓库兜底源）
- 云信令：https://github.com/GinyvaXu/Project4（Cloudflare Workers，部署 `gracs.ginyva.site`；本地副本在 `<Project7>\Project4`）
- 自动更新：桌面安装版内置 updater.js（多源清单 + NSIS 静默升级），清单为根目录 update.json
- 待办与路线图见 source/requirements.md 与 docs/gap-analysis.md
- 高级备选联机方案（Radmin VPN / 蒲公英 / SakuraFrp）教程见 docs/fri-network.md
